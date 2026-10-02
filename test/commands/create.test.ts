import { describe, expect, it } from 'vitest';
import { createCommand } from '../../src/commands/create.js';
import { DbmError } from '../../src/core/exit.js';
import { upsertProject } from '../../src/core/state.js';
import { FakeDokploy, FakeGarage, makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../helpers/project.js';

describe('createCommand', () => {
  it('provisions postgres, pgbouncer, garage, backup; prints env; saves running state', async () => {
    const t = makeTestDeps();
    const r = await createCommand(t.deps, { slug: 'my-app', memory: '512m' });
    expect(r.existed).toBe(false);
    expect(r.env.DATABASE_URL).toMatch(
      /^postgresql:\/\/my_app_app:[A-Za-z0-9_-]{43}@db\.example\.com:6432\/my-app\?sslmode=verify-full$/,
    );
    expect(r.env.S3_BUCKET).toBe('my-app');
    expect(t.dokploy.calls).toEqual([
      'getProject',
      'createPostgres',
      'updatePostgres',
      'deployPostgres',
      'getPostgres',
      'deployPostgres',
      'getPostgres',
      'createBackup',
    ]);
    const created = [...t.dokploy.postgres.values()][0];
    expect(created?.databaseName).toBe('postgres');
    expect(created?.databaseUser).toBe('my_app_admin');
    expect(t.pg.sql.map((s) => s.sql).join('\n')).toMatch(
      /CREATE ROLE "my_app_app" LOGIN NOSUPERUSER .* PASSWORD 'SCRAM-SHA-256\$4096:/,
    );
    expect(t.pg.sql.map((s) => s.sql).join('\n')).toContain(
      'CREATE DATABASE "my_app" OWNER "my_app_app";',
    );
    expect(t.pg.sql.map((s) => s.sql).join('\n')).toContain(
      'CREATE EXTENSION IF NOT EXISTS "pgcrypto";',
    );
    expect(t.pg.sql.map((s) => s.sql).join('\n')).toContain(
      "ALTER SYSTEM SET shared_buffers = '128MB';",
    );
    expect(t.runner.uploads.map((u) => u.path)).toEqual([
      '/etc/dokploy/dbm/pgbouncer/pgbouncer.ini',
      '/etc/dokploy/dbm/pgbouncer/userlist.txt',
    ]);
    expect(t.runner.uploads[0]?.content).toContain(
      'my-app = host=pg-my-app-abc123 port=5432 dbname=my_app',
    );
    expect(t.runner.calls.map((c) => c.argv.join(' '))).toContain(
      'docker kill -s HUP dbm-pgbouncer',
    );
    expect(t.garage.calls).toEqual([
      'createBucket',
      'createKey',
      'allowBucketKey',
      'allowBucketKey',
      'updateBucket',
    ]);
    const backup = [...t.dokploy.backups.values()][0];
    expect(backup).toMatchObject({
      prefix: 'db/my-app',
      database: 'my_app',
      keepLatestCount: 35,
      enabled: true,
      databaseType: 'postgres',
    });
    expect(backup?.schedule).toMatch(/^\d+ 6 \* \* \*$/);
    const saved = t.store.state.projects['my-app'];
    expect(saved?.status).toBe('running');
    expect(saved?.postgres.memoryBytes).toBe(536870912);
    expect(saved?.dokploy.backupId).toBe('bk_1');
    expect(saved?.storage?.bucketId).toBe('b_1');
    expect(t.outLines.join('')).toBe('');
  });

  it('re-running on an existing slug is a no-op with zero adapter calls (Review Focus 2)', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    const r = await createCommand(t.deps, { slug: 'my-app' });
    expect(r.existed).toBe(true);
    expect(t.dokploy.calls).toEqual([]);
    expect(t.garage.calls).toEqual([]);
    expect(t.store.saves).toBe(0);
  });

  it('refuses when the service exists in Dokploy but not in state', async () => {
    const t = makeTestDeps();
    t.dokploy.existingNames.add('pg-my-app');
    await expect(createCommand(t.deps, { slug: 'my-app' })).rejects.toMatchObject({
      exitCode: 1,
      message: /exists in Dokploy/,
    });
    expect(t.dokploy.calls).toEqual(['getProject']);
  });

  it('a 409 on createPostgres fails cleanly with no rollback work (Review Focus 3)', async () => {
    const dokploy = new FakeDokploy();
    dokploy.failAt.add('createPostgres');
    const t = makeTestDeps({ dokploy });
    await expect(createCommand(t.deps, { slug: 'my-app' })).rejects.toMatchObject({
      exitCode: 2,
      step: 'dokploy.createPostgres',
    });
    expect(t.dokploy.calls).toEqual(['getProject', 'createPostgres']);
    expect(t.runner.uploads).toEqual([]);
    expect(t.runner.calls).toEqual([]);
    expect(t.errLines.join('')).not.toContain('rollback');
    expect(t.store.state.projects['my-app']).toBeUndefined();
  });

  it('a failure at garage.createKey rolls back postgres, volume, pgbouncer entry and bucket', async () => {
    const garage = new FakeGarage();
    garage.failAt.add('createKey');
    const t = makeTestDeps({ garage });
    await expect(createCommand(t.deps, { slug: 'my-app' })).rejects.toMatchObject({
      exitCode: 2,
      step: 'garage.createKey',
    });
    expect(t.dokploy.calls).toContain('removePostgres');
    expect(t.runner.calls.map((c) => c.argv.join(' '))).toContain(
      'docker volume rm pg-my-app-abc123-data',
    );
    expect(t.garage.calls.filter((c) => c === 'deleteBucket')).toHaveLength(1);
    expect(t.garage.buckets.size).toBe(0);
    // pgbouncer re-rendered without the project
    const lastIni = t.runner.uploads.filter((u) => u.path.endsWith('pgbouncer.ini')).at(-1);
    expect(lastIni?.content).not.toContain('my-app');
    expect(t.store.state.projects['my-app']).toBeUndefined();
    // reverse order of completion: bucket, state + PgBouncer, service, then its volume (spec section 7)
    expect(t.errLines.filter((l) => l.includes('rollback:')).map((l) => l.trim())).toEqual([
      'rollback: delete bucket my-app',
      'rollback: remove project from state and re-render PgBouncer',
      'rollback: remove Dokploy service pg-my-app-abc123',
      'rollback: remove volume pg-my-app-abc123-data',
    ]);
  });

  it('if rollback itself fails, exit code is 3 and leftovers are listed', async () => {
    const garage = new FakeGarage();
    garage.failAt.add('createKey');
    const dokploy = new FakeDokploy();
    dokploy.failAt.add('removePostgres');
    const t = makeTestDeps({ garage, dokploy });
    const err = await createCommand(t.deps, { slug: 'my-app' }).catch(
      (e: unknown) => e as DbmError,
    );
    expect(err).toBeInstanceOf(DbmError);
    expect((err as DbmError).exitCode).toBe(3);
    expect((err as DbmError).message).toMatch(/leftover/i);
    expect((err as DbmError).message).toContain('pg-my-app-abc123');
  });

  it('a slug that is a prefix of an existing service is not a clash', async () => {
    const t = makeTestDeps();
    t.dokploy.existingNames.add('pg-my-app');
    const r = await createCommand(t.deps, { slug: 'my', storage: false });
    expect(r.existed).toBe(false);
  });

  it('a deploy error status is a remote failure and rolls back', async () => {
    const dokploy = new FakeDokploy();
    dokploy.deployPostgres = async (id: string) => {
      dokploy.calls.push('deployPostgres');
      const p = dokploy.postgres.get(id);
      if (p) p.status = 'error';
    };
    const t = makeTestDeps({ dokploy });
    await expect(createCommand(t.deps, { slug: 'my-app' })).rejects.toMatchObject({
      exitCode: 2,
      step: 'dokploy.deploy',
    });
    expect(t.dokploy.calls).toContain('removePostgres');
  });

  it('--no-storage skips garage, --pg 17 pins the image, invalid extension is a user error', async () => {
    const t = makeTestDeps();
    const r = await createCommand(t.deps, { slug: 'a1', storage: false, pg: 17 });
    expect(r.env.S3_BUCKET).toBeUndefined();
    expect(t.garage.calls).toEqual([]);
    expect(t.store.state.projects.a1?.pgMajor).toBe(17);
    await expect(createCommand(t.deps, { slug: 'a2', extensions: ['x;y'] })).rejects.toMatchObject({
      exitCode: 1,
    });
  });
});
