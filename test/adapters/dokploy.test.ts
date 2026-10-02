import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeDokployClient } from '../../src/adapters/dokploy.js';

const BASE = 'https://dokploy.test';
const auth = (req: Request) => req.headers.get('x-api-key') === 'tok';

const pgRow = {
  postgresId: 'pg_1',
  name: 'pg-my-app',
  appName: 'pg-my-app-k3j9dq',
  databaseName: 'my_app',
  databaseUser: 'my_app_admin',
  databasePassword: 'x',
  applicationStatus: 'idle',
  dockerImage: 'postgres:18',
};

const server = setupServer(
  http.get(`${BASE}/api/settings.getDokployVersion`, ({ request }) =>
    auth(request) ? HttpResponse.json('v0.30.8') : new HttpResponse(null, { status: 401 }),
  ),
  http.post(`${BASE}/api/project.create`, async ({ request }) => {
    const body = (await request.json()) as { name: string };
    return HttpResponse.json({
      project: { projectId: 'proj_1', name: body.name },
      environment: { environmentId: 'env_1', name: 'production' },
    });
  }),
  http.get(`${BASE}/api/project.all`, () =>
    HttpResponse.json([
      {
        projectId: 'proj_1',
        name: 'dbm',
        environments: [{ environmentId: 'env_1', name: 'production' }],
      },
    ]),
  ),
  http.get(`${BASE}/api/project.one`, ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get('projectId') !== 'proj_1')
      return HttpResponse.json(
        { message: 'Project not found', code: 'NOT_FOUND' },
        { status: 404 },
      );
    return HttpResponse.json({
      projectId: 'proj_1',
      name: 'dbm',
      environments: [
        { environmentId: 'env_1', name: 'production', postgres: [pgRow], compose: [] },
      ],
    });
  }),
  http.post(`${BASE}/api/postgres.create`, async ({ request }) => {
    const body = (await request.json()) as Record<string, string>;
    if (!/^[a-zA-Z0-9]+$/.test(body.databasePassword ?? ''))
      return HttpResponse.json(
        { message: 'Invalid password', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    if (body.appName === 'pg-taken')
      return HttpResponse.json(
        { message: 'Service with this appName already exists', code: 'CONFLICT' },
        { status: 409 },
      );
    return HttpResponse.json({ ...pgRow, appName: `${body.appName}-k3j9dq` });
  }),
  http.post(`${BASE}/api/postgres.update`, () => HttpResponse.json(true)),
  http.post(`${BASE}/api/postgres.deploy`, () => HttpResponse.json(pgRow)),
  http.get(`${BASE}/api/postgres.one`, () =>
    HttpResponse.json({ ...pgRow, applicationStatus: 'done' }),
  ),
  http.post(`${BASE}/api/postgres.stop`, () => HttpResponse.json(pgRow)),
  http.post(`${BASE}/api/postgres.start`, () => HttpResponse.json(pgRow)),
  http.post(`${BASE}/api/postgres.remove`, () => HttpResponse.json(pgRow)),
  http.post(`${BASE}/api/backup.create`, () =>
    HttpResponse.json({ backupId: 'bk_1', appName: pgRow.appName }),
  ),
  http.post(`${BASE}/api/backup.manualBackupPostgres`, () => HttpResponse.json(true)),
  http.get(`${BASE}/api/destination.all`, () =>
    HttpResponse.json([{ destinationId: 'd1', name: 'dbm-dumps', provider: 'Other' }]),
  ),
  http.get(`${BASE}/api/backup.listBackupFiles`, () =>
    HttpResponse.json([
      {
        Path: 'pg-my-app-k3j9dq/db/my-app/2026-09-30T06-03-00-000Z.sql.gz',
        Name: '2026-09-30T06-03-00-000Z.sql.gz',
        Size: 1234,
        ModTime: '2026-09-30T06:03:01Z',
        IsDir: false,
      },
    ]),
  ),
  http.get(`${BASE}/api/organization.all`, () =>
    HttpResponse.json([{ id: 'org_1', name: 'Personal' }]),
  ),
  http.post(`${BASE}/api/user.createApiKey`, async ({ request }) => {
    const body = (await request.json()) as { rateLimitEnabled?: boolean };
    return HttpResponse.json({
      id: 'key_1',
      key: body.rateLimitEnabled === false ? 'dbm_key' : 'limited',
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const client = makeDokployClient({ baseUrl: `${BASE}/`, apiKey: 'tok' });

describe('DokployClient', () => {
  it('sends x-api-key and parses version', async () => {
    expect(await client.getVersion()).toBe('0.30.8');
    await expect(
      makeDokployClient({ baseUrl: BASE, apiKey: 'bad' }).getVersion(),
    ).rejects.toMatchObject({ exitCode: 2, step: 'dokploy.settings.getDokployVersion' });
  });
  it('creates a project and reads it back', async () => {
    expect((await client.listProjects())[0]?.name).toBe('dbm');
    expect(await client.createProject('dbm')).toEqual({
      projectId: 'proj_1',
      environmentId: 'env_1',
    });
    const p = await client.getProject('proj_1');
    expect(p.environments[0]?.postgres[0]?.appName).toBe('pg-my-app-k3j9dq');
    await expect(client.getProject('nope')).rejects.toThrow(/Project not found/);
  });
  it('creates postgres and returns the suffixed appName; surfaces 409 and 400 messages', async () => {
    const input = {
      name: 'pg-my-app',
      appName: 'pg-my-app',
      databaseName: 'my_app',
      databaseUser: 'my_app_admin',
      databasePassword: 'Abc123',
      environmentId: 'env_1',
      dockerImage: 'postgres:18',
    };
    expect((await client.createPostgres(input)).appName).toBe('pg-my-app-k3j9dq');
    await expect(client.createPostgres({ ...input, appName: 'pg-taken' })).rejects.toThrow(
      /already exists/,
    );
    await expect(client.createPostgres({ ...input, databasePassword: 'bad$pw' })).rejects.toThrow(
      /Invalid password/,
    );
  });
  it('deploy is fire-and-confirm: getPostgres reports done', async () => {
    await client.updatePostgres({ postgresId: 'pg_1', memoryLimit: '536870912' });
    await client.deployPostgres('pg_1');
    expect((await client.getPostgres('pg_1')).applicationStatus).toBe('done');
  });
  it('backups', async () => {
    const b = await client.createBackup({
      schedule: '3 6 * * *',
      prefix: 'db/my-app',
      destinationId: 'd1',
      database: 'my_app',
      databaseType: 'postgres',
      postgresId: 'pg_1',
      enabled: true,
      keepLatestCount: 35,
    });
    expect(b.backupId).toBe('bk_1');
    await client.manualBackup('bk_1');
    const files = await client.listBackupFiles('d1', 'pg-my-app-k3j9dq/db/my-app/');
    expect(files[0]?.ModTime).toBe('2026-09-30T06:03:01Z');
    expect(await client.listDestinations()).toEqual([
      { destinationId: 'd1', name: 'dbm-dumps', provider: 'Other' },
    ]);
  });
  it('createBackup falls back to postgres.one when the create response body is empty (live 0.30.8)', async () => {
    server.use(
      http.post(`${BASE}/api/backup.create`, () => new HttpResponse('', { status: 200 })),
      http.get(`${BASE}/api/postgres.one`, () =>
        HttpResponse.json({
          ...pgRow,
          applicationStatus: 'done',
          backups: [
            { backupId: 'bk_other', prefix: 'db/other', database: 'other' },
            { backupId: 'bk_9', prefix: 'db/my-app', database: 'my_app' },
          ],
        }),
      ),
    );
    const b = await client.createBackup({
      schedule: '3 6 * * *',
      prefix: 'db/my-app',
      destinationId: 'd1',
      database: 'my_app',
      databaseType: 'postgres',
      postgresId: 'pg_1',
      enabled: true,
      keepLatestCount: 35,
    });
    expect(b.backupId).toBe('bk_9');
  });
  it('createBackup fails clearly when neither the response nor postgres.one carries the id', async () => {
    server.use(
      http.post(`${BASE}/api/backup.create`, () => new HttpResponse('', { status: 200 })),
      http.get(`${BASE}/api/postgres.one`, () =>
        HttpResponse.json({ ...pgRow, applicationStatus: 'done', backups: [] }),
      ),
    );
    await expect(
      client.createBackup({
        schedule: '3 6 * * *',
        prefix: 'db/my-app',
        destinationId: 'd1',
        database: 'my_app',
        databaseType: 'postgres',
        postgresId: 'pg_1',
        enabled: true,
        keepLatestCount: 35,
      }),
    ).rejects.toMatchObject({ exitCode: 2, step: 'dokploy.backup.create' });
  });
  it('mints an unlimited api key', async () => {
    expect((await client.listOrganizations())[0]?.id).toBe('org_1');
    expect(await client.createApiKey({ name: 'dbm', organizationId: 'org_1' })).toBe('dbm_key');
  });
});
