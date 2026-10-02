import { describe, expect, it } from 'vitest';
import { backupCommand, pickBackup, restoreCommand } from '../../src/commands/backup.js';
import { addTombstone, upsertProject } from '../../src/core/state.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../helpers/project.js';

const files = [
  {
    Path: 'pg-my-app-abc123/db/my-app/2026-09-29T06-03-00-000Z.sql.gz',
    Name: '2026-09-29T06-03-00-000Z.sql.gz',
    Size: 1,
    ModTime: '2026-09-29T06:03:01Z',
  },
  {
    Path: 'pg-my-app-abc123/db/my-app/2026-09-30T06-03-00-000Z.sql.gz',
    Name: '2026-09-30T06-03-00-000Z.sql.gz',
    Size: 1,
    ModTime: '2026-09-30T06:03:01Z',
  },
];

describe('backup', () => {
  it('triggers a manual backup and lists files', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    t.dokploy.files = files;
    const r = await backupCommand(t.deps, 'my-app');
    expect(t.dokploy.calls).toEqual(['manualBackup', 'listBackupFiles']);
    expect(r.files).toHaveLength(2);
  });
  it('pickBackup: latest by ModTime, or by Name/Path; unknown id is a user error', () => {
    expect(pickBackup(files, 'latest').Name).toBe('2026-09-30T06-03-00-000Z.sql.gz');
    expect(pickBackup(files, '2026-09-29T06-03-00-000Z.sql.gz').ModTime).toBe(
      '2026-09-29T06:03:01Z',
    );
    expect(() => pickBackup(files, 'nope')).toThrow(/not found/);
    expect(() => pickBackup([], 'latest')).toThrow(/no backups/);
  });
});

describe('restore', () => {
  it('streams rclone cat | gunzip | pg_restore as the app role with destination creds on stdin', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    t.dokploy.files = files;
    const r = await restoreCommand(t.deps, { slug: 'my-app', backupId: 'latest', yes: false });
    expect(r.target).toBe('my-app');
    const call = t.runner.calls.find((c) => c.argv.join(' ').includes('pg_restore'));
    const cmd = call?.argv.join(' ') ?? '';
    expect(cmd).toContain(
      'rclone/rclone:1 --config /dev/stdin cat dst:dumps/pg-my-app-abc123/db/my-app/2026-09-30T06-03-00-000Z.sql.gz',
    );
    expect(cmd).toContain('gunzip');
    expect(cmd).toContain('pg_restore -U my_app_app -d my_app -O --clean --if-exists');
    expect(call?.input).toContain('access_key_id = AK');
    expect(call?.input).toContain('secret_access_key = SK');
    expect(cmd).not.toContain('SK');
  });
  it('--as creates the new project first and restores into it', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    t.dokploy.files = files;
    const r = await restoreCommand(t.deps, {
      slug: 'my-app',
      backupId: 'latest',
      yes: false,
      as: 'staging',
    });
    expect(r.target).toBe('staging');
    expect(t.store.state.projects.staging?.status).toBe('running');
    expect(t.dokploy.calls).toContain('createPostgres');
  });
});

describe('restore from tombstone', () => {
  const tomb = {
    slug: 'my-app',
    appName: 'pg-my-app-abc123',
    pgMajor: 18 as const,
    extensions: [],
    memoryBytes: 536870912,
    destroyedAt: '2026-09-30T00:00:00Z',
  };
  it('--as same slug recreates the project and removes the tombstone', async () => {
    const t = makeTestDeps();
    t.store.state = addTombstone(t.store.state, tomb);
    t.dokploy.files = files;
    const r = await restoreCommand(t.deps, {
      slug: 'my-app',
      backupId: 'latest',
      yes: false,
      as: 'my-app',
    });
    expect(r.target).toBe('my-app');
    expect(t.store.state.projects['my-app']?.status).toBe('running');
    expect(t.store.state.destroyed?.['my-app']).toBeUndefined();
    expect(t.dokploy.calls).toContain('createPostgres');
    const cmd = t.runner.calls.map((c) => c.argv.join(' ')).find((c) => c.includes('pg_restore'));
    expect(cmd).toContain('dst:dumps/pg-my-app-abc123/db/my-app/2026-09-30T06-03-00-000Z.sql.gz');
  });
  it('without --as is a user error', async () => {
    const t = makeTestDeps();
    t.store.state = addTombstone(t.store.state, tomb);
    await expect(
      restoreCommand(t.deps, { slug: 'my-app', backupId: 'latest', yes: false }),
    ).rejects.toThrow(/destroyed/);
  });
  it('unknown slug is a user error; --as a live slug is rejected', async () => {
    const t = makeTestDeps();
    await expect(
      restoreCommand(t.deps, { slug: 'zzz', backupId: 'latest', yes: false }),
    ).rejects.toThrow(/neither a live project nor a destroyed/);
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    await expect(
      restoreCommand(t.deps, { slug: 'my-app', backupId: 'latest', yes: false, as: 'my-app' }),
    ).rejects.toThrow(/already exists/);
  });
});

