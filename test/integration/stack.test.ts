import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { execa } from 'execa';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeGarageAdmin } from '../../src/adapters/garage.js';
import { makePostgresAdmin } from '../../src/adapters/postgres.js';
import { restoreScript } from '../../src/commands/backup.js';
import { emptyBucket } from '../../src/commands/destroy.js';
import { importScript, parseImportOutput } from '../../src/commands/import.js';
import { renderPgbouncerIni, renderUserlist } from '../../src/core/pgbouncer.js';
import { scramSha256Verifier } from '../../src/core/scram.js';
import { createDatabaseSql, createRoleSql, extensionsSql } from '../../src/core/sql.js';
import type { Project } from '../../src/core/state.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { caPem, testConfig, testRunner } from './testcfg.js';

const admin = { appName: 'dbm-test-pg', role: 'test_admin', database: 'test_db' };
const APP_PW = 'correct-horse-battery-staple';
const pgAdmin = makePostgresAdmin(testRunner, { network: 'dbmtest', clientImage: 'postgres:18' });
const garage = makeGarageAdmin(testRunner, { port: 53903, token: 'testadmintoken' });

function project(verifier: string): Project {
  return {
    slug: 'my-app',
    createdAt: new Date().toISOString(),
    status: 'running',
    pgMajor: 18,
    dokploy: { postgresId: 'pg_1', appName: 'dbm-test-pg' },
    postgres: {
      database: 'my_app',
      appRole: 'my_app_app',
      appPassword: APP_PW,
      appScramVerifier: verifier,
      adminRole: 'test_admin',
      adminPassword: 'adminpw',
      extensions: ['pgcrypto', 'uuid-ossp'],
      memoryBytes: 536870912,
    },
    betterAuthSecret: 'x',
  };
}

async function client(database: string) {
  const c = new pg.Client({
    host: '127.0.0.1',
    port: 56432,
    user: 'my_app_app',
    password: APP_PW,
    database,
    ssl: { ca: caPem(), servername: 'localhost' },
  });
  await c.connect();
  return c;
}

async function waitFor(fn: () => Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('timeout waiting');
}

describe('postgres + pgbouncer', () => {
  let verifier: string;
  beforeAll(async () => {
    await waitFor(() => pgAdmin.ping(admin));
    verifier = scramSha256Verifier(APP_PW);
    await pgAdmin.runSql(
      admin,
      `${createRoleSql('my_app_app', verifier)}\n${createDatabaseSql('my_app', 'my_app_app')}`,
    );
    await pgAdmin.runSql(
      { ...admin, database: 'my_app' },
      extensionsSql(['pgcrypto', 'uuid-ossp']),
    );
    const p = project(verifier);
    await testRunner.upload(
      `${testConfig.remote.pgbouncerConfDir}/pgbouncer.ini`,
      renderPgbouncerIni([p], { certDir: '/certs/db.test.local' }),
      { mode: '0644' },
    );
    await testRunner.upload(
      `${testConfig.remote.pgbouncerConfDir}/userlist.txt`,
      renderUserlist([p]),
      { mode: '0644' },
    );
    await testRunner.run(['docker', 'kill', '-s', 'HUP', testConfig.remote.pgbouncerContainer]);
    await new Promise((r) => setTimeout(r, 500));
  });

  it('logs in through PgBouncer with SCRAM + TLS using the locally computed verifier, transaction mode', async () => {
    const c = await client('my-app');
    expect((await c.query('select 1 as n')).rows[0]).toEqual({ n: 1 });
    expect((await c.query('select current_database() as d')).rows[0]).toEqual({ d: 'my_app' });
    await c.end();
  });

  it('protocol-level prepared statements work in transaction mode (max_prepared_statements=200)', async () => {
    const c = await client('my-app');
    for (let i = 0; i < 5; i++) {
      const r = await c.query({ name: 'q1', text: 'select $1::int as n', values: [i] });
      expect(r.rows[0]).toEqual({ n: i });
    }
    await c.end();
  });

  it('session alias routes to the same database in session mode', async () => {
    const c = await client('my-app_session');
    expect((await c.query('select current_database() as d')).rows[0]).toEqual({ d: 'my_app' });
    await c.end();
  });

  it('pingViaPgbouncer from inside the docker network', async () => {
    // sslmode=require: the throwaway psql container has no CA; app-facing URLs use verify-full.
    expect(
      await pgAdmin.pingViaPgbouncer(
        `postgresql://my_app_app:${APP_PW}@dbm-test-pgbouncer:6432/my-app?sslmode=require`,
      ),
    ).toBe(true);
  });

  it('drizzle-kit push works through the session alias', async () => {
    // Under the repo (R6) so drizzle-kit can resolve drizzle-orm from node_modules.
    const tmpRoot = join(process.cwd(), 'test', 'integration', '.tmp');
    await mkdir(tmpRoot, { recursive: true });
    const dir = await mkdtemp(join(tmpRoot, 'drizzle-'));
    try {
      await writeFile(
        join(dir, 'schema.ts'),
        `import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
export const notes = pgTable('notes', { id: uuid('id').primaryKey().defaultRandom(), body: text('body').notNull() });
`,
      );
      await writeFile(join(dir, 'ca.pem'), caPem());
      await writeFile(
        join(dir, 'drizzle.config.ts'),
        `import { readFileSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: '${join(dir, 'schema.ts')}',
  out: '${join(dir, 'out')}',
  dbCredentials: { host: '127.0.0.1', port: 56432, user: 'my_app_app', password: '${APP_PW}', database: 'my-app_session',
    ssl: { ca: readFileSync('${join(dir, 'ca.pem')}', 'utf8'), servername: 'localhost' } },
});
`,
      );
      const r = await execa(
        'npx',
        ['drizzle-kit', 'push', '--force', '--config', join(dir, 'drizzle.config.ts')],
        { reject: false, cwd: process.cwd() },
      );
      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
      const c = await client('my-app');
      expect((await c.query("select to_regclass('public.notes') as t")).rows[0]).toEqual({
        t: 'notes',
      });
      await c.end();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rmdir(tmpRoot).catch(() => {}); // only succeeds once empty
    }
  });
});

