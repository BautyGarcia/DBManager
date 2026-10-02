import type { InitProgress, StateStore } from '../../src/adapters/store.js';
import type {
  BackupFile,
  BackupInput,
  DestinationInput,
  DokployClient,
  DokployPostgres,
  DokployProject,
  GarageAdmin,
  GarageBucketInfo,
  GarageCorsRule,
  GaragePermissions,
  PgTarget,
  PostgresAdmin,
  PostgresStatus,
} from '../../src/adapters/types.js';
import type { Io } from '../../src/cli.js';
import type { Deps } from '../../src/commands/context.js';
import { type Config, type ConfigInput, ConfigSchema } from '../../src/core/config.js';
import { DbmError, ExitCode } from '../../src/core/exit.js';
import { emptyState, type Project, type State, upsertProject } from '../../src/core/state.js';
import { makeFakeRunner } from './fake-runner.js';

export const testConfigInput: ConfigInput = {
  sshHost: 'vps',
  dokployUrl: 'https://vps.tail.ts.net',
  dokployApiKey: 'k',
  dokployProjectId: 'proj_1',
  dokployEnvironmentId: 'env_1',
  domain: 'example.com',
  dbHost: 'db.example.com',
  s3Host: 's3.example.com',
  webDomain: 'web.example.com',
  garageAdminToken: 't',
  garageBackupKeyId: 'GKbackup',
  dumpsDestinationId: 'd1',
};

export function fail(step: string, msg = 'boom'): never {
  throw new DbmError(msg, ExitCode.RemoteFailure, step);
}

/** What the real APIs answer for an unknown id: a remote failure whose message says "not found". */
export function notFound(step: string, what: string): never {
  throw new DbmError(`${what} not found`, ExitCode.RemoteFailure, step);
}

