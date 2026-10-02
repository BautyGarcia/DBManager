import { describe, expect, it } from 'vitest';
import { destroyCommand } from '../../src/commands/destroy.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';
import { makeTestDeps, seedProject } from '../helpers/fakes.js';
import { fakeProject } from '../helpers/project.js';

function seeded(
  status: 'running' | 'paused' = 'running',
  runner?: ReturnType<typeof makeFakeRunner>,
) {
  const t = makeTestDeps(runner ? { runner } : {});
  seedProject(t, fakeProject('my-app', { status }), { objects: 2 });
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
    expect(t.garage.keys.has('GK1')).toBe(false);
    expect(t.dokploy.postgres.has('pg_1')).toBe(false);
    expect(t.dokploy.backups.has('bk_1')).toBe(false);
    expect(t.garage.buckets.has('b1')).toBe(true);
    expect(t.store.state.projects['my-app']).toBeUndefined();
    expect(t.store.saves).toBe(1);
    expect(t.store.state.destroyed?.['my-app']).toMatchObject({
      slug: 'my-app',
      appName: 'pg-my-app-abc123',
      pgMajor: 18,
      bucketId: 'b1',
      bucket: 'my-app',
    });
    expect(t.errLines.join('')).toMatch(/bucket my-app kept/);
  });
  it('a kept public bucket stops being served: router file removed, aliases and website access off', async () => {
    const t = makeTestDeps();
    const p = fakeProject('my-app');
    if (!p.storage) throw new Error('seed missing storage');
    p.storage.publicBaseUrl = 'https://my-app.web.example.com';
    p.storage.aliases = ['cdn.example.org'];
    seedProject(t, p);
    await destroyCommand(t.deps, {
      slug: 'my-app',
      purgeStorage: false,
      yes: true,
      confirmSlug: 'my-app',
    });
    const cmds = t.runner.calls.map((c) => c.argv.join(' '));
    expect(cmds).toContain('rm -f /etc/dokploy/traefik/dynamic/dbm-web-my-app.yml');
    expect(t.garage.calls).toEqual(['removeBucketAlias', 'updateBucket', 'deleteKey']);
    expect(t.garage.inputs.updateBucket?.[0]).toEqual([
      'b1',
      { websiteAccess: { enabled: false } },
    ]);
    expect(t.garage.buckets.get('b1')?.websiteAccess).toBe(false);
    expect(t.garage.buckets.has('b1')).toBe(true);
  });
  it('a kept private bucket still gets its (absent) router file removed, no Garage website call', async () => {
    const t = seeded();
    await destroyCommand(t.deps, {
      slug: 'my-app',
      purgeStorage: false,
      yes: true,
      confirmSlug: 'my-app',
    });
    expect(t.runner.calls.map((c) => c.argv.join(' '))).toContain(
      'rm -f /etc/dokploy/traefik/dynamic/dbm-web-my-app.yml',
    );
    expect(t.garage.calls).not.toContain('updateBucket');
  });
  it('a failed destroy is retryable: re-run tolerates already-removed resources and finishes', async () => {
    const runner = makeFakeRunner([
      { match: /^docker volume rm/, fail: true, stderr: 'Error: permission denied' },
    ]);
    const t = seeded('running', runner);
    const first = await destroyCommand(t.deps, {
      slug: 'my-app',
      purgeStorage: true,
      yes: true,
      confirmSlug: 'my-app',
    }).catch((e) => e);
    expect(first).toMatchObject({ exitCode: 2 });
    expect(first.message).toMatch(/failed at volume pg-my-app-abc123-data/);
    expect(t.store.state.projects['my-app']).toBeDefined();
    expect(t.dokploy.backups.has('bk_1')).toBe(false);
    expect(t.dokploy.postgres.has('pg_1')).toBe(false);

    const bucket = t.garage.buckets.get('b1');
    if (bucket) bucket.objects = 0; // the re-run's rclone delete is simulated by the runner
    const ok = makeFakeRunner([]);
    t.deps.ssh = ok.runner;
    const r = await destroyCommand(t.deps, {
      slug: 'my-app',
      purgeStorage: true,
      yes: true,
      confirmSlug: 'my-app',
    });
    expect(r.warnings.join(' ')).toMatch(/backup schedule bk_1 not found.*no final backup/);
    expect(t.errLines.join('')).toMatch(/backup schedule: already gone/);
    expect(t.errLines.join('')).toMatch(/postgres service: already gone/);
    expect(t.store.state.projects['my-app']).toBeUndefined();
    expect(t.store.state.destroyed?.['my-app']).toBeDefined();
    expect(t.garage.buckets.has('b1')).toBe(false);
    expect(t.garage.keys.has('GK1')).toBe(false);
  });
  it('re-run after the key step failed: bucket and key already gone count as done', async () => {
    const t = seeded();
    t.garage.buckets.delete('b1');
    t.garage.keys.delete('GK1');
    await destroyCommand(t.deps, {
      slug: 'my-app',
      purgeStorage: true,
      yes: true,
      confirmSlug: 'my-app',
    });
    expect(t.errLines.join('')).toMatch(/bucket my-app: already gone/);
    expect(t.errLines.join('')).toMatch(/key GK1: already gone/);
    expect(t.runner.calls.some((c) => c.argv.join(' ').includes('rclone/rclone'))).toBe(false);
    expect(t.store.state.projects['my-app']).toBeUndefined();
    expect(t.store.state.destroyed?.['my-app']?.bucketId).toBeUndefined();
  });
  it('--purge-storage empties then deletes the bucket and removes the web router', async () => {
    const t = makeTestDeps();
    const p = fakeProject('my-app');
    if (!p.storage) throw new Error('seed missing storage');
    p.storage.publicBaseUrl = 'https://my-app.web.example.com';
    // emptyBucket is simulated by the runner; the fake bucket must be empty for deleteBucket
    seedProject(t, p, { objects: 0 });
    await destroyCommand(t.deps, {
      slug: 'my-app',
      purgeStorage: true,
      yes: true,
      confirmSlug: 'my-app',
    });
    const cmds = t.runner.calls.map((c) => c.argv.join(' '));
    // `rclone delete` (objects only): `purge` would call DeleteBucket, which the read+write key may not.
    expect(cmds).toContain(
      'docker run --rm -i --network dokploy-network rclone/rclone:1 --config /dev/stdin delete garage:my-app',
    );
    expect(cmds.some((c) => c.includes('purge'))).toBe(false);
    const rc = t.runner.calls.find((c) => c.argv.join(' ').includes('rclone/rclone'));
    expect(rc?.input).toContain('sec');
    expect(rc?.argv.join(' ')).not.toContain('sec');
    expect(cmds).toContain('rm -f /etc/dokploy/traefik/dynamic/dbm-web-my-app.yml');
    expect(t.garage.calls).toEqual([
      'updateBucket',
      'getBucket',
      'cleanupIncompleteUploads',
      'deleteBucket',
      'deleteKey',
    ]);
    expect(t.store.state.destroyed?.['my-app']?.bucketId).toBeUndefined();
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
