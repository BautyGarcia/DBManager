import { describe, expect, it } from 'vitest';
import { classifyErrors, importCommand, importScript } from '../../src/commands/import.js';
import { upsertProject } from '../../src/core/state.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../helpers/project.js';

describe('classifyErrors', () => {
  it('groups psql errors by Supabase-specific cause', () => {
    const stderr = [
      'psql:/tmp/schema.sql:12: ERROR:  relation "auth.users" does not exist',
      'psql:/tmp/schema.sql:30: ERROR:  function auth.uid() does not exist',
      'psql:/tmp/schema.sql:44: ERROR:  relation "storage.objects" does not exist',
      'psql:/tmp/schema.sql:50: ERROR:  schema "extensions" does not exist',
      'psql:/tmp/schema.sql:60: ERROR:  type "vector" does not exist',
    ].join('\n');
    const e = classifyErrors(stderr);
    expect(e.authUsers).toHaveLength(1);
    expect(e.authUid).toHaveLength(1);
    expect(e.storageObjects).toHaveLength(1);
    expect(e.extensions).toHaveLength(1);
    expect(e.other).toEqual(['psql:/tmp/schema.sql:60: ERROR:  type "vector" does not exist']);
  });
});

describe('importScript', () => {
  it('dumps schema and data separately with the right flags and restores as the app role', () => {
    const s = importScript({
      src: 'postgresql://postgres:pw@db.ref.supabase.co:5432/postgres',
      dst: 'postgresql://my_app_app:pw@pg-my-app-abc123:5432/my_app',
      schemas: ['public', 'extra'],
    });
    expect(s).toContain(
      '--schema-only --no-owner --no-privileges --no-comments --no-publications --no-subscriptions --schema=public --schema=extra',
    );
    expect(s).toContain('--data-only --no-owner --no-privileges --schema=public --schema=extra');
    expect(s).toContain('SET session_replication_role = replica');
    expect(s).toContain('---SCHEMA-ERRORS---');
    expect(s).toContain('---DATA-ERRORS---');
    expect(s).not.toContain('6543');
  });
  it('rejects invalid schema names', () => {
    expect(() => importScript({ src: 'a', dst: 'b', schemas: ['public; rm -rf /'] })).toThrow(
      /schema/,
    );
  });
});

describe('importCommand', () => {
  it('runs the script in a throwaway postgres:18 container with URLs on stdin and parses the report', async () => {
    const runner = makeFakeRunner([
      {
        match: /docker run --rm -i --network dokploy-network postgres:18 bash -s/,
        stdout:
          '---SCHEMA-ERRORS---\npsql:x: ERROR:  relation "auth.users" does not exist\n---DATA-ERRORS---\n---END---',
      },
      {
        match: /rclone\/rclone:1 --config \/dev\/stdin sync src:avatars dst:my-app/,
        stdout: '',
      },
    ]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    const r = await importCommand(t.deps, {
      slug: 'my-app',
      from: 'postgresql://postgres:pw@db.ref.supabase.co:5432/postgres',
      storage: {
        endpoint: 'https://ref.storage.supabase.co/storage/v1/s3',
        region: 'us-east-1',
        keyId: 'K',
        keySecret: 'S',
        bucket: 'avatars',
      },
    });
    expect(r.errors.authUsers).toHaveLength(1);
    expect(r.storageSynced).toBe(true);
    const dump = t.runner.calls.find((c) => c.argv.join(' ').includes('bash -s'));
    expect(dump?.argv.join(' ')).not.toContain('pw@');
    expect(dump?.input).toContain('db.ref.supabase.co');
    expect(dump?.input).toContain('postgresql://my_app_app:apppw@pg-my-app-abc123:5432/my_app');
  });
  it('rejects the transaction pooler port', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    await expect(
      importCommand(t.deps, {
        slug: 'my-app',
        from: 'postgresql://u:p@aws-0-x.pooler.supabase.com:6543/postgres',
      }),
    ).rejects.toThrow(/6543/);
  });
  it('rejects a non-http storage endpoint', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    await expect(
      importCommand(t.deps, {
        slug: 'my-app',
        from: 'postgresql://u:p@db.x.supabase.co:5432/postgres',
        storage: { endpoint: 'ftp://x', region: 'r', keyId: 'K', keySecret: 'S', bucket: 'b' },
      }),
    ).rejects.toThrow(/endpoint/);
  });
});
