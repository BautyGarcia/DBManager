import { describe, expect, it } from 'vitest';
import {
  backupCommand,
  pickBackup,
  restoreCommand,
  restoreScript,
} from '../../src/commands/backup.js';
import { createCommand } from '../../src/commands/create.js';
import { destroyCommand } from '../../src/commands/destroy.js';
import { addTombstone, upsertProject } from '../../src/core/state.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';
import { makeTestDeps, seedProject } from '../helpers/fakes.js';
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
    seedProject(t, fakeProject('my-app'));
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
      'rclone/rclone:1 --config /dev/stdin cat dst:dumps/pg-my-app-abc123/db/my-app/2026-09-30T06-03-00-000Z.sql.gz --s3-no-head-object',
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

describe('restore after destroy and re-create (C2)', () => {
  const destroyOpts = { slug: 'my-app', yes: true, confirmSlug: 'my-app' };
  it('destroy -> create -> restore x latest lists dumps under the NEW appName', async () => {
    const t = makeTestDeps();
    seedProject(
      t,
      fakeProject('my-app', {
        dokploy: { postgresId: 'pg_old', appName: 'pg-my-app-old999', backupId: 'bk_old' },
      }),
    );
    await destroyCommand(t.deps, { ...destroyOpts, purgeStorage: true });
    expect(t.store.state.destroyed?.['my-app']?.appName).toBe('pg-my-app-old999');
    const created = await createCommand(t.deps, { slug: 'my-app' });
    expect(created.project.dokploy.appName).toBe('pg-my-app-abc123');
    expect(t.store.state.destroyed?.['my-app']).toBeUndefined();
    t.dokploy.files = files;
    await restoreCommand(t.deps, {
      slug: 'my-app',
      backupId: 'latest',
      yes: true,
      confirmSlug: 'my-app',
    });
    expect(t.dokploy.inputs.listBackupFiles?.at(-1)).toEqual(['d1', 'pg-my-app-abc123/db/my-app/']);
  });
  it('without --as a live project wins even if a (stale) tombstone exists', async () => {
    const t = makeTestDeps();
    t.store.state = addTombstone(upsertProject(t.store.state, fakeProject('my-app')), {
      slug: 'my-app',
      appName: 'pg-my-app-old999',
      pgMajor: 18,
      extensions: [],
      memoryBytes: 536870912,
      destroyedAt: '2026-09-29T00:00:00Z',
    });
    t.dokploy.files = files;
    await restoreCommand(t.deps, {
      slug: 'my-app',
      backupId: 'latest',
      yes: true,
      confirmSlug: 'my-app',
    });
    expect(t.dokploy.inputs.listBackupFiles?.[0]).toEqual(['d1', 'pg-my-app-abc123/db/my-app/']);
  });
  it('restore x latest --as x with live + tombstone still uses the tombstone appName (retry)', async () => {
    const t = makeTestDeps();
    t.store.state = addTombstone(upsertProject(t.store.state, fakeProject('my-app')), {
      slug: 'my-app',
      appName: 'pg-my-app-old999',
      pgMajor: 18,
      extensions: [],
      memoryBytes: 536870912,
      destroyedAt: '2026-09-29T00:00:00Z',
    });
    t.dokploy.files = files;
    await restoreCommand(t.deps, {
      slug: 'my-app',
      backupId: 'latest',
      yes: true,
      confirmSlug: 'my-app',
      as: 'my-app',
    });
    expect(t.dokploy.inputs.listBackupFiles?.[0]).toEqual(['d1', 'pg-my-app-old999/db/my-app/']);
    expect(t.dokploy.calls).not.toContain('createPostgres');
    expect(t.store.state.destroyed?.['my-app']).toBeUndefined();
  });
});