describe('restore pipeline (C3)', () => {
  const pgc = 'dbm-test-pg';
  beforeAll(async () => {
    await waitFor(() => pgAdmin.ping(admin));
  });

  it('restores a superuser-made dump (with extension entries) as the app role and exits 0', async () => {
    await pgAdmin.runSql(
      { ...admin, database: 'my_app' },
      `CREATE TABLE restore_rows (id int PRIMARY KEY, v text NOT NULL, h bytea DEFAULT digest('x', 'sha256'));
INSERT INTO restore_rows (id, v) VALUES (1, 'one'), (2, 'two'), (3, 'three');
`,
    );
    // Same shape as Dokploy's backups: pg_dump -Fc as the superuser, gzipped.
    await testRunner.run([
      'docker',
      'exec',
      pgc,
      'sh',
      '-c',
      'pg_dump -U test_admin -Fc my_app | gzip > /tmp/src.dump.gz',
    ]);
    const toc = await testRunner.run([
      'docker',
      'exec',
      pgc,
      'sh',
      '-c',
      'gunzip -c /tmp/src.dump.gz > /tmp/toc.dump && pg_restore -l /tmp/toc.dump; rm -f /tmp/toc.dump',
    ]);
    // The dump carries the extension entries the app role cannot drop or comment on.
    expect(toc.stdout).toMatch(/EXTENSION - pgcrypto/);
    // Fresh target owned by the app role; extensions installed by the admin, as `dbm create` does.
    await pgAdmin.runSql(admin, createDatabaseSql('restored', 'my_app_app'));
    await pgAdmin.runSql({ ...admin, database: 'restored' }, extensionsSql(['pgcrypto']));

    const script = restoreScript({
      network: testConfig.remote.dockerNetwork,
      bucket: 'unused',
      objectPath: 'unused',
      container: pgc,
      appRole: 'my_app_app',
      database: 'restored',
      source: `docker exec ${pgc} cat /tmp/src.dump.gz`,
    });
    const r = await testRunner.run(['sh', '-c', script], { timeoutMs: 120_000 });
    expect(r.stderr).not.toMatch(/ERROR|errors ignored/);

    const rows = await pgAdmin.runSql(
      { ...admin, database: 'restored' },
      "select string_agg(id || ':' || v, ',' order by id) from restore_rows;\nselect tableowner from pg_tables where tablename = 'restore_rows';\nselect count(*) from pg_extension where extname = 'pgcrypto';\n",
    );
    expect(rows.trim().split('\n')).toEqual(['1:one,2:two,3:three', 'my_app_app', '1']);
    // Scratch files are removed from the container.
    const left = await testRunner.run([
      'docker',
      'exec',
      pgc,
      'sh',
      '-c',
      'ls /tmp/dbm-restore.dump /tmp/dbm-restore.list 2>/dev/null | wc -l',
    ]);
    expect(left.stdout.trim()).toBe('0');

    // Restoring again over existing objects (--clean --if-exists) also exits 0.
    await testRunner.run(['sh', '-c', script], { timeoutMs: 120_000 });
    const again = await pgAdmin.runSql(
      { ...admin, database: 'restored' },
      'select count(*) from restore_rows;',
    );
    expect(again.trim()).toBe('3');
    await testRunner.run(['docker', 'exec', pgc, 'rm', '-f', '/tmp/src.dump.gz']);
  });

  it('a failing pg_restore makes the pipeline exit non-zero and still cleans up', async () => {
    const script = restoreScript({
      network: testConfig.remote.dockerNetwork,
      bucket: 'unused',
      objectPath: 'unused',
      container: pgc,
      appRole: 'my_app_app',
      database: 'restored',
      source: 'printf garbage | gzip',
    });
    await expect(testRunner.run(['sh', '-c', script])).rejects.toThrow();
    const left = await testRunner.run([
      'docker',
      'exec',
      pgc,
      'sh',
      '-c',
      'ls /tmp/dbm-restore.dump /tmp/dbm-restore.list 2>/dev/null | wc -l',
    ]);
    expect(left.stdout.trim()).toBe('0');
  });
});