export class FakeDokploy implements DokployClient {
  calls: string[] = [];
  /** Arguments of every call, keyed by method name; one tuple per call. */
  inputs: Record<string, unknown[][]> = {};
  private record(method: string, ...args: unknown[]) {
    this.inputs[method] = [...(this.inputs[method] ?? []), args];
  }
  postgres = new Map<
    string,
    DokployPostgres & { status: PostgresStatus; volumeExists: boolean; running: boolean }
  >();
  backups = new Map<string, BackupInput>();
  files: BackupFile[] = [];
  existingNames = new Set<string>();
  failAt = new Set<string>();
  deploysUntilDone = 1;
  private n = 0;
  private guard(step: string) {
    this.calls.push(step);
    if (this.failAt.has(step)) fail(`dokploy.${step}`);
  }
  async getVersion() {
    this.guard('getVersion');
    return '0.30.8';
  }
  async listOrganizations() {
    this.guard('listOrganizations');
    return [{ id: 'org_1', name: 'Personal' }];
  }
  projects: Array<{
    projectId: string;
    name: string;
    environments: Array<{ environmentId: string; name: string }>;
  }> = [];
  async listProjects() {
    this.guard('listProjects');
    return this.projects;
  }
  async createApiKey() {
    this.guard('createApiKey');
    return 'newkey';
  }
  async createProject() {
    this.guard('createProject');
    return { projectId: 'proj_1', environmentId: 'env_1' };
  }
  async getProject(): Promise<DokployProject> {
    this.guard('getProject');
    return {
      projectId: 'proj_1',
      name: 'dbm',
      environments: [
        {
          environmentId: 'env_1',
          name: 'production',
          postgres: [...this.postgres.values()]
            .map((p) => ({
              postgresId: p.postgresId,
              appName: p.appName,
              name: p.appName.replace(/-[a-z0-9]{6}$/, ''),
            }))
            .concat(
              [...this.existingNames].map((n) => ({
                postgresId: `x_${n}`,
                appName: `${n}-zzzzzz`,
                name: n,
              })),
            ),
          compose: [...this.composes],
        },
      ],
    };
  }
  async createPostgres(input: {
    name: string;
    appName: string;
    databaseName: string;
    databaseUser: string;
    databasePassword: string;
    environmentId: string;
    dockerImage: string;
  }) {
    this.guard('createPostgres');
    this.record('createPostgres', input);
    if (!/^[A-Za-z0-9]+$/.test(input.databasePassword))
      fail('dokploy.createPostgres', 'Invalid password');
    if (this.existingNames.has(input.name))
      fail('dokploy.createPostgres', 'CONFLICT: appName exists');
    const row = {
      postgresId: `pg_${++this.n}`,
      appName: `${input.appName}-abc123`,
      applicationStatus: 'idle' as const,
      databaseName: input.databaseName,
      databaseUser: input.databaseUser,
      status: 'idle' as PostgresStatus,
      volumeExists: true,
      running: true,
    };
    this.postgres.set(row.postgresId, row);
    return row;
  }
  async updatePostgres(input: { postgresId: string; memoryLimit?: string; cpuLimit?: string }) {
    this.guard('updatePostgres');
    this.record('updatePostgres', input);
  }
  async deployPostgres(id: string) {
    this.guard('deployPostgres');
    const p = this.postgres.get(id);
    if (p) p.status = 'done';
  }
  async getPostgres(id: string) {
    this.guard('getPostgres');
    const p = this.postgres.get(id);
    if (!p) fail('dokploy.getPostgres', 'not found');
    return { ...p, applicationStatus: p.status };
  }
  async stopPostgres(id: string) {
    this.guard('stopPostgres');
    const p = this.postgres.get(id);
    if (p) p.running = false;
  }
  async startPostgres(id: string) {
    this.guard('startPostgres');
    const p = this.postgres.get(id);
    if (p) p.running = true;
  }
  async removePostgres(id: string) {
    this.guard('removePostgres');
    if (!this.postgres.has(id)) notFound('dokploy.removePostgres', `postgres ${id}`);
    this.postgres.delete(id);
  }
  /** Compose services created so far; returned by getProject under the environment. */
  composes: Array<{ composeId: string; appName: string; name: string }> = [];
  async createCompose(input: { name: string; appName: string }) {
    this.guard('createCompose');
    const c = {
      composeId: `c${this.composes.length + 1}`,
      appName: `${input.appName}-abc123`,
      name: input.name,
    };
    this.composes.push(c);
    return { composeId: c.composeId, appName: c.appName };
  }
  async updateCompose() {
    this.guard('updateCompose');
  }
  async deployCompose() {
    this.guard('deployCompose');
  }
  async getCompose() {
    this.guard('getCompose');
    return { composeId: 'c1', appName: 'dbm-x', composeStatus: 'done' };
  }
  destinations: Array<{ destinationId: string; name: string }> = [];
  async listDestinations() {
    this.guard('listDestinations');
    return this.destinations;
  }
  async createDestination(input: DestinationInput) {
    this.guard('createDestination');
    const d = { destinationId: `d${this.destinations.length + 1}`, name: input.name };
    this.destinations.push(d);
    return { destinationId: d.destinationId };
  }
  async testDestination() {
    this.guard('testDestination');
  }
  async getDestination(): Promise<DestinationInput & { destinationId: string }> {
    this.guard('getDestination');
    return {
      destinationId: 'd1',
      name: 'dumps',
      provider: 'Other',
      accessKey: 'AK',
      secretAccessKey: 'SK',
      bucket: 'dumps',
      region: 'us-west-004',
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      additionalFlags: null,
    };
  }
  async createBackup(input: BackupInput) {
    this.guard('createBackup');
    const id = `bk_${this.backups.size + 1}`;
    this.backups.set(id, input);
    return { backupId: id };
  }
  async updateBackup(input: BackupInput & { backupId: string }) {
    this.guard('updateBackup');
    this.record('updateBackup', input);
    this.backups.set(input.backupId, input);
  }
  async removeBackup(id: string) {
    this.guard('removeBackup');
    if (!this.backups.has(id)) notFound('dokploy.removeBackup', `backup ${id}`);
    this.backups.delete(id);
  }
  async manualBackup(id: string) {
    this.guard('manualBackup');
    this.record('manualBackup', id);
    if (!this.backups.has(id)) notFound('dokploy.manualBackup', `backup ${id}`);
  }
  async listBackupFiles(destinationId: string, search: string) {
    this.guard('listBackupFiles');
    this.record('listBackupFiles', destinationId, search);
    return this.files;
  }
}