describe('recovering an accidental destroy with the bucket kept (I2)', () => {
  it('restore --as <same slug> reuses the kept bucket and grants a new key on it', async () => {
    const t = makeTestDeps();
    seedProject(
      t,
      fakeProject('my-app', {
        dokploy: { postgresId: 'pg_old', appName: 'pg-my-app-old999', backupId: 'bk_old' },
      }),
      { objects: 7 },
    );
    await destroyCommand(t.deps, {
      slug: 'my-app',
      purgeStorage: false,
      yes: true,
      confirmSlug: 'my-app',
    });
    expect(t.store.state.destroyed?.['my-app']).toMatchObject({ bucketId: 'b1', bucket: 'my-app' });
    t.dokploy.files = files;
    const r = await restoreCommand(t.deps, {
      slug: 'my-app',
      backupId: 'latest',
      yes: false,
      as: 'my-app',
    });
    expect(r.target).toBe('my-app');
    expect(t.garage.calls).not.toContain('createBucket');
    const p = t.store.state.projects['my-app'];
    expect(p?.status).toBe('running');
    expect(p?.storage).toMatchObject({ bucketId: 'b1', bucket: 'my-app' });
    expect(t.garage.calls.filter((c) => c === 'createKey')).toHaveLength(1);
    expect(t.garage.keys.has(p?.storage?.keyId ?? '')).toBe(true);
    expect(t.garage.inputs.allowBucketKey).toEqual([
      ['b1', p?.storage?.keyId, { read: true, write: true }],
      ['b1', 'GKbackup', { read: true }],
    ]);
    expect(t.garage.buckets.get('b1')?.objects).toBe(7);
    expect(t.dokploy.inputs.listBackupFiles?.[0]).toEqual(['d1', 'pg-my-app-old999/db/my-app/']);
    expect(t.store.state.destroyed?.['my-app']).toBeUndefined();
  });
  it('falls back to a new bucket when the kept one was deleted by hand', async () => {
    const t = makeTestDeps();
    t.store.state = addTombstone(t.store.state, {
      slug: 'my-app',
      appName: 'pg-my-app-old999',
      pgMajor: 18,
      extensions: [],
      memoryBytes: 536870912,
      destroyedAt: '2026-09-29T00:00:00Z',
      bucketId: 'gone',
      bucket: 'my-app',
    });
    t.dokploy.files = files;
    await restoreCommand(t.deps, { slug: 'my-app', backupId: 'latest', yes: false, as: 'my-app' });
    expect(t.garage.calls).toContain('createBucket');
    expect(t.errLines.join('')).toMatch(/kept bucket my-app no longer exists/);
  });
  it('restoring a tombstone into a different slug creates a fresh bucket', async () => {
    const t = makeTestDeps();
    t.store.state = addTombstone(t.store.state, {
      slug: 'my-app',
      appName: 'pg-my-app-old999',
      pgMajor: 18,
      extensions: [],
      memoryBytes: 536870912,
      destroyedAt: '2026-09-29T00:00:00Z',
      bucketId: 'b1',
      bucket: 'my-app',
    });
    t.dokploy.files = files;
    await restoreCommand(t.deps, { slug: 'my-app', backupId: 'latest', yes: false, as: 'staging' });
    expect(t.garage.inputs.createBucket).toEqual([['staging']]);
    expect(t.store.state.destroyed?.['my-app']).toBeDefined();
  });
});

describe('restoreScript (C3)', () => {
  const base = {
    network: 'dokploy-network',
    bucket: 'dumps',
    objectPath: 'pg-x/db/x/a.sql.gz',
    container: 'c_pg-x',
    appRole: 'x_app',
    database: 'x',
  };
  it('stages the dump in the container, filters extension entries from the TOC, restores with -L', () => {
    const s = restoreScript(base);
    expect(s.split('\n')).toEqual([
      'set -e -o pipefail',
      "trap 'rc=$?; docker exec c_pg-x rm -f /tmp/dbm-restore.dump /tmp/dbm-restore.list; exit $rc' EXIT",
      "docker run --rm -i --network dokploy-network rclone/rclone:1 --config /dev/stdin cat dst:dumps/pg-x/db/x/a.sql.gz --s3-no-head-object | gunzip | docker exec -i c_pg-x sh -c 'cat > /tmp/dbm-restore.dump'",
      "docker exec c_pg-x sh -c 'pg_restore -l /tmp/dbm-restore.dump | grep -Ev '\"'\"'^;|[[:space:]]EXTENSION[[:space:]]|COMMENT - EXTENSION'\"'\"' > /tmp/dbm-restore.list'",
      'docker exec c_pg-x pg_restore -U x_app -d x -O --clean --if-exists --no-comments -L /tmp/dbm-restore.list /tmp/dbm-restore.dump',
    ]);
  });
  it('accepts a custom source command', () => {
    const s = restoreScript({ ...base, source: 'cat /tmp/x.gz' });
    expect(s).toContain(
      "cat /tmp/x.gz | gunzip | docker exec -i c_pg-x sh -c 'cat > /tmp/dbm-restore.dump'",
    );
    expect(s).not.toContain('rclone');
  });
});
