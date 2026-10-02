import { quote } from 'shlex';
import { IMAGES } from '../core/compose.js';
import { userError } from '../core/exit.js';
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

export function importScript(o: { src: string; dst: string; schemas: string[] }): string {
  checkSchemas(o.schemas);
  const schemaFlags = o.schemas.map((s) => quote(`--schema=${s}`)).join(' ');
  return `set -u
SRC='${o.src.replaceAll("'", "'\\''")}'
DST='${o.dst.replaceAll("'", "'\\''")}'
pg_dump "$SRC" --schema-only --no-owner --no-privileges --no-comments --no-publications --no-subscriptions ${schemaFlags} -f /tmp/schema.sql
pg_dump "$SRC" --data-only --no-owner --no-privileges ${schemaFlags} -f /tmp/data.sql
echo '---SCHEMA-ERRORS---'
psql "$DST" -v ON_ERROR_STOP=0 -q -f /tmp/schema.sql 2>&1 >/dev/null | grep -E 'ERROR|FATAL' || true
echo '---DATA-ERRORS---'
psql "$DST" -v ON_ERROR_STOP=0 -q -c 'SET session_replication_role = replica' -f /tmp/data.sql 2>&1 >/dev/null | grep -E 'ERROR|FATAL' || true
echo '---END---'
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
  const dst = `postgresql://${encodeURIComponent(p.postgres.appRole)}:${encodeURIComponent(p.postgres.appPassword)}@${p.dokploy.appName}:5432/${p.postgres.database}`;

  deps.io.err(
    `dumping ${schemas.join(', ')} from source and restoring into ${o.slug} (this can take a while)...\n`,
  );
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
  const out = r.stdout;
  const schemaErr = out.split('---SCHEMA-ERRORS---')[1]?.split('---DATA-ERRORS---')[0] ?? '';
  const dataErr = out.split('---DATA-ERRORS---')[1]?.split('---END---')[0] ?? '';
  const errors = classifyErrors(`${schemaErr}\n${dataErr}`);

  let storageSynced = false;
  if (o.storage && p.storage) {
    deps.io.err(`syncing storage bucket ${o.storage.bucket} -> ${p.storage.bucket}...\n`);
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
        'sync',
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
    `import into ${r.slug}: schemas ${r.schemas.join(', ')}${r.storageSynced ? ', storage synced' : ''}`,
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
