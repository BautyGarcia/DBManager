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
import { renderPgbouncerIni, renderUserlist } from '../../src/core/pgbouncer.js';
import { scramSha256Verifier } from '../../src/core/scram.js';
import { createDatabaseSql, createRoleSql, extensionsSql } from '../../src/core/sql.js';
import type { Project } from '../../src/core/state.js';
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
    // Section 19 item 7: if this call fails with a schema error, read components.schemas in
    // https://garagehq.deuxfleurs.fr/api/garage-admin-v2.json and fix the key casing in GarageCorsRule.
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
