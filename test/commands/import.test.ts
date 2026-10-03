import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyErrors,
  formatReport,
  importCommand,
  importScript,
  PROTECTED_TABLES,
  parseImportOutput,
} from '../../src/commands/import.js';
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
  it('escapes single quotes in URLs', () => {
    const s = importScript({ src: "postgresql://u:p'w@h:5432/d", dst: 'x', schemas: ['public'] });
    expect(s).toContain("SRC='postgresql://u:p'\\''w@h:5432/d'");
  });
  it('iterates tables line by line so names with spaces survive', () => {
    const s = importScript({ src: 'a', dst: 'b', schemas: ['public'] });
    expect(s).toContain('while IFS= read -r t');
    expect(s).not.toContain('for t in $TABLES');
  });
  it('fails fast when a dump fails', () => {
    const s = importScript({ src: 'a', dst: 'b', schemas: ['public'] });
    // table listing + two dumps
    expect(s.match(/---DUMP-FAILED---/g)).toHaveLength(6);
  });
  it('rejects invalid schema names', () => {
    expect(() => importScript({ src: 'a', dst: 'b', schemas: ['public; rm -rf /'] })).toThrow(
      /schema/,
    );
  });
});

describe('importScript options', () => {
  const base = {
    src: 'postgresql://u:p@h:5432/d',
    dst: 'postgresql://a:b@c:5432/e',
    schemas: ['public'],
  };
  it('lists tables once, dumps schema+data, prints policies and counts by default', () => {
    const s = importScript(base);
    expect(s).toContain(
      `TABLES=$(psql "$SRC" -Atc "select format('%I.%I', schemaname, tablename) from pg_tables where schemaname in ('public') order by 1")`,
    );
    expect(s).toContain('--schema-only');
    expect(s).toContain("grep -E '^CREATE POLICY'");
    expect(s).toContain('---POLICIES---');
    expect(s).toContain('---COUNTS---');
    expect(s).not.toContain('TRUNCATE');
  });
  it('--data-only skips the schema dump/restore and the policies section', () => {
    const s = importScript({ ...base, dataOnly: true });
    expect(s).not.toContain('--schema-only');
    expect(s).not.toContain('---POLICIES---');
    expect(s).toContain('---DATA-ERRORS---');
  });
  it('--replace truncates in one CASCADE-free statement, excluding every protected table in any schema', () => {
    const s = importScript({ ...base, replace: true });
    expect(s).toContain('---REPLACE---');
    expect(s).toContain(
      "tablename not in ('user','session','account','verification','rateLimit','__drizzle_migrations')",
    );
    for (const p of PROTECTED_TABLES) expect(s).toContain(`'${p}'`);
    expect(s).toContain("format('(%L,%L)', schemaname, tablename)");
    expect(s).toContain('(schemaname, tablename) in (values $SRC_ROWS)');
    expect(s.match(/tablename not in \('user'/g)).toHaveLength(2);
    expect(s).toContain('TRUNCATE TABLE $REPLACE_TABLES RESTART IDENTITY"');
    expect(s).not.toContain('CASCADE');
    expect(s).toContain("echo '---REPLACE-FAILED---'; exit 1");
    expect(s).toContain("echo '---REPLACE-FAILED---' >&2");
    expect(s.indexOf('---REPLACE-FAILED---')).toBeLessThan(s.indexOf('---DATA-ERRORS---'));
  });
  it('quotes multiple schema names in the pg_tables filter', () => {
    expect(importScript({ ...base, schemas: ['public', 'app'] })).toContain(
      "schemaname in ('public','app')",
    );
  });
});

describe('parseImportOutput', () => {
  it('extracts error sections, counts (with missing target as null) and policies', () => {
    const out = [
      '---SCHEMA-ERRORS---',
      'psql:x: ERROR:  relation "auth.users" does not exist',
      '---POLICIES---',
      'public.items: items_owner',
      'public.items: items_admin',
      '---REPLACE---',
      '---DATA-ERRORS---',
      '---COUNTS---',
      'public.items\t12\t12',
      'public.profiles\t3\t-',
      'public."Mixed"\t1\t1',
      'public."My Table"\t2\t2',
      '---END---',
    ].join('\n');
    const r = parseImportOutput(out);
    expect(r.schemaErr).toContain('auth.users');
    expect(r.policies).toEqual(['public.items: items_owner', 'public.items: items_admin']);
    expect(r.counts).toEqual([
      { table: 'public.items', source: 12, target: 12 },
      { table: 'public.profiles', source: 3, target: null },
      { table: 'public."Mixed"', source: 1, target: 1 },
      { table: 'public."My Table"', source: 2, target: 2 },
    ]);
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
        match:
          /rclone\/rclone:1 --config \/dev\/stdin copy src:avatars dst:my-app\/avatars --size-only/,
        stdout: '',
        once: true,
      },
      {
        match: /rclone\/rclone:1 --config \/dev\/stdin copy src:docs dst:my-app\/docs --size-only/,
        stdout: '',
        once: true,
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
        buckets: ['avatars', 'docs'],
      },
    });
    expect(r.errors.authUsers).toHaveLength(1);
    expect(r.storageSynced).toBe(true);
    expect(r.storageBuckets).toEqual(['avatars', 'docs']);
    const rcs = t.runner.calls.filter((c) => c.argv.includes('rclone/rclone:1'));
    // one copy per bucket, each under its own prefix so keys never collide
    expect(rcs.map((c) => c.argv[c.argv.indexOf('copy') + 2])).toEqual([
      'dst:my-app/avatars',
      'dst:my-app/docs',
    ]);
    for (const rc of rcs) {
      // copy, never sync: objects already in the target bucket must survive an import
      expect(rc.argv).toContain('copy');
      expect(rc.argv).not.toContain('sync');
    }
    expect(formatReport(r)).toContain('storage copied: avatars, docs');
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
        storage: { endpoint: 'ftp://x', region: 'r', keyId: 'K', keySecret: 'S', buckets: ['b'] },
      }),
    ).rejects.toThrow(/endpoint/);
  });
  it('rejects bucket names that would change the rclone path', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    for (const bad of ['a/b', '../x', '', 'with space', '-dash']) {
      await expect(
        importCommand(t.deps, {
          slug: 'my-app',
          from: 'postgresql://u:p@db.x.supabase.co:5432/postgres',
          storage: {
            endpoint: 'https://x',
            region: 'r',
            keyId: 'K',
            keySecret: 'S',
            buckets: [bad],
          },
        }),
      ).rejects.toMatchObject({ exitCode: 1, step: 'import.storage' });
    }
    expect(t.runner.calls).toHaveLength(0);
  });
  it('keeps Supabase storage keys out of rclone argv', async () => {
    const runner = makeFakeRunner([
      { match: /bash -s/, stdout: '---SCHEMA-ERRORS---\n---DATA-ERRORS---\n---END---' },
    ]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    await importCommand(t.deps, {
      slug: 'my-app',
      from: 'postgresql://u:p@db.x.supabase.co:5432/postgres',
      storage: { endpoint: 'https://x', region: 'r', keyId: 'K', keySecret: 'S', buckets: ['b'] },
    });
    const call = t.runner.calls.find((c) => c.argv.join(' ').includes('rclone'));
    expect(call?.argv).not.toContain('K');
    expect(call?.argv).not.toContain('S');
    expect(call?.input).toContain('access_key_id = K');
    expect(call?.input).toContain('secret_access_key = S');
  });
  it('fails with exit 2 when the dump container fails', async () => {
    const runner = makeFakeRunner([{ match: /bash -s/, stdout: '---DUMP-FAILED---', fail: true }]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    await expect(
      importCommand(t.deps, { slug: 'my-app', from: 'postgresql://u:p@h:5432/d' }),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('pg_dump/psql failed'),
    });
  });
  it('fails when the script aborts with REPLACE-FAILED (no END marker)', async () => {
    const runner = makeFakeRunner([
      {
        match: /bash -s/,
        stdout:
          '---REPLACE---\nERROR:  cannot truncate a table referenced in a foreign key\n---REPLACE-FAILED---\n',
      },
    ]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    await expect(
      importCommand(t.deps, { slug: 'my-app', from: 'postgresql://u:p@h:5432/d' }),
    ).rejects.toThrow(/REPLACE-FAILED/);
  });
  it('fails when the END marker is missing', async () => {
    const runner = makeFakeRunner([{ match: /bash -s/, stdout: '---SCHEMA-ERRORS---\n' }]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    await expect(
      importCommand(t.deps, { slug: 'my-app', from: 'postgresql://u:p@h:5432/d' }),
    ).rejects.toThrow(/END marker/);
  });
});

const OUT_OK =
  '---SCHEMA-ERRORS---\n---POLICIES---\npublic.items: items_owner\n---DATA-ERRORS---\n---COUNTS---\npublic.items\t2\t2\npublic.gone\t5\t-\n---END---';

describe('importCommand v2', () => {
  it('returns counts, policies and mismatches in the report', async () => {
    const runner = makeFakeRunner([{ match: /bash -s/, stdout: OUT_OK }]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    const r = await importCommand(t.deps, { slug: 'my-app', from: 'postgresql://u:p@h:5432/d' });
    expect(r.counts).toHaveLength(2);
    expect(r.rlsPolicies).toEqual(['public.items: items_owner']);
    expect(r.mismatched).toEqual(['public.gone']);
    expect(r.usersExported).toBeNull();
    const text = formatReport(r);
    expect(text).toMatch(/public\.items\s+2\s+2/);
    expect(text).toMatch(/public\.gone.*MISMATCH/);
    expect(text).toContain('RLS policies to re-implement in server code (1)');
    expect(text).toContain('COUNT MISMATCH in: public.gone');
  });
  it('--replace requires confirmation and passes replace/dataOnly into the script', async () => {
    const runner = makeFakeRunner([{ match: /bash -s/, stdout: OUT_OK }]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    t.deps.confirm = async () => false;
    await expect(
      importCommand(t.deps, {
        slug: 'my-app',
        from: 'postgresql://u:p@h:5432/d',
        replace: true,
        yes: false,
      }),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(t.runner.calls).toHaveLength(0);
    await importCommand(t.deps, {
      slug: 'my-app',
      from: 'postgresql://u:p@h:5432/d',
      replace: true,
      dataOnly: true,
      yes: true,
      confirmSlug: 'my-app',
    });
    const script = t.runner.calls[0]?.input ?? '';
    expect(script).toContain('---REPLACE---');
    expect(script).not.toContain('--schema-only');
  });
  it('--users-out exports auth.users to a 0600 CSV without printing it', async () => {
    const csv = 'id,email,encrypted_password\n1,a@b.c,$2a$10$x\n';
    const runner = makeFakeRunner([
      { match: /bash -s/, stdout: OUT_OK, once: true },
      { match: /bash -s/, stdout: csv, once: true },
    ]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    const dir = await mkdtemp(join(tmpdir(), 'dbm-users-'));
    const file = join(dir, 'auth-users.csv');
    const r = await importCommand(t.deps, {
      slug: 'my-app',
      from: 'postgresql://u:p@h:5432/d',
      usersOut: file,
    });
    expect(r.usersExported).toBe(1);
    expect(await readFile(file, 'utf8')).toBe(csv);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(t.outLines.join('') + t.errLines.join('')).not.toContain('$2a$10$x');
    const exportCall = t.runner.calls[1];
    expect(exportCall?.input).toContain('COPY (');
    expect(exportCall?.input).toContain(
      'FROM auth.users WHERE email IS NOT NULL AND deleted_at IS NULL',
    );
  });
  it('--users-out on a source without an auth schema is a clear remote error', async () => {
    const runner = makeFakeRunner([
      { match: /bash -s/, stdout: OUT_OK, once: true },
      {
        match: /bash -s/,
        fail: true,
        stderr: 'ERROR:  relation "auth.users" does not exist',
        once: true,
      },
    ]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    await expect(
      importCommand(t.deps, {
        slug: 'my-app',
        from: 'postgresql://u:p@h:5432/d',
        usersOut: '/tmp/x.csv',
      }),
    ).rejects.toMatchObject({ exitCode: 2, step: 'import.users', message: /auth\.users/ });
  });
});
