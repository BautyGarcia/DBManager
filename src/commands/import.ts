import { quote } from 'shlex';
import { IMAGES } from '../core/compose.js';
import { DbmError, remoteError, userError } from '../core/exit.js';
import { getProject } from '../core/state.js';
import type { Deps } from './context.js';

export interface ImportOptions {
  slug: string;
  from: string;
  schemas?: string[];
  storage?: {
    endpoint: string;
    region: string;
    keyId: string;
    keySecret: string;
    bucket: string;
  };
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
  const protectedCase = PROTECTED_TABLES.map((t) => `public.${t}`).join('|');
  const schemaPhase = o.dataOnly
    ? ''
    : `pg_dump "$SRC" --schema-only --no-owner --no-privileges --no-comments --no-publications --no-subscriptions ${schemaFlags} -f /tmp/schema.sql || { echo '---DUMP-FAILED---'; exit 1; }
echo '---SCHEMA-ERRORS---'
psql "$DST" -v ON_ERROR_STOP=0 -q -f /tmp/schema.sql 2>&1 >/dev/null | grep -E 'ERROR|FATAL' || true
echo '---POLICIES---'
grep -E '^CREATE POLICY' /tmp/schema.sql | sed -E 's/^CREATE POLICY ("?[^" ]+"?) ON ([^ ]+).*/\\2: \\1/' || true
`;
  const replacePhase = o.replace
    ? `echo '---REPLACE---'
for t in $TABLES; do
  case "$t" in ${protectedCase}) continue;; esac
  if psql "$DST" -Atc "select to_regclass('$t') is not null" | grep -q t; then
    psql "$DST" -qc "TRUNCATE TABLE $t RESTART IDENTITY CASCADE" 2>&1 | grep -E 'ERROR' || true
  fi
done
`
    : '';
  return `set -u
SRC='${o.src.replaceAll("'", "'\\''")}'
DST='${o.dst.replaceAll("'", "'\\''")}'
TABLES=$(psql "$SRC" -Atc "select format('%I.%I', schemaname, tablename) from pg_tables where schemaname in (${schemaIn}) order by 1") || { echo '---DUMP-FAILED---'; exit 1; }
${schemaPhase}pg_dump "$SRC" --data-only --no-owner --no-privileges ${schemaFlags} -f /tmp/data.sql || { echo '---DUMP-FAILED---'; exit 1; }
${replacePhase}echo '---DATA-ERRORS---'
psql "$DST" -v ON_ERROR_STOP=0 -q -c 'SET session_replication_role = replica' -f /tmp/data.sql 2>&1 >/dev/null | grep -E 'ERROR|FATAL' || true
echo '---COUNTS---'
for t in $TABLES; do
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
      { input: importScript({ src: o.from, dst, schemas }), timeoutMs: 60 * 60_000 },
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

  let storageSynced = false;
  if (o.storage && p.storage) {
    // `copy`, never `sync`: an import must not delete objects already in the target bucket.
    deps.io.err(`copying storage bucket ${o.storage.bucket} -> ${p.storage.bucket}...\n`);
    const conf = `[src]\ntype = s3\nprovider = Other\nenv_auth = false\naccess_key_id = ${o.storage.keyId}\nsecret_access_key = ${o.storage.keySecret}\nendpoint = ${o.storage.endpoint}\nregion = ${o.storage.region}\nforce_path_style = true\n\n[dst]\ntype = s3\nprovider = Other\nenv_auth = false\naccess_key_id = ${p.storage.keyId}\nsecret_access_key = ${p.storage.keySecret}\nendpoint = http://${deps.cfg.remote.garageContainer}:3900\nregion = garage\nforce_path_style = true\nno_check_bucket = true\n`;
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
        `src:${o.storage.bucket}`,
        `dst:${p.storage.bucket}`,
        '--size-only',
        '--transfers',
        '4',
      ],
      { input: conf, timeoutMs: 6 * 60 * 60_000 },
    );
    storageSynced = true;
  }
  return { slug: o.slug, schemas, errors, storageSynced };
}

export function formatReport(r: ImportReport): string {
  const sec = (title: string, lines: string[], hint: string) =>
    lines.length
      ? `\n${title} (${lines.length})\n  hint: ${hint}\n${lines.map((l) => `  ${l}`).join('\n')}\n`
      : '';
  return [
    `import into ${r.slug}: schemas ${r.schemas.join(', ')}${r.storageSynced ? ', storage copied' : ''}`,
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
  ].join('');
}
