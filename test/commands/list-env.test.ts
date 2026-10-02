import { describe, expect, it } from 'vitest';
import { envCommand } from '../../src/commands/env.js';
import { formatTable, listCommand } from '../../src/commands/list.js';
import { upsertProject } from '../../src/core/state.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../helpers/project.js';

describe('list', () => {
  it('collects memory, volume, storage and last backup per project', async () => {
    const runner = makeFakeRunner([
      {
        match: /docker stats --no-stream --format/,
        stdout: 'pg-my-app-abc123.1.xyz\t45.2MiB / 512MiB\n',
      },
      {
        match: /docker system df -v --format/,
        stdout: '[{"Name":"pg-my-app-abc123-data","Size":"120.3MB"}]',
      },
    ]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    t.garage.buckets.set('b1', {
      id: 'b1',
      globalAliases: ['my-app'],
      bytes: 2048,
      objects: 3,
      unfinishedUploads: 0,
      websiteAccess: false,
    });
    t.dokploy.files = [
      {
        Path: 'pg-my-app-abc123/db/my-app/2026-09-30T06-03-00-000Z.sql.gz',
        Name: 'x',
        Size: 1,
        ModTime: '2026-09-30T06:03:01Z',
      },
    ];
    const rows = await listCommand(t.deps);
    expect(rows).toEqual([
      {
        slug: 'my-app',
        status: 'running',
        pgMajor: 18,
        memory: '45.2MiB / 512MiB',
        volume: '120.3MB',
        storage: '2.0 KiB (3 objects)',
        lastBackup: '2026-09-30T06:03:01Z',
        createdAt: '2026-09-30T00:00:00.000Z',
      },
    ]);
  });
  it('degrades gracefully when the VPS is unreachable', async () => {
    const runner = makeFakeRunner([{ match: /docker/, fail: true }]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    const rows = await listCommand(t.deps);
    expect(rows[0]?.memory).toBe('?');
  });
  it('formatTable pads columns', () => {
    expect(
      formatTable([
        ['a', 'bbb'],
        ['cc', 'd'],
      ]),
    ).toBe('a   bbb\ncc  d\n');
  });
});

describe('env', () => {
  it('prints env without the admin password and errors on unknown slug', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    const env = await envCommand(t.deps, 'my-app');
    expect(env.DATABASE_URL).toContain('/my-app?sslmode=verify-full');
    expect(JSON.stringify(env)).not.toContain('adminpw');
    await expect(envCommand(t.deps, 'nope')).rejects.toMatchObject({ exitCode: 1 });
  });
});
