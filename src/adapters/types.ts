export interface RunResult {
  stdout: string;
  stderr: string;
}
export interface RunOptions {
  input?: string;
  timeoutMs?: number;
}
export interface SshRunner {
  run(argv: string[], opts?: RunOptions): Promise<RunResult>;
  /** Atomic write (mktemp + mv) of content to remotePath; parent dir created; default mode 0600. */
  upload(remotePath: string, content: string, opts?: { mode?: string }): Promise<void>;
  /** ssh -t with inherited stdio; resolves with the remote exit code. */
  interactive(argv: string[]): Promise<number>;
}
export interface PgTarget {
  appName: string;
  role: string;
  database: string;
}
export interface PostgresAdmin {
  runSql(target: PgTarget, sql: string, opts?: RunOptions): Promise<string>;
  ping(target: PgTarget): Promise<boolean>;
  /** psql from a throwaway container on the docker network; proves PgBouncer routing + SCRAM. */
  pingViaPgbouncer(url: string): Promise<boolean>;
  findContainer(appName: string): Promise<string>;
}
export interface GarageBucketInfo {
  id: string;
  globalAliases: string[];
  bytes: number;
  objects: number;
  unfinishedUploads: number;
  websiteAccess: boolean;
}
export interface GaragePermissions {
  read?: boolean;
  write?: boolean;
  owner?: boolean;
}
/**
 * Domain shape. On the wire Garage admin v2 (verified against v2.4.1) uses the S3 XML names:
 * AllowedOrigin, AllowedMethod, AllowedHeader, ExposeHeader, MaxAgeSeconds; see toGarageCorsRule.
 */
export interface GarageCorsRule {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  exposeHeaders: string[];
  maxAgeSeconds: number;
}
export interface GarageAdmin {
  health(): Promise<boolean>;
  createBucket(globalAlias: string): Promise<GarageBucketInfo>;
  getBucket(q: { id?: string; globalAlias?: string }): Promise<GarageBucketInfo | undefined>;
  listBuckets(): Promise<Array<{ id: string; globalAliases: string[] }>>;
  createKey(name: string): Promise<{ accessKeyId: string; secretAccessKey: string }>;
  allowBucketKey(bucketId: string, accessKeyId: string, perms: GaragePermissions): Promise<void>;
  denyBucketKey(bucketId: string, accessKeyId: string, perms: GaragePermissions): Promise<void>;
  updateBucket(
    bucketId: string,
    patch: {
      corsRules?: GarageCorsRule[];
      websiteAccess?: { enabled: boolean; indexDocument?: string; errorDocument?: string };
    },
  ): Promise<void>;
  addBucketAlias(bucketId: string, globalAlias: string): Promise<void>;
  removeBucketAlias(bucketId: string, globalAlias: string): Promise<void>;
  deleteKey(accessKeyId: string): Promise<void>;
  deleteBucket(bucketId: string): Promise<void>;
  cleanupIncompleteUploads(bucketId: string): Promise<void>;
  createAdminToken(name: string, scope: string[]): Promise<{ secretToken: string }>;
}
export type PostgresStatus = 'idle' | 'running' | 'done' | 'error';
export interface DokployPostgres {
  postgresId: string;
  appName: string;
  applicationStatus: PostgresStatus;
  databaseName: string;
  databaseUser: string;
}
export interface DokployProject {
  projectId: string;
  name: string;
  environments: Array<{
    environmentId: string;
    name: string;
    postgres: Array<{ postgresId: string; appName: string; name: string }>;
    compose: Array<{ composeId: string; appName: string; name: string }>;
  }>;
}
export interface DestinationInput {
  name: string;
  provider: string | null;
  accessKey: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  endpoint: string;
  additionalFlags: string[] | null;
}
export interface BackupInput {
  schedule: string;
  prefix: string;
  destinationId: string;
  database: string;
  databaseType: 'postgres';
  postgresId: string;
  enabled: boolean;
  keepLatestCount: number;
}
export interface BackupFile {
  Path: string;
  Name: string;
  Size: number;
  ModTime: string;
}
export interface DokployClient {
  getVersion(): Promise<string>;
  listOrganizations(): Promise<Array<{ id: string; name: string }>>;
  listProjects(): Promise<
    Array<{
      projectId: string;
      name: string;
      environments: Array<{ environmentId: string; name: string }>;
    }>
  >;
  createApiKey(input: { name: string; organizationId: string }): Promise<string>;
  createProject(name: string): Promise<{ projectId: string; environmentId: string }>;
  getProject(projectId: string): Promise<DokployProject>;
  createPostgres(input: {
    name: string;
    appName: string;
    databaseName: string;
    databaseUser: string;
    databasePassword: string;
    environmentId: string;
    dockerImage: string;
  }): Promise<DokployPostgres>;
  updatePostgres(input: {
    postgresId: string;
    memoryLimit?: string;
    cpuLimit?: string;
  }): Promise<void>;
  deployPostgres(postgresId: string): Promise<void>;
  getPostgres(postgresId: string): Promise<DokployPostgres>;
  stopPostgres(postgresId: string): Promise<void>;
  startPostgres(postgresId: string): Promise<void>;
  removePostgres(postgresId: string): Promise<void>;
  createCompose(input: {
    name: string;
    appName: string;
    environmentId: string;
    composeFile: string;
    env: string;
  }): Promise<{ composeId: string; appName: string }>;
  updateCompose(input: { composeId: string; composeFile: string; env: string }): Promise<void>;
  deployCompose(composeId: string): Promise<void>;
  getCompose(
    composeId: string,
  ): Promise<{ composeId: string; appName: string; composeStatus: string }>;
  listDestinations(): Promise<Array<{ destinationId: string; name: string }>>;
  createDestination(input: DestinationInput): Promise<{ destinationId: string }>;
  testDestination(input: DestinationInput): Promise<void>;
  getDestination(destinationId: string): Promise<DestinationInput & { destinationId: string }>;
  createBackup(input: BackupInput): Promise<{ backupId: string }>;
  updateBackup(input: BackupInput & { backupId: string }): Promise<void>;
  removeBackup(backupId: string): Promise<void>;
  manualBackup(backupId: string): Promise<void>;
  listBackupFiles(destinationId: string, search: string): Promise<BackupFile[]>;
}
