import { describe, expect, it } from 'vitest';
import { storageCorsCommand, storagePublicCommand } from '../../src/commands/storage.js';
import { upsertProject } from '../../src/core/state.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../helpers/project.js';

function seeded() {
  const t = makeTestDeps();
  t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
  t.garage.buckets.set('b1', {
    id: 'b1',
    globalAliases: ['my-app'],
    bytes: 0,
    objects: 0,
    unfinishedUploads: 0,
    websiteAccess: false,
  });
  return t;
}

describe('storage public', () => {
  it('enables website access, writes a Traefik router for <slug>.web.<domain>, saves publicBaseUrl', async () => {
    const t = seeded();
    const r = await storagePublicCommand(t.deps, { slug: 'my-app', off: false });
    expect(r.publicBaseUrl).toBe('https://my-app.web.example.com');
    expect(t.garage.calls).toEqual(['updateBucket']);
    expect(t.garage.inputs.updateBucket?.[0]).toEqual([
      'b1',
      { websiteAccess: { enabled: true, indexDocument: 'index.html', errorDocument: '404.html' } },
    ]);
    expect(t.garage.buckets.get('b1')?.websiteAccess).toBe(true);
    const up = t.runner.uploads[0];
    expect(up?.path).toBe('/etc/dokploy/traefik/dynamic/dbm-web-my-app.yml');
    expect(up?.content).toContain('rule: Host(`my-app.web.example.com`)');
    expect(up?.content).toContain('- url: http://dbm-garage:3902');
    expect(t.store.state.projects['my-app']?.storage?.publicBaseUrl).toBe(
      'https://my-app.web.example.com',
    );
  });
  it('--domain adds a bucket alias and routes both hosts; --off reverses everything', async () => {
    const t = seeded();
    await storagePublicCommand(t.deps, { slug: 'my-app', domain: 'assets.myapp.com', off: false });
    expect(t.garage.calls).toEqual(['updateBucket', 'addBucketAlias']);
    expect(t.runner.uploads[0]?.content).toContain(
      'Host(`my-app.web.example.com`) || Host(`assets.myapp.com`)',
    );
    expect(t.store.state.projects['my-app']?.storage?.aliases).toEqual(['assets.myapp.com']);
    const r = await storagePublicCommand(t.deps, { slug: 'my-app', off: true });
    expect(r.publicBaseUrl).toBeUndefined();
    expect(t.garage.calls.slice(2)).toEqual(['removeBucketAlias', 'updateBucket']);
    expect(t.garage.inputs.updateBucket?.[1]).toEqual([
      'b1',
      { websiteAccess: { enabled: false } },
    ]);
    expect(t.runner.calls.map((c) => c.argv.join(' '))).toContain(
      'rm -f /etc/dokploy/traefik/dynamic/dbm-web-my-app.yml',
    );
    expect(t.store.state.projects['my-app']?.storage?.publicBaseUrl).toBeUndefined();
    expect(t.store.state.projects['my-app']?.storage?.aliases).toEqual([]);
  });
  it('rejects an invalid --domain before touching anything', async () => {
    const t = seeded();
    await expect(
      storagePublicCommand(t.deps, { slug: 'my-app', domain: 'x`) || Host(`evil', off: false }),
    ).rejects.toMatchObject({ exitCode: 1 });
    await expect(
      storagePublicCommand(t.deps, { slug: 'my-app', domain: 'Assets.MyApp.com', off: false }),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(t.garage.calls).toEqual([]);
    expect(t.runner.uploads).toEqual([]);
  });
  it('errors for projects without storage', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('a1', { storage: undefined }));
    await expect(storagePublicCommand(t.deps, { slug: 'a1', off: false })).rejects.toMatchObject({
      exitCode: 1,
    });
  });
});

describe('storage cors', () => {
  it('replaces the CORS rule and saves origins', async () => {
    const t = seeded();
    expect(
      await storageCorsCommand(t.deps, { slug: 'my-app', origins: ['https://app.example.com'] }),
    ).toEqual(['https://app.example.com']);
    expect(t.garage.calls).toEqual(['updateBucket']);
    const patch = t.garage.inputs.updateBucket?.[0]?.[1] as {
      corsRules?: Array<{ allowedOrigins: string[] }>;
    };
    expect(patch.corsRules?.[0]?.allowedOrigins).toEqual(['https://app.example.com']);
    expect(t.store.state.projects['my-app']?.storage?.corsOrigins).toEqual([
      'https://app.example.com',
    ]);
  });
});
