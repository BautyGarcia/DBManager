import { describe, expect, it } from 'vitest';
import { destroyCommand } from '../../src/commands/destroy.js';
import { upsertProject } from '../../src/core/state.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../helpers/project.js';

function seeded(status: 'running' | 'paused' = 'running') {
  const t = makeTestDeps();
  t.store.state = upsertProject(t.store.state, fakeProject('my-app', { status }));
  t.garage.buckets.set('b1', {
    id: 'b1',
    globalAliases: ['my-app'],
    bytes: 10,
    objects: 2,
    unfinishedUploads: 0,
    websiteAccess: false,
  });
  t.garage.keys.set('GK1', { name: 'my-app-key' });
  return t;
}

describe('destroy', () => {
  it('takes a final backup, removes pgbouncer entries, service, volume, key; keeps bucket without --purge-storage', async () => {
    const t = seeded();
    const r = await destroyCommand(t.deps, {
      slug: 'my-app',
      purgeStorage: false,
      yes: true,
      confirmSlug: 'my-app',
    });
    expect(r.purgedStorage).toBe(false);
    expect(t.dokploy.calls).toEqual(['manualBackup', 'removeBackup', 'removePostgres']);
    expect(t.runner.calls.map((c) => c.argv.join(' '))).toContain(
      'docker volume rm pg-my-app-abc123-data',
    );
    expect(t.runner.uploads.at(-2)?.content).not.toContain('my-app');
    expect(t.garage.calls).toEqual(['deleteKey']);
    expect(t.garage.buckets.has('b1')).toBe(true);
    expect(t.store.state.projects['my-app']).toBeUndefined();
    expect(t.store.saves).toBe(1);
    expect(t.errLines.join('')).toMatch(/bucket my-app kept/);
  });
  it('--purge-storage empties then deletes the bucket and removes the web router', async () => {
    const t = seeded();
    const storage = t.store.state.projects['my-app']?.storage;
    if (!storage) throw new Error('seed missing storage');
    storage.publicBaseUrl = 'https://my-app.web.example.com';
    const bucket = t.garage.buckets.get('b1');
    if (!bucket) throw new Error('seed missing bucket');
    bucket.objects = 0; // emptyBucket is simulated by the runner; the fake bucket must be empty for deleteBucket
    await destroyCommand(t.deps, {
      slug: 'my-app',
      purgeStorage: true,
      yes: true,
      confirmSlug: 'my-app',
    });
    const cmds = t.runner.calls.map((c) => c.argv.join(' '));
    expect(
      cmds.some((c) => c.includes('rclone/rclone') && c.includes('purge') && c.includes('my-app')),
    ).toBe(true);
    const rc = t.runner.calls.find((c) => c.argv.join(' ').includes('rclone/rclone'));
    expect(rc?.input).toContain('sec');
    expect(rc?.argv.join(' ')).not.toContain('sec');
    expect(cmds).toContain('rm -f /etc/dokploy/traefik/dynamic/dbm-web-my-app.yml');
    expect(t.garage.calls).toEqual(['cleanupIncompleteUploads', 'deleteBucket', 'deleteKey']);
  });
  it('a paused project skips the final backup with a warning (Review Focus 4)', async () => {
    const t = seeded('paused');
    const r = await destroyCommand(t.deps, {
      slug: 'my-app',
      purgeStorage: false,
      yes: true,
      confirmSlug: 'my-app',
    });
    expect(t.dokploy.calls[0]).toBe('removeBackup');
    expect(r.warnings.join(' ')).toMatch(/paused.*no final backup/);
  });
  it('stops PgBouncer routing before removing the service and saves state once at the end', async () => {
    const t = seeded();
    let uploadsAtRemove = -1;
    let savesAtRemove = -1;
    const orig = t.dokploy.removePostgres.bind(t.dokploy);
    t.dokploy.removePostgres = async (id: string) => {
      uploadsAtRemove = t.runner.uploads.length;
      savesAtRemove = t.store.saves;
      await orig(id);
    };
    await destroyCommand(t.deps, {
      slug: 'my-app',
      purgeStorage: false,
      yes: true,
      confirmSlug: 'my-app',
    });
    expect(uploadsAtRemove).toBe(2);
    expect(savesAtRemove).toBe(0);
    expect(t.store.saves).toBe(1);
  });
  it('removePostgres failure: exit 2, project stays in state, message lists completed and remaining steps', async () => {
    const t = seeded();
    t.dokploy.failAt.add('removePostgres');
    const err = await destroyCommand(t.deps, {
      slug: 'my-app',
      purgeStorage: false,
      yes: true,
      confirmSlug: 'my-app',
    }).catch((e) => e);
    expect(err).toMatchObject({ exitCode: 2 });
    expect(err.message).toMatch(/completed: backup schedule/);
    expect(err.message).toMatch(/not attempted: .*volume pg-my-app-abc123-data/);
    expect(err.message).toMatch(/still in dbm state/);
    expect(t.store.state.projects['my-app']).toBeDefined();
    expect(t.store.saves).toBe(0);
  });
  it('deleteBucket failure under --purge-storage: exit 2, project stays, key not deleted', async () => {
    const t = seeded();
    t.garage.failAt.add('deleteBucket');
    const err = await destroyCommand(t.deps, {
      slug: 'my-app',
      purgeStorage: true,
      yes: true,
      confirmSlug: 'my-app',
    }).catch((e) => e);
    expect(err).toMatchObject({ exitCode: 2 });
    expect(err.message).toMatch(/not attempted: key GK1/);
    expect(t.garage.calls).not.toContain('deleteKey');
    expect(t.store.state.projects['my-app']).toBeDefined();
  });
  it('requires confirmation: wrong --confirm or declined prompt is a user error with no side effects', async () => {
    const t = seeded();
    await expect(
      destroyCommand(t.deps, {
        slug: 'my-app',
        purgeStorage: false,
        yes: true,
        confirmSlug: 'other',
      }),
    ).rejects.toThrow(/--confirm/);
    t.deps.confirm = async () => false;
    await expect(
      destroyCommand(t.deps, { slug: 'my-app', purgeStorage: false, yes: false }),
    ).rejects.toThrow(/aborted/);
    expect(t.dokploy.calls).toEqual([]);
    expect(t.runner.calls).toEqual([]);
    expect(t.garage.calls).toEqual([]);
    expect(t.store.saves).toBe(0);
  });
});
