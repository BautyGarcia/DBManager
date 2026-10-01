import type { Config } from './config.js';
import type { Project } from './state.js';

function dbUrl(p: Project, cfg: Config, dbname: string): string {
  const user = encodeURIComponent(p.postgres.appRole);
  const pw = encodeURIComponent(p.postgres.appPassword);
  return `postgresql://${user}:${pw}@${cfg.dbHost}:${cfg.remote.dbPort}/${dbname}?sslmode=verify-full`;
}

/** Everything a Next.js project needs. Never includes the superuser password. */
export function projectEnv(p: Project, cfg: Config): Record<string, string> {
  const env: Record<string, string> = {
    DATABASE_URL: dbUrl(p, cfg, p.slug),
    DATABASE_URL_SESSION: dbUrl(p, cfg, `${p.slug}_session`),
  };
  if (p.storage) {
    env.S3_ENDPOINT = `https://${cfg.s3Host}`;
    env.S3_REGION = 'garage';
    env.S3_BUCKET = p.storage.bucket;
    env.S3_ACCESS_KEY_ID = p.storage.keyId;
    env.S3_SECRET_ACCESS_KEY = p.storage.keySecret;
    if (p.storage.publicBaseUrl) env.S3_PUBLIC_BASE_URL = p.storage.publicBaseUrl;
  }
  env.BETTER_AUTH_SECRET = p.betterAuthSecret;
  env.BETTER_AUTH_URL = '';
  if (cfg.tls === 'self-ca' && cfg.sslCaPem)
    env.DATABASE_SSL_CA = cfg.sslCaPem.replaceAll('\n', '\\n');
  return env;
}

export function formatEnvBlock(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}\n`)
    .join('');
}