describe('restore hardening', () => {
  const tomb = {
    slug: 'my-app',
    appName: 'pg-my-app-abc123',
    pgMajor: 18 as const,
    extensions: [],
    memoryBytes: 536870912,
    destroyedAt: '2026-09-30T00:00:00Z',
  };
  it('failed tombstone restore is retryable without recreating the project', async () => {
    const runner = makeFakeRunner([{ match: /pg_restore/, fail: true }]);
    const t = makeTestDeps({ runner });
    t.store.state = addTombstone(t.store.state, tomb);
    t.dokploy.files = files;
    await expect(
      restoreCommand(t.deps, { slug: 'my-app', backupId: 'latest', yes: false, as: 'my-app' }),
    ).rejects.toThrow();
    expect(t.store.state.projects['my-app']).toBeDefined();
    expect(t.store.state.destroyed?.['my-app']).toBeDefined();
    const creates = t.dokploy.calls.filter((c) => c === 'createPostgres').length;
    runner.calls.length = 0;
    const ok = makeFakeRunner([]);
    t.deps.ssh = ok.runner;
    await restoreCommand(t.deps, {
      slug: 'my-app',
      backupId: 'latest',
      yes: true,
      confirmSlug: 'my-app',
      as: 'my-app',
    });
    expect(t.dokploy.calls.filter((c) => c === 'createPostgres')).toHaveLength(creates);
    const cmd = ok.calls.map((c) => c.argv.join(' ')).find((c) => c.includes('pg_restore'));
    expect(cmd).toContain('dst:dumps/pg-my-app-abc123/db/my-app/');
    expect(t.store.state.destroyed?.['my-app']).toBeUndefined();
  });
  it('in-place restore: declined confirm has no side effects; yes+confirm proceeds', async () => {
    const t = makeTestDeps({ confirm: async () => false });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    t.dokploy.files = files;
    await expect(
      restoreCommand(t.deps, { slug: 'my-app', backupId: 'latest', yes: false }),
    ).rejects.toThrow(/aborted/);
    expect(t.runner.calls).toHaveLength(0);
    expect(t.dokploy.calls).toEqual(['listBackupFiles']);
    await expect(
      restoreCommand(t.deps, { slug: 'my-app', backupId: 'latest', yes: true }),
    ).rejects.toThrow(/--confirm/);
    await restoreCommand(t.deps, {
      slug: 'my-app',
      backupId: 'latest',
      yes: true,
      confirmSlug: 'my-app',
    });
    expect(t.runner.calls.some((c) => c.argv.join(' ').includes('pg_restore'))).toBe(true);
  });
  it('--as a new slug does not ask for confirmation', async () => {
    let asked = 0;
    const t = makeTestDeps({
      confirm: async () => {
        asked++;
        return true;
      },
    });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    t.dokploy.files = files;
    await restoreCommand(t.deps, { slug: 'my-app', backupId: 'latest', yes: false, as: 'staging' });
    expect(asked).toBe(0);
  });
  it('quotes interpolated values (path with space and $)', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    t.dokploy.files = [
      {
        Path: 'pg-my-app-abc123/db/my-app/a b$c.sql.gz',
        Name: 'a b$c.sql.gz',
        Size: 1,
        ModTime: '2026-10-01T00:00:00Z',
      },
    ];
    await restoreCommand(t.deps, { slug: 'my-app', backupId: 'latest', yes: false });
    const cmd = t.runner.calls.map((c) => c.argv.join(' ')).find((c) => c.includes('pg_restore'));
    expect(cmd).toContain(`'dst:dumps/pg-my-app-abc123/db/my-app/a b$c.sql.gz'`);
  });
});
