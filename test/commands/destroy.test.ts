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
    expect(t.errLines.join('')).toMatch(/bucket my-app kept/);
  });
  it('--purge-storage empties then deletes the bucket and removes the web router', async () => {
    const t = seeded();
    t.store.state.projects['my-app']!.storage!.publicBaseUrl = 'https://my-app.web.example.com';
    t.garage.buckets.get('b1')!.objects = 0; // emptyBucket is simulated by the runner; the fake bucket must be empty for deleteBucket
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
  it('requires confirmation: wrong --confirm or declined prompt is a user error with no side effects', async () => {
    const t = seeded();
    await expect(
      destroyCommand(t.deps, {
        slug: 'my-app',
        purgeStorage: false,
        yes: true,
        confirmSlug: 'other',
      }),
    ).rejects.toMatchObject({ exitCode: 1 });
    t.deps.confirm = async () => false;
    await expect(
      destroyCommand(t.deps, { slug: 'my-app', purgeStorage: false, yes: false }),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(t.dokploy.calls).toEqual([]);
  });
});
