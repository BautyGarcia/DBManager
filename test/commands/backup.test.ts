import { describe, expect, it } from 'vitest';
import { backupCommand, pickBackup, restoreCommand } from '../../src/commands/backup.js';
import { upsertProject } from '../../src/core/state.js';
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
    const r = await restoreCommand(t.deps, { slug: 'my-app', backupId: 'latest' });
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
    const r = await restoreCommand(t.deps, { slug: 'my-app', backupId: 'latest', as: 'staging' });
    expect(r.target).toBe('staging');
    expect(t.store.state.projects.staging?.status).toBe('running');
    expect(t.dokploy.calls).toContain('createPostgres');
  });
});
