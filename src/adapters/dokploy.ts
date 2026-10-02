import { z } from 'zod';
import { remoteError } from '../core/exit.js';
import type {
  BackupFile,
  BackupInput,
  DestinationInput,
  DokployClient,
  DokployPostgres,
  DokployProject,
} from './types.js';

export interface DokployClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}

const PostgresRow = z.looseObject({
  postgresId: z.string(),
  appName: z.string(),
  applicationStatus: z.enum(['idle', 'running', 'done', 'error']),
  databaseName: z.string(),
  databaseUser: z.string(),
});

const ProjectRow = z.looseObject({
  projectId: z.string(),
  name: z.string(),
  environments: z.array(
    z.looseObject({
      environmentId: z.string(),
      name: z.string(),
      postgres: z
        .array(z.looseObject({ postgresId: z.string(), appName: z.string(), name: z.string() }))
        .default([]),
      compose: z
        .array(z.looseObject({ composeId: z.string(), appName: z.string(), name: z.string() }))
        .default([]),
    }),
  ),
});

const DestinationRow = z.looseObject({
  destinationId: z.string(),
  name: z.string(),
  provider: z.string().nullable().default(null),
  accessKey: z.string(),
  secretAccessKey: z.string(),
  bucket: z.string(),
  region: z.string(),
  endpoint: z.string(),
  additionalFlags: z.array(z.string()).nullable().default(null),
});

const DEFAULT_TIMEOUT_MS = 30_000;
const DEPLOY_TIMEOUT_MS = 120_000;

export function makeDokployClient(o: DokployClientOptions): DokployClient {
  const base = o.baseUrl.replace(/\/+$/, '');

  async function call(
    proc: string,
    opts: {
      method?: 'GET' | 'POST';
      query?: Record<string, string>;
      body?: unknown;
      timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    const method = opts.method ?? 'POST';
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
    const mult = Number(process.env.DBM_TIMEOUT_MULTIPLIER ?? '1') || 1;
    let res: Response;
    try {
      // Resolve fetch per call so interceptors installed after client creation (MSW) apply.
      res = await (o.fetchFn ?? fetch)(`${base}/api/${proc}${qs}`, {
        method,
        headers: {
          'x-api-key': o.apiKey,
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) * mult),
      });
    } catch (e) {
      throw remoteError(
        `dokploy ${proc}: ${e instanceof Error ? e.message : String(e)}`,
        `dokploy.${proc}`,
      );
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const msg = (json as { message?: string } | undefined)?.message ?? (text || res.statusText);
      throw remoteError(`dokploy ${proc} -> HTTP ${res.status}: ${msg}`, `dokploy.${proc}`);
    }
    return json;
  }

  return {
    async getVersion() {
      const v = z.string().parse(await call('settings.getDokployVersion', { method: 'GET' }));
      return v.replace(/^v/, '');
    },
    async listOrganizations() {
      return z
        .array(z.looseObject({ id: z.string(), name: z.string() }))
        .parse(await call('organization.all', { method: 'GET' }));
    },
    async createApiKey(input) {
      const r = z.looseObject({ key: z.string() }).parse(
        await call('user.createApiKey', {
          body: {
            name: input.name,
            metadata: { organizationId: input.organizationId },
            rateLimitEnabled: false,
          },
        }),
      );
      return r.key;
    },
    async listProjects() {
      return z
        .array(
          z.looseObject({
            projectId: z.string(),
            name: z.string(),
            environments: z
              .array(z.looseObject({ environmentId: z.string(), name: z.string() }))
              .default([]),
          }),
        )
        .parse(await call('project.all', { method: 'GET' }));
    },
    async createProject(name) {
      const r = z
        .looseObject({
          project: z.looseObject({ projectId: z.string() }),
          environment: z.looseObject({ environmentId: z.string() }),
        })
        .parse(await call('project.create', { body: { name, description: 'Managed by dbm' } }));
      return { projectId: r.project.projectId, environmentId: r.environment.environmentId };
    },
    async getProject(projectId) {
      return ProjectRow.parse(
        await call('project.one', { method: 'GET', query: { projectId } }),
      ) as DokployProject;
    },
    async createPostgres(input) {
      return PostgresRow.parse(await call('postgres.create', { body: input })) as DokployPostgres;
    },
    async updatePostgres(input) {
      await call('postgres.update', { body: input });
    },
    async deployPostgres(postgresId) {
      await call('postgres.deploy', { body: { postgresId }, timeoutMs: DEPLOY_TIMEOUT_MS });
    },
    async getPostgres(postgresId) {
      return PostgresRow.parse(
        await call('postgres.one', { method: 'GET', query: { postgresId } }),
      ) as DokployPostgres;
    },
    async stopPostgres(postgresId) {
      await call('postgres.stop', { body: { postgresId } });
    },
    async startPostgres(postgresId) {
      await call('postgres.start', { body: { postgresId } });
    },
    async removePostgres(postgresId) {
      await call('postgres.remove', { body: { postgresId } });
    },
    async createCompose(input) {
      return z.looseObject({ composeId: z.string(), appName: z.string() }).parse(
        await call('compose.create', {
          body: { ...input, composeType: 'docker-compose', sourceType: 'raw' },
        }),
      );
    },
    async updateCompose(input) {
      await call('compose.update', {
        body: { ...input, sourceType: 'raw', composeType: 'docker-compose' },
      });
    },
    async deployCompose(composeId) {
      await call('compose.deploy', { body: { composeId }, timeoutMs: DEPLOY_TIMEOUT_MS });
    },
    async getCompose(composeId) {
      return z
        .looseObject({
          composeId: z.string(),
          appName: z.string(),
          composeStatus: z.string().default('idle'),
        })
        .parse(await call('compose.one', { method: 'GET', query: { composeId } }));
    },
    async listDestinations() {
      return z
        .array(z.looseObject({ destinationId: z.string(), name: z.string() }))
        .parse(await call('destination.all', { method: 'GET' }));
    },
    async createDestination(input: DestinationInput) {
      return z
        .looseObject({ destinationId: z.string() })
        .parse(await call('destination.create', { body: input }));
    },
    async testDestination(input: DestinationInput) {
      await call('destination.testConnection', { body: input, timeoutMs: 60_000 });
    },
    async getDestination(destinationId) {
      return DestinationRow.parse(
        await call('destination.one', { method: 'GET', query: { destinationId } }),
      );
    },
    async createBackup(input: BackupInput) {
      return z
        .looseObject({ backupId: z.string() })
        .parse(await call('backup.create', { body: { ...input, backupType: 'database' } }));
    },
    async updateBackup(input) {
      await call('backup.update', { body: { ...input, backupType: 'database' } });
    },
    async removeBackup(backupId) {
      await call('backup.remove', { body: { backupId } });
    },
    async manualBackup(backupId) {
      await call('backup.manualBackupPostgres', { body: { backupId }, timeoutMs: 30 * 60_000 });
    },
    async listBackupFiles(destinationId, search) {
      return z
        .array(
          z.looseObject({
            Path: z.string(),
            Name: z.string(),
            Size: z.number(),
            ModTime: z.string(),
          }),
        )
        .parse(
          await call('backup.listBackupFiles', { method: 'GET', query: { destinationId, search } }),
        ) as BackupFile[];
    },
  };
}
