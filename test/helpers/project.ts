import type { Project } from '../../src/core/state.js';

export function fakeProject(slug = 'my-app', over: Partial<Project> = {}): Project {
  return {
    slug,
    createdAt: '2026-09-30T00:00:00.000Z',
    status: 'running',
    pgMajor: 18,
    dokploy: { postgresId: 'pg_1', appName: `pg-${slug}-abc123`, backupId: 'bk_1' },
    postgres: {
      database: slug.replaceAll('-', '_'),
      appRole: `${slug.replaceAll('-', '_')}_app`,
      appPassword: 'apppw',
      appScramVerifier: 'SCRAM-SHA-256$4096:c2FsdA==$a2V5:a2V5',
      adminRole: `${slug.replaceAll('-', '_')}_admin`,
      adminPassword: 'adminpw',
      extensions: ['pgcrypto', 'uuid-ossp'],
      memoryBytes: 536870912,
    },
    storage: {
      bucketId: 'b1',
      bucket: slug,
      keyId: 'GK1',
      keySecret: 'sec',
      corsOrigins: ['*'],
      aliases: [],
    },
    betterAuthSecret: 'bas',
    ...over,
  };
}
