import { chmod, writeFile } from 'node:fs/promises';
import { quote } from 'shlex';
import { IMAGES } from '../core/compose.js';
import { DbmError, remoteError, userError } from '../core/exit.js';
import { getProject } from '../core/state.js';
import type { Deps } from './context.js';
import { requireConfirmation } from './destroy.js';

export interface ImportOptions {
  slug: string;
  from: string;
  schemas?: string[];
  storage?: {
    endpoint: string;
    region: string;
    keyId: string;
    keySecret: string;
    /** Source buckets; each is copied under its own `<bucket>/` prefix in the project's bucket. */
    buckets: string[];
  };
  dataOnly?: boolean;
  replace?: boolean;
  usersOut?: string;
  yes?: boolean;
  confirmSlug?: string;
}

export interface ImportReport {
  slug: string;
  schemas: string[];
  errors: {
    authUsers: string[];
    authUid: string[];
    storageObjects: string[];
    extensions: string[];
    other: string[];
  };
  storageSynced: boolean;
  /** Source buckets copied, in order; each lives under `<bucket>/` in the project's bucket. */
  storageBuckets: string[];
  counts: ImportCount[];
  rlsPolicies: string[];
  usersExported: number | null;
  usersOut?: string;
  mismatched: string[];
  dataOnly?: boolean;
}

