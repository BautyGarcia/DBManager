import { userError } from './exit.js';

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createRoleSql(appRole: string, scramVerifier: string): string {
  return `CREATE ROLE ${quoteIdent(appRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${quoteLiteral(scramVerifier)};`;
}

export function createDatabaseSql(database: string, owner: string): string {
  return `CREATE DATABASE ${quoteIdent(database)} OWNER ${quoteIdent(owner)};`;
}

export function grantReplicaRoleSql(appRole: string): string {
  return `GRANT SET ON PARAMETER session_replication_role TO ${quoteIdent(appRole)};`;
}

const EXTENSION_RE = /^[a-z_][a-z0-9_-]*$/;

export function validateExtensions(exts: string[]): string[] {
  for (const e of exts) {
    if (!EXTENSION_RE.test(e))
      throw userError(`invalid extension name ${JSON.stringify(e)}`, 'extensions');
  }
  return exts;
}

export function extensionsSql(exts: string[]): string {
  return validateExtensions(exts)
    .map((e) => `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(e)};\n`)
    .join('');
}

/** ALTER SYSTEM tuning for a container with `memoryBytes` limit. shared_buffers needs a restart. */
export function tuningSql(memoryBytes: number): string {
  const mib = 1024 ** 2;
  const sharedBuffers = Math.floor(memoryBytes / 4 / mib);
  const effectiveCache = Math.floor((memoryBytes * 3) / 4 / mib);
  const settings: Array<[string, string]> = [
    ['max_connections', '50'],
    ['shared_buffers', `${sharedBuffers}MB`],
    ['effective_cache_size', `${effectiveCache}MB`],
    ['work_mem', '4MB'],
    ['maintenance_work_mem', '64MB'],
    ['random_page_cost', '1.1'],
    ['huge_pages', 'off'],
  ];
  return settings.map(([k, v]) => `ALTER SYSTEM SET ${k} = ${quoteLiteral(v)};\n`).join('');
}