describe('garage', () => {
  let s3: S3Client;
  let bucketId = '';
  let keyId = '';

  beforeAll(async () => {
    await waitFor(() => garage.health(), 120_000);
  });

  it('creates bucket, key, permissions and CORS through admin v2', async () => {
    const b = await garage.createBucket('my-app');
    bucketId = b.id;
    const k = await garage.createKey('my-app-key');
    keyId = k.accessKeyId;
    await garage.allowBucketKey(bucketId, keyId, { read: true, write: true });
    await garage.updateBucket(bucketId, {
      corsRules: [
        {
          allowedOrigins: ['*'],
          allowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
          allowedHeaders: ['*'],
          exposeHeaders: ['ETag'],
          maxAgeSeconds: 3600,
        },
      ],
    });
    const info = await garage.getBucket({ globalAlias: 'my-app' });
    expect(info?.id).toBe(bucketId);
    // Same settings as templates/nextjs/lib/s3.ts, constructed once the key exists.
    s3 = new S3Client({
      endpoint: 'http://127.0.0.1:53900',
      region: 'garage',
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: { accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey },
    });
  });

  it('presigned PUT and GET with the template S3Client settings', async () => {
    const put = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: 'my-app', Key: 'hello.txt', ContentType: 'text/plain' }),
      { expiresIn: 300 },
    );
    const r1 = await fetch(put, {
      method: 'PUT',
      body: 'hello garage',
      headers: { 'content-type': 'text/plain' },
    });
    expect(r1.status, await r1.text()).toBe(200);
    const get = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: 'my-app', Key: 'hello.txt' }),
      { expiresIn: 300 },
    );
    const r2 = await fetch(get);
    expect(await r2.text()).toBe('hello garage');
    const pre = await fetch(put, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example.com', 'access-control-request-method': 'PUT' },
    });
    expect(pre.headers.get('access-control-allow-origin')).toBeTruthy();
  });

  it('empties and deletes the bucket, then the key', async () => {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: 'my-app' }));
    for (const o of list.Contents ?? [])
      await s3.send(new DeleteObjectCommand({ Bucket: 'my-app', Key: o.Key ?? '' }));
    await garage.cleanupIncompleteUploads(bucketId);
    await garage.deleteBucket(bucketId);
    await garage.deleteKey(keyId);
    expect(await garage.getBucket({ globalAlias: 'my-app' })).toBeUndefined();
  });
});

describe('destroy --purge-storage emptyBucket (C1)', () => {
  beforeAll(async () => {
    await waitFor(() => garage.health(), 120_000);
  });

  it('empties the bucket with the read+write project key, then the admin API deletes it', async () => {
    const b = await garage.createBucket('purge-me');
    const k = await garage.createKey('purge-me-key');
    // Exactly what `dbm create` grants: read + write, no owner.
    await garage.allowBucketKey(b.id, k.accessKeyId, { read: true, write: true });
    const s3 = new S3Client({
      endpoint: 'http://127.0.0.1:53900',
      region: 'garage',
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: { accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey },
    });
    for (const key of ['a.txt', 'dir/b.txt'])
      await s3.send(new PutObjectCommand({ Bucket: 'purge-me', Key: key, Body: key }));
    expect((await s3.send(new ListObjectsV2Command({ Bucket: 'purge-me' }))).KeyCount).toBe(2);

    const { deps } = makeTestDeps({ cfg: testConfig, ssh: testRunner, garage });
    const p: Project = {
      ...project('x'),
      slug: 'purge-me',
      storage: {
        bucketId: b.id,
        bucket: 'purge-me',
        keyId: k.accessKeyId,
        keySecret: k.secretAccessKey,
        corsOrigins: ['*'],
        aliases: [],
      },
    };
    await emptyBucket(deps, p);

    const after = await s3.send(new ListObjectsV2Command({ Bucket: 'purge-me' }));
    expect(after.KeyCount ?? 0).toBe(0);
    expect(after.Contents ?? []).toEqual([]);
    await garage.cleanupIncompleteUploads(b.id);
    await garage.deleteBucket(b.id);
    expect(await garage.getBucket({ id: b.id })).toBeUndefined();
    await garage.deleteKey(k.accessKeyId);
  });
});

