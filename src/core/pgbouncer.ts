import type { Project } from './state.js';

export const PGBOUNCER_INI_PATH = '/etc/pgbouncer/pgbouncer.ini';
export const PGBOUNCER_USERLIST_PATH = '/etc/pgbouncer/userlist.txt';

export interface PgbouncerRenderOptions {
  /** Directory inside the container holding certificate.crt and privatekey.key */
  certDir: string;
}

function sorted(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => a.slug.localeCompare(b.slug));
}

export function renderPgbouncerIni(projects: Project[], opts: PgbouncerRenderOptions): string {
  const dbLines: string[] = [];
  for (const p of sorted(projects)) {
    const base = `host=${p.dokploy.appName} port=5432 dbname=${p.postgres.database}`;
    dbLines.push(`${p.slug} = ${base}`);
    dbLines.push(`${p.slug}_session = ${base} pool_mode=session pool_size=3 reserve_pool_size=0`);
  }
  return [
    '[databases]',
    ...dbLines,
    '',
    '[pgbouncer]',
    'listen_addr = 0.0.0.0',
    'listen_port = 6432',
    'unix_socket_dir =',
    'pool_mode = transaction',
    'max_client_conn = 1000',
    'default_pool_size = 10',
    'min_pool_size = 0',
    'reserve_pool_size = 5',
    'reserve_pool_timeout = 3',
    'server_idle_timeout = 300',
    'server_lifetime = 3600',
    'pool_idle_timeout = 3600',
    'client_idle_timeout = 0',
    'query_wait_timeout = 30',
    'client_login_timeout = 15',
    'max_prepared_statements = 200',
    'ignore_startup_parameters = extra_float_digits',
    'auth_type = scram-sha-256',
    `auth_file = ${PGBOUNCER_USERLIST_PATH}`,
    'client_tls_sslmode = require',
    `client_tls_cert_file = ${opts.certDir}/certificate.crt`,
    `client_tls_key_file = ${opts.certDir}/privatekey.key`,
    'client_tls_protocols = tlsv1.2,tlsv1.3',
    'server_tls_sslmode = disable',
    'so_reuseport = 1',
    'tcp_keepalive = 1',
    'log_connections = 1',
    'log_disconnections = 1',
    'log_pooler_errors = 1',
    'stats_period = 60',
    '',
  ].join('\n');
}

export function renderUserlist(projects: Project[]): string {
  return sorted(projects)
    .map((p) => `"${p.postgres.appRole}" "${p.postgres.appScramVerifier}"\n`)
    .join('');
}