export class FakePg implements PostgresAdmin {
  sql: Array<{ target: PgTarget; sql: string }> = [];
  /** Arguments of every call, keyed by method name; one tuple per call. */
  inputs: Record<string, unknown[][]> = {};
  private record(method: string, ...args: unknown[]) {
    this.inputs[method] = [...(this.inputs[method] ?? []), args];
  }
  pingResults: boolean[] = [];
  pgbouncerPing = true;
  failAt = new Set<string>();
  async findContainer(appName: string) {
    return `c_${appName}`;
  }
  async runSql(target: PgTarget, sql: string) {
    if (this.failAt.has('runSql')) fail('postgres.runSql');
    this.sql.push({ target, sql });
    return '';
  }
  async ping(target: PgTarget) {
    this.record('ping', target);
    return this.pingResults.length ? (this.pingResults.shift() as boolean) : true;
  }
  async pingViaPgbouncer(url: string) {
    this.record('pingViaPgbouncer', url);
    return this.pgbouncerPing;
  }
}

export class FakeGarage implements GarageAdmin {
  calls: string[] = [];
  /** Arguments of every call, keyed by method name; one tuple per call. */
  inputs: Record<string, unknown[][]> = {};
  private record(method: string, ...args: unknown[]) {
    this.inputs[method] = [...(this.inputs[method] ?? []), args];
  }
  buckets = new Map<string, GarageBucketInfo & { objects: number }>();
  keys = new Map<string, { name: string }>();
  failAt = new Set<string>();
  private n = 0;
  private guard(step: string) {
    this.calls.push(step);
    if (this.failAt.has(step)) fail(`garage.${step}`);
  }
  async health() {
    this.guard('health');
    return true;
  }
  async createBucket(alias: string) {
    this.guard('createBucket');
    this.record('createBucket', alias);
    if ([...this.buckets.values()].some((x) => x.globalAliases.includes(alias)))
      fail('garage.createBucket', `garage CreateBucket: alias already exists: ${alias}`);
    const b = {
      id: `b_${++this.n}`,
      globalAliases: [alias],
      bytes: 0,
      objects: 0,
      unfinishedUploads: 0,
      websiteAccess: false,
    };
    this.buckets.set(b.id, b);
    return b;
  }
  async getBucket(q: { id?: string; globalAlias?: string }) {
    this.guard('getBucket');
    return [...this.buckets.values()].find(
      (b) => b.id === q.id || b.globalAliases.includes(q.globalAlias ?? '\0'),
    );
  }
  async listBuckets() {
    this.guard('listBuckets');
    return [...this.buckets.values()];
  }
  async createKey(name: string) {
    this.guard('createKey');
    let id = `GK${++this.n}`;
    while (this.keys.has(id)) id = `GK${++this.n}`;
    this.keys.set(id, { name });
    return { accessKeyId: id, secretAccessKey: `S${id}` };
  }
  async allowBucketKey(bucketId: string, accessKeyId: string, perms: GaragePermissions) {
    this.guard('allowBucketKey');
    this.record('allowBucketKey', bucketId, accessKeyId, perms);
  }
  async denyBucketKey() {
    this.guard('denyBucketKey');
  }
  async updateBucket(
    id: string,
    patch: { corsRules?: GarageCorsRule[]; websiteAccess?: { enabled: boolean } },
  ) {
    this.guard('updateBucket');
    this.record('updateBucket', id, patch);
    const b = this.buckets.get(id);
    if (b && patch.websiteAccess) b.websiteAccess = patch.websiteAccess.enabled;
  }
  async addBucketAlias() {
    this.guard('addBucketAlias');
  }
  async removeBucketAlias() {
    this.guard('removeBucketAlias');
  }
  async deleteKey(id: string) {
    this.guard('deleteKey');
    if (!this.keys.has(id)) notFound('garage.deleteKey', `garage DeleteKey: key ${id}`);
    this.keys.delete(id);
  }
  async deleteBucket(id: string) {
    this.guard('deleteBucket');
    const b = this.buckets.get(id);
    if (!b) notFound('garage.deleteBucket', `garage DeleteBucket: bucket ${id}`);
    if (b.objects > 0) fail('garage.deleteBucket', 'Bucket is not empty');
    this.buckets.delete(id);
  }
  async cleanupIncompleteUploads() {
    this.guard('cleanupIncompleteUploads');
  }
  async createAdminToken() {
    this.guard('createAdminToken');
    return { secretToken: 'scoped' };
  }
}