// Relies on the first describe's beforeAll having created my_app / my_app_app.
describe('import (rehearsal, then cutover --data-only --replace)', () => {
  const SRC = 'postgresql://test_admin:adminpw@dbm-test-pg:5432/src_db';
  const DST = `postgresql://my_app_app:${encodeURIComponent(APP_PW)}@dbm-test-pg:5432/my_app`;
  async function runImport(opts: { dataOnly?: boolean; replace?: boolean }) {
    const r = await testRunner.run(
      ['docker', 'run', '--rm', '-i', '--network', 'dbmtest', 'postgres:18', 'bash', '-s'],
      {
        input: importScript({ src: SRC, dst: DST, schemas: ['public'], ...opts }),
        timeoutMs: 180_000,
      },
    );
    expect(r.stdout, r.stdout).toContain('---END---');
    return parseImportOutput(r.stdout);
  }
  beforeAll(async () => {
    await pgAdmin.runSql(admin, `DROP DATABASE IF EXISTS src_db; CREATE DATABASE src_db;`);
    await pgAdmin.runSql(
      { ...admin, database: 'src_db' },
      `
      CREATE TABLE items (id serial PRIMARY KEY, name text NOT NULL);
      CREATE TABLE "user" (id text PRIMARY KEY, email text);
      INSERT INTO "user" VALUES ('s1', 'source@x.test');
      CREATE TABLE profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), display_name text);
      ALTER TABLE items ENABLE ROW LEVEL SECURITY;
      CREATE POLICY items_owner ON items USING (true);
      INSERT INTO items (name) VALUES ('a'), ('b'), ('c');
      INSERT INTO profiles (display_name) VALUES ('p1');`,
    );
    // the app role needs the same grant create.ts gives in production
    await pgAdmin.runSql(admin, `GRANT SET ON PARAMETER session_replication_role TO my_app_app;`);
    // better-auth-like table that must survive --replace
    await pgAdmin.runSql(
      { ...admin, database: 'my_app' },
      `
      DROP TABLE IF EXISTS "user"; CREATE TABLE "user" (id text PRIMARY KEY, email text);
      ALTER TABLE "user" OWNER TO my_app_app;
      INSERT INTO "user" VALUES ('u1', 'keep@me.test');
      DROP TABLE IF EXISTS items; DROP TABLE IF EXISTS profiles;`,
    );
  });

  it('rehearsal: schema + data land, policies are reported, counts match', async () => {
    const r = await runImport({});
    expect(r.schemaErr).toContain('already exists'); // target already has "user"
    expect(r.policies).toEqual(['public.items: items_owner']);
    expect(r.counts).toEqual(
      expect.arrayContaining([
        { table: 'public.items', source: 3, target: 3 },
        { table: 'public.profiles', source: 1, target: 1 },
      ]),
    );
  });

  it('cutover: --data-only --replace reloads changed data without duplicates and keeps "user" rows', async () => {
    await pgAdmin.runSql(
      { ...admin, database: 'src_db' },
      `INSERT INTO items (name) VALUES ('d'); DELETE FROM profiles;`,
    );
    const r = await runImport({ dataOnly: true, replace: true });
    expect(r.policies).toEqual([]);
    expect(r.counts).toEqual(
      expect.arrayContaining([
        { table: 'public.items', source: 4, target: 4 },
        { table: 'public.profiles', source: 0, target: 0 },
      ]),
    );
    // u1 survives only if the protected filter kept "user" out of the TRUNCATE;
    // s1 was copied by the rehearsal and is rejected as a duplicate on reload (no extra rows).
    const users = await pgAdmin.runSql(
      { ...admin, database: 'my_app' },
      `select id from "user" order by 1;`,
    );
    expect(users.trim().split('\n')).toEqual(['s1', 'u1'].sort());
  });
});
