import { describe, expect, it } from 'vitest';
import { pauseCommand, resumeCommand } from '../../src/commands/pause.js';
import { upsertProject } from '../../src/core/state.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../helpers/project.js';

describe('pause/resume', () => {
  it('stops the service and disables the backup schedule, then reverses', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    t.dokploy.backups.set('bk_1', {
      schedule: '3 6 * * *',
      prefix: 'db/my-app',
      destinationId: 'd1',
      database: 'my_app',
      databaseType: 'postgres',
      postgresId: 'pg_1',
      enabled: true,
      keepLatestCount: 35,
    });
    const p = await pauseCommand(t.deps, 'my-app');
    expect(p.status).toBe('paused');
    expect(t.dokploy.calls).toEqual(['stopPostgres', 'updateBackup']);
    expect(t.dokploy.backups.get('bk_1')?.enabled).toBe(false);
    expect(t.store.state.projects['my-app']?.status).toBe('paused');
    const first = t.dokploy.inputs.updateBackup?.[0]?.[0] as Record<string, unknown>;
    expect(first).toMatchObject({
      prefix: 'db/my-app',
      destinationId: 'd1',
      database: 'my_app',
      databaseType: 'postgres',
      postgresId: 'pg_1',
      keepLatestCount: 35,
      backupId: 'bk_1',
      enabled: false,
    });
    expect(typeof first.schedule).toBe('string');
    const r = await resumeCommand(t.deps, 'my-app');
    expect(r.status).toBe('running');
    expect(t.dokploy.calls.slice(2)).toEqual(['startPostgres', 'updateBackup']);
    expect(t.dokploy.backups.get('bk_1')?.enabled).toBe(true);
  });
  it('pausing an already paused project is a no-op', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app', { status: 'paused' }));
    await pauseCommand(t.deps, 'my-app');
    expect(t.dokploy.calls).toEqual([]);
  });
});