export class MemoryStore implements StateStore {
  readonly dir = '/mem/.dbm';
  config: Config | undefined;
  state: State = emptyState();
  saves = 0;
  progress: InitProgress = { done: {}, values: {} };
  constructor(cfg?: ConfigInput) {
    if (cfg) this.config = ConfigSchema.parse(cfg);
  }
  async loadConfig() {
    return this.config;
  }
  async saveConfig(c: ConfigInput) {
    this.config = ConfigSchema.parse(c);
    return this.config;
  }
  async requireConfig() {
    if (!this.config) throw new DbmError('no config', ExitCode.UserError, 'config');
    return this.config;
  }
  async loadState() {
    return structuredClone(this.state);
  }
  async saveState(s: State) {
    this.saves++;
    this.state = structuredClone(s);
  }
  async loadInitProgress() {
    return structuredClone(this.progress);
  }
  async saveInitProgress(p: InitProgress) {
    this.progress = structuredClone(p);
  }
}

export function makeTestDeps(
  over: Partial<Deps> & { runner?: ReturnType<typeof makeFakeRunner> } = {},
) {
  const store = (over.store as MemoryStore | undefined) ?? new MemoryStore(testConfigInput);
  const dokploy = (over.dokploy as FakeDokploy | undefined) ?? new FakeDokploy();
  const pg = (over.pg as FakePg | undefined) ?? new FakePg();
  const garage = (over.garage as FakeGarage | undefined) ?? new FakeGarage();
  const runner = over.runner ?? makeFakeRunner([]);
  const outLines: string[] = [];
  const errLines: string[] = [];
  const io: Io = {
    out: (s) => {
      outLines.push(s);
    },
    err: (s) => {
      errLines.push(s);
    },
  };
  const deps: Deps = {
    cfg: ConfigSchema.parse(testConfigInput),
    store,
    dokploy,
    ssh: runner.runner,
    pg,
    garage,
    io,
    sleep: async () => {},
    now: () => new Date('2026-09-30T12:00:00.000Z'),
    confirm: async () => true,
    ...over,
  };
  return { deps, store, dokploy, pg, garage, runner, outLines, errLines };
}

/**
 * Put `p` into state and register the remote resources it references (Dokploy service and
 * backup schedule, Garage bucket and key) so the faithful fakes accept their ids.
 */
export function seedProject(
  t: { store: MemoryStore; dokploy: FakeDokploy; garage: FakeGarage },
  p: Project,
  o: { objects?: number } = {},
): Project {
  t.store.state = upsertProject(t.store.state, p);
  t.dokploy.postgres.set(p.dokploy.postgresId, {
    postgresId: p.dokploy.postgresId,
    appName: p.dokploy.appName,
    applicationStatus: 'done',
    databaseName: 'postgres',
    databaseUser: p.postgres.adminRole,
    status: 'done',
    volumeExists: true,
    running: p.status !== 'paused',
  });
  if (p.dokploy.backupId)
    t.dokploy.backups.set(p.dokploy.backupId, {
      schedule: '0 6 * * *',
      prefix: `db/${p.slug}`,
      destinationId: 'd1',
      database: p.postgres.database,
      databaseType: 'postgres',
      postgresId: p.dokploy.postgresId,
      enabled: p.status !== 'paused',
      keepLatestCount: 35,
    });
  if (p.storage) {
    t.garage.buckets.set(p.storage.bucketId, {
      id: p.storage.bucketId,
      globalAliases: [p.storage.bucket, ...p.storage.aliases],
      bytes: 0,
      objects: o.objects ?? 0,
      unfinishedUploads: 0,
      websiteAccess: Boolean(p.storage.publicBaseUrl),
    });
    t.garage.keys.set(p.storage.keyId, { name: `${p.slug}-key` });
  }
  return p;
}