export function classifyErrors(stderr: string): ImportReport['errors'] {
  const e: ImportReport['errors'] = {
    authUsers: [],
    authUid: [],
    storageObjects: [],
    extensions: [],
    other: [],
  };
  for (const raw of stderr.split('\n')) {
    const line = raw.trim();
    if (!line || !/ERROR/.test(line)) continue;
    if (/auth\.users/.test(line)) e.authUsers.push(line);
    else if (/auth\.(uid|jwt|role)\(\)/.test(line)) e.authUid.push(line);
    else if (/storage\.(objects|buckets)/.test(line)) e.storageObjects.push(line);
    else if (/schema "extensions"|extensions\./.test(line)) e.extensions.push(line);
    else e.other.push(line);
  }
  return e;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
/** Supabase bucket names that are safe as an rclone path segment and an S3 key prefix. */
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

function checkSchemas(schemas: string[]): void {
  for (const s of schemas) {
    if (!SCHEMA_RE.test(s)) throw userError(`invalid schema name "${s}"`, 'import');
  }
}

export const PROTECTED_TABLES = [
  'user',
  'session',
  'account',
  'verification',
  'rateLimit',
  '__drizzle_migrations',
] as const;

export interface ImportScriptOptions {
  src: string;
  dst: string;
  schemas: string[];
  dataOnly?: boolean;
  replace?: boolean;
}

export function importScript(o: ImportScriptOptions): string {
  checkSchemas(o.schemas);
  const schemaFlags = o.schemas.map((s) => quote(`--schema=${s}`)).join(' ');
  const schemaIn = o.schemas.map((s) => `'${s}'`).join(','); // names validated by SCHEMA_RE
  const protectedIn = PROTECTED_TABLES.map((t) => `'${t}'`).join(','); // constants
  const schemaPhase = o.dataOnly
    ? ''
    : `pg_dump "$SRC" --schema-only --no-owner --no-privileges --no-comments --no-publications --no-subscriptions ${schemaFlags} -f /tmp/schema.sql || { echo '---DUMP-FAILED---' >&2; echo '---DUMP-FAILED---'; exit 1; }
echo '---SCHEMA-ERRORS---'
psql "$DST" -v ON_ERROR_STOP=0 -q -f /tmp/schema.sql 2>&1 >/dev/null | grep -E 'ERROR|FATAL' || true
echo '---POLICIES---'
grep -E '^CREATE POLICY' /tmp/schema.sql | sed -E 's/^CREATE POLICY ("?[^" ]+"?) ON ([^ ]+).*/\\2: \\1/' || true
`;
  // Replace set = tables in the source AND the target, minus protected names in every schema.
  // The source list is built as quote_literal row values (%L), so no table name is ever
  // interpolated unescaped; target-only tables are never truncated. One TRUNCATE without
  // CASCADE: if a protected table references an imported one, Postgres refuses the whole
  // statement and we abort before any data is loaded.
  const replacePhase = o.replace
    ? `echo '---REPLACE---'
SRC_ROWS=$(psql "$SRC" -Atc "select string_agg(format('(%L,%L)', schemaname, tablename), ',') from pg_tables where schemaname in (${schemaIn}) and tablename not in (${protectedIn})") || { echo '---REPLACE-FAILED---' >&2; echo '---REPLACE-FAILED---'; exit 1; }
if [ -n "$SRC_ROWS" ]; then
  REPLACE_TABLES=$(psql "$DST" -Atc "select string_agg(format('%I.%I', schemaname, tablename), ', ' order by schemaname, tablename) from pg_tables where (schemaname, tablename) in (values $SRC_ROWS) and tablename not in (${protectedIn})") || { echo '---REPLACE-FAILED---' >&2; echo '---REPLACE-FAILED---'; exit 1; }
  if [ -n "$REPLACE_TABLES" ]; then
    TRUNC_ERR=$(psql "$DST" -v ON_ERROR_STOP=1 -qc "TRUNCATE TABLE $REPLACE_TABLES RESTART IDENTITY" 2>&1) || { echo '---REPLACE-FAILED---' >&2; echo "$TRUNC_ERR" >&2; echo '---REPLACE-FAILED---'; echo "$TRUNC_ERR"; exit 1; }
  fi
fi
`
    : '';
  return `set -u
SRC='${o.src.replaceAll("'", "'\\''")}'
DST='${o.dst.replaceAll("'", "'\\''")}'
TABLES=$(psql "$SRC" -Atc "select format('%I.%I', schemaname, tablename) from pg_tables where schemaname in (${schemaIn}) order by 1") || { echo '---DUMP-FAILED---' >&2; echo '---DUMP-FAILED---'; exit 1; }
${schemaPhase}pg_dump "$SRC" --data-only --no-owner --no-privileges ${schemaFlags} -f /tmp/data.sql || { echo '---DUMP-FAILED---' >&2; echo '---DUMP-FAILED---'; exit 1; }
${replacePhase}echo '---DATA-ERRORS---'
psql "$DST" -v ON_ERROR_STOP=0 -q -c 'SET session_replication_role = replica' -f /tmp/data.sql 2>&1 >/dev/null | grep -E 'ERROR|FATAL' || true
echo '---COUNTS---'
printf '%s\\n' "$TABLES" | while IFS= read -r t; do
  [ -n "$t" ] || continue
  s=$(psql "$SRC" -Atc "select count(*) from $t" 2>/dev/null || echo '-')
  d=$(psql "$DST" -Atc "select count(*) from $t" 2>/dev/null || echo '-')
  printf '%s\\t%s\\t%s\\n' "$t" "$s" "$d"
done
echo '---END---'
`;
}

export interface ImportCount {
  table: string;
  source: number;
  target: number | null;
}

function section(out: string, start: string, ends: string[]): string {
  const i = out.indexOf(start);
  if (i < 0) return '';
  let rest = out.slice(i + start.length);
  for (const e of ends) {
    const j = rest.indexOf(e);
    if (j >= 0) rest = rest.slice(0, j);
  }
  return rest;
}

export function parseImportOutput(out: string): {
  schemaErr: string;
  dataErr: string;
  counts: ImportCount[];
  policies: string[];
} {
  const markers = [
    '---POLICIES---',
    '---REPLACE---',
    '---DATA-ERRORS---',
    '---COUNTS---',
    '---END---',
  ];
  const schemaErr = section(out, '---SCHEMA-ERRORS---', markers);
  const policies = section(out, '---POLICIES---', markers.slice(1))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const dataErr = section(out, '---DATA-ERRORS---', ['---COUNTS---', '---END---']);
  const counts: ImportCount[] = section(out, '---COUNTS---', ['---END---'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [table = '', s = '-', d = '-'] = l.split('\t');
      return { table, source: Number(s) || 0, target: d === '-' ? null : Number(d) };
    });
  return { schemaErr, dataErr, counts, policies };
}

export function usersExportScript(src: string): string {
  return `set -u
SRC='${src.replaceAll("'", "'\\''")}'
psql "$SRC" -v ON_ERROR_STOP=1 -Atc "COPY (
  SELECT id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, raw_app_meta_data,
         created_at, updated_at, last_sign_in_at
  FROM auth.users WHERE email IS NOT NULL AND deleted_at IS NULL
) TO STDOUT WITH (FORMAT csv, HEADER)"
`;
}

export async function importCommand(deps: Deps, o: ImportOptions): Promise<ImportReport> {
  const p = getProject(await deps.store.loadState(), o.slug);
  if (/:6543(\/|$)/.test(o.from))
    throw userError(
      'use the direct connection or the session pooler (port 5432), never the transaction pooler (6543), for pg_dump',
      'import',
    );
  if (p.status !== 'running')
    throw userError(`${o.slug} is ${p.status}; resume it first`, 'import');
  const schemas = o.schemas?.length ? o.schemas : ['public'];
  checkSchemas(schemas);
  if (o.storage && !/^https?:\/\//.test(o.storage.endpoint))
    throw userError('storage endpoint must start with https:// or http://', 'import.storage');
  if (o.storage && !p.storage)
    throw userError(
      `${o.slug} has no storage bucket (created with --no-storage)`,
      'import.storage',
    );
  if (o.storage) {
    if (o.storage.buckets.length === 0)
      throw userError(
        'at least one --storage-bucket is required with storage flags',
        'import.storage',
      );
    for (const b of o.storage.buckets)
      if (!BUCKET_RE.test(b))
        throw userError(
          `invalid bucket name "${b}" (letters, digits, . _ - only; must start with a letter or digit)`,
          'import.storage',
        );
  }
  if (o.replace)
    await requireConfirmation(
      deps,
      {
        slug: o.slug,
        yes: o.yes ?? false,
        ...(o.confirmSlug ? { confirmSlug: o.confirmSlug } : {}),
      },
      'truncate the imported tables of',
    );
  const dst = `postgresql://${encodeURIComponent(p.postgres.appRole)}:${encodeURIComponent(p.postgres.appPassword)}@${p.dokploy.appName}:5432/${p.postgres.database}`;

  deps.io.err(
    `dumping ${schemas.join(', ')} from source and restoring into ${o.slug} (this can take a while)...\n`,
  );
  let out: string;
  try {
    const r = await deps.ssh.run(
      [
        'docker',
        'run',
        '--rm',
        '-i',
        '--network',
        deps.cfg.remote.dockerNetwork,
        IMAGES.postgres18,
        'bash',
        '-s',
      ],
      {
        input: importScript({
          src: o.from,
          dst,
          schemas,
          ...(o.dataOnly ? { dataOnly: true } : {}),
          ...(o.replace ? { replace: true } : {}),
        }),
        timeoutMs: 60 * 60_000,
      },
    );
    out = r.stdout;
  } catch (e) {
    if (e instanceof DbmError)
      throw new DbmError(`pg_dump/psql failed: ${e.message}`, e.exitCode, e.step);
    throw e;
  }
  if (!out.includes('---END---'))
    throw remoteError(
      `import script did not complete (no END marker); output: ${out.slice(0, 500)}`,
      'import.dump',
    );
  const parsed = parseImportOutput(out);
  const errors = classifyErrors(`${parsed.schemaErr}\n${parsed.dataErr}`);
  const mismatched = parsed.counts
    .filter((c) => c.target === null || c.target !== c.source)
    .map((c) => c.table);

  let storageSynced = false;
  const storageBuckets: string[] = [];
  if (o.storage && p.storage) {
    const conf = `[src]\ntype = s3\nprovider = Other\nenv_auth = false\naccess_key_id = ${o.storage.keyId}\nsecret_access_key = ${o.storage.keySecret}\nendpoint = ${o.storage.endpoint}\nregion = ${o.storage.region}\nforce_path_style = true\n\n[dst]\ntype = s3\nprovider = Other\nenv_auth = false\naccess_key_id = ${p.storage.keyId}\nsecret_access_key = ${p.storage.keySecret}\nendpoint = http://${deps.cfg.remote.garageContainer}:3900\nregion = garage\nforce_path_style = true\nno_check_bucket = true\n`;
    for (const bucket of o.storage.buckets) {
      // `copy`, never `sync`: an import must not delete objects already in the target bucket.
      // Each source bucket lands under its own prefix, so `from('<bucket>')` + key -> `<bucket>/<key>`.
      deps.io.err(`copying storage bucket ${bucket} -> ${p.storage.bucket}/${bucket}/...\n`);
      await deps.ssh.run(
        [
          'docker',
          'run',
          '--rm',
          '-i',
          '--network',
          deps.cfg.remote.dockerNetwork,
          IMAGES.rclone,
          '--config',
          '/dev/stdin',
          'copy',
          `src:${bucket}`,
          `dst:${p.storage.bucket}/${bucket}`,
          '--size-only',
          '--transfers',
          '4',
        ],
        { input: conf, timeoutMs: 6 * 60 * 60_000 },
      );
      storageBuckets.push(bucket);
    }
    storageSynced = true;
  }

  let usersExported: number | null = null;
  if (o.usersOut) {
    deps.io.err('exporting auth.users...\n');
    let csv: string;
    try {
      csv = (
        await deps.ssh.run(
          [
            'docker',
            'run',
            '--rm',
            '-i',
            '--network',
            deps.cfg.remote.dockerNetwork,
            IMAGES.postgres18,
            'bash',
            '-s',
          ],
          { input: usersExportScript(o.from), timeoutMs: 30 * 60_000 },
        )
      ).stdout;
    } catch (e) {
      throw remoteError(
        `could not export auth.users (is this a Supabase source?): ${e instanceof Error ? e.message : String(e)}`,
        'import.users',
      );
    }
    await writeFile(o.usersOut, csv.endsWith('\n') ? csv : `${csv}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(o.usersOut, 0o600);
    usersExported = Math.max(0, csv.trim().split('\n').length - 1);
  }
  return {
    slug: o.slug,
    schemas,
    errors,
    storageSynced,
    storageBuckets,
    counts: parsed.counts,
    rlsPolicies: parsed.policies,
    usersExported,
    ...(o.usersOut ? { usersOut: o.usersOut } : {}),
    mismatched,
    ...(o.dataOnly ? { dataOnly: true } : {}),
  };
}

function countsBlock(r: ImportReport): string {
  const bad = new Set(r.mismatched);
  const rows = r.counts.map(
    (c) =>
      `  ${c.table}  ${c.source}  ${c.target === null ? '-' : c.target}${bad.has(c.table) ? ' MISMATCH' : ''}`,
  );
  let out = '';
  if (rows.length) out += `\ntable  source  target\n${rows.join('\n')}\n`;
  if (r.rlsPolicies.length || !r.dataOnly)
    out += `\nRLS policies to re-implement in server code (${r.rlsPolicies.length})\n${r.rlsPolicies.map((p) => `  ${p}\n`).join('')}`;
  if (r.usersExported !== null) out += `\nusers exported: ${r.usersExported} -> ${r.usersOut}\n`;
  if (r.mismatched.length) out += `\nCOUNT MISMATCH in: ${r.mismatched.join(', ')}\n`;
  return out;
}

export function formatReport(r: ImportReport): string {
  const sec = (title: string, lines: string[], hint: string) =>
    lines.length
      ? `\n${title} (${lines.length})\n  hint: ${hint}\n${lines.map((l) => `  ${l}`).join('\n')}\n`
      : '';
  return [
    `import into ${r.slug}: schemas ${r.schemas.join(', ')}${r.storageSynced ? `, storage copied: ${r.storageBuckets.join(', ')}` : ''}`,
    sec(
      'Foreign keys / references to auth.users',
      r.errors.authUsers,
      'point them at better-auth\'s "user"(id) instead; see docs/migration-from-supabase.md#users',
    ),
    sec(
      'auth.uid() and friends',
      r.errors.authUid,
      'drop RLS policies and defaults; authorization moves to server code',
    ),
    sec(
      'storage.objects / storage.buckets',
      r.errors.storageObjects,
      'replace with S3 keys in your own table; files are in your Garage bucket',
    ),
    sec(
      'extensions schema',
      r.errors.extensions,
      'use gen_random_uuid() (pgcrypto is installed) or add --extensions',
    ),
    sec('Other errors', r.errors.other, 'review individually'),
    r.errors.authUsers.length +
      r.errors.authUid.length +
      r.errors.storageObjects.length +
      r.errors.extensions.length +
      r.errors.other.length ===
    0
      ? '\nno errors\n'
      : '',
    countsBlock(r),
  ].join('');
}
