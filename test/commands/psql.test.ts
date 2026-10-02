import { describe, expect, it } from 'vitest';
import { psqlArgv } from '../../src/commands/psql.js';
import { syncPgbouncerCommand } from '../../src/commands/sync-pgbouncer.js';
import { upsertProject } from '../../src/core/state.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../helpers/project.js';

describe('psql', () => {
  it('builds an interactive docker exec as the app role, or admin with --admin', () => {
    const p = fakeProject('my-app');
    expect(psqlArgv('c1', p, false)).toEqual([
      'docker',
      'exec',
      '-it',
      'c1',
      'psql',
      '-U',
      'my_app_app',
      '-d',
      'my_app',
    ]);
    expect(psqlArgv('c1', p, true)).toEqual([
      'docker',
      'exec',
      '-it',
      'c1',
      'psql',
      '-U',
      'my_app_admin',
      '-d',
      'my_app',
    ]);
  });
});

describe('sync-pgbouncer', () => {
  it('re-renders both files from state and reloads', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    await syncPgbouncerCommand(t.deps);
    expect(t.runner.uploads.map((u) => u.path)).toEqual([
      '/etc/dokploy/dbm/pgbouncer/pgbouncer.ini',
      '/etc/dokploy/dbm/pgbouncer/userlist.txt',
    ]);
    expect(t.runner.calls.at(-1)?.argv).toEqual(['docker', 'kill', '-s', 'HUP', 'dbm-pgbouncer']);
  });
});
