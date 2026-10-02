import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLocalRunner } from '../../src/adapters/ssh.js';
import { type Config, ConfigSchema } from '../../src/core/config.js';

export const COMPOSE_DIR = join(process.cwd(), 'test', 'compose');
export const CERT_DIR = join(COMPOSE_DIR, 'certs', 'db.test.local');

export const testConfig: Config = ConfigSchema.parse({
  sshHost: 'localhost',
  dokployUrl: 'https://dokploy.test',
  dokployApiKey: 'tok',
  dokployProjectId: 'proj_1',
  dokployEnvironmentId: 'env_1',
  domain: 'test.local',
  dbHost: 'localhost',
  s3Host: 'localhost:53900',
  webDomain: 'web.test.local',
  garageAdminToken: 'testadmintoken',
  garageBackupKeyId: 'GKbackup',
  dumpsDestinationId: 'd1',
  tls: 'self-ca',
  remote: {
    pgbouncerConfDir: '/etc/dokploy/dbm/pgbouncer',
    certsDir: '/etc/dokploy/dbm/certs',
    garageConfDir: '/etc/dokploy/dbm/garage',
    rcloneConfDir: '/etc/dokploy/dbm/rclone',
    traefikDynamicDir: '/etc/dokploy/traefik/dynamic',
    dockerNetwork: 'dbmtest',
    pgbouncerContainer: 'dbm-test-pgbouncer',
    garageContainer: 'dbm-test-garage',
    garageAdminPort: 53903,
    dbPort: 56432,
  },
});

/** Maps the spec's remote paths onto test/compose so the real upload code writes where compose mounts. */
export function mapTestPath(remote: string): string {
  return remote
    .replace(/^\/etc\/dokploy\/dbm\//, `${COMPOSE_DIR}/`)
    .replace(/^\/etc\/dokploy\/traefik\/dynamic\//, `${COMPOSE_DIR}/traefik/`);
}

export const testRunner = makeLocalRunner({ mapPath: mapTestPath });

export function caPem(): string {
  return readFileSync(join(CERT_DIR, 'certificate.crt'), 'utf8');
}
