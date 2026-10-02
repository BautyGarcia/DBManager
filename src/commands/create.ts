import { postgresImage } from '../core/compose.js';
import { backupCron } from '../core/cron.js';
import { projectEnv } from '../core/env.js';
import { DbmError, ExitCode, remoteError, userError } from '../core/exit.js';
import { deriveNames, validateSlug } from '../core/naming.js';
import { scramSha256Verifier } from '../core/scram.js';
import { dokployPassword, randomSecret } from '../core/secrets.js';
import {
  createDatabaseSql,
  createRoleSql,
  extensionsSql,
  grantReplicaRoleSql,
  tuningSql,
  validateExtensions,
} from '../core/sql.js';
import { type Project, removeProject, removeTombstone, upsertProject } from '../core/state.js';
import { parseMemory } from '../core/units.js';
import { adminTarget, type Deps, waitUntil } from './context.js';
import { applyPgbouncer } from './pgbouncer-apply.js';
import { removeVolume } from './volumes.js';

export interface CreateOptions {
  slug: string;
  memory?: string;
  pg?: 17 | 18;
  extensions?: string[];
  storage?: boolean;
  corsOrigins?: string[];
  /** Internal (init's smoke test): allow the reserved `dbm-` prefix. Not exposed in the CLI. */
  internal?: boolean;
  /** Internal (restore --as): keep the slug's tombstone; restore removes it once data is back. */
  keepTombstone?: boolean;
  /**
   * Internal (restore --as <same slug>): the destroyed project's bucket was kept, so its global
   * alias is taken. Skip CreateBucket and grant a fresh key on the existing bucket instead.
   */
  reuseBucket?: { bucketId: string; bucket: string };
}

export interface CreateResult {
  project: Project;
  env: Record<string, string>;
  existed: boolean;
}

const DEFAULT_EXTENSIONS = ['pgcrypto', 'uuid-ossp'];

type Undo = { what: string; run: () => Promise<void> };

async function rollback(deps: Deps, undos: Undo[], cause: DbmError): Promise<never> {
  const leftovers: string[] = [];
  for (const u of [...undos].reverse()) {
    try {
      deps.io.err(`  rollback: ${u.what}\n`);
      await u.run();
    } catch (e) {
      leftovers.push(`${u.what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (leftovers.length) {
    throw new DbmError(
      `${cause.message}\nrollback failed; leftover resources need manual cleanup:\n  - ${leftovers.join('\n  - ')}`,
      ExitCode.RollbackFailed,
      cause.step,
    );
  }
  throw cause;
}

async function waitDeployed(deps: Deps, postgresId: string): Promise<void> {
  await deps.dokploy.deployPostgres(postgresId);
  await waitUntil(
    async () => {
      const row = await deps.dokploy.getPostgres(postgresId);
      if (row.applicationStatus === 'error')
        throw remoteError(
          `Dokploy reports deploy error for ${postgresId}; check its logs in the dashboard`,
          'dokploy.deploy',
        );
      return row.applicationStatus === 'done';
    },
    {
      timeoutMs: 120_000,
      intervalMs: 2_000,
      sleep: deps.sleep,
      what: 'postgres deploy',
      step: 'dokploy.deploy',
    },
  );
}

export async function createCommand(deps: Deps, o: CreateOptions): Promise<CreateResult> {
  const slug = validateSlug(o.slug, o.internal ? { internal: true } : {});
  const names = deriveNames(slug);
  const extensions = validateExtensions([
    ...new Set([...DEFAULT_EXTENSIONS, ...(o.extensions ?? [])]),
  ]);
  const memoryBytes = parseMemory(o.memory ?? '512m');
  const pgMajor = o.pg ?? 18;
  const withStorage = o.storage !== false;
  const corsOrigins = o.corsOrigins?.length ? o.corsOrigins : ['*'];

  let state = await deps.store.loadState();
  const existing = state.projects[slug];
  if (existing?.status === 'provisioning') {
    throw userError(
      `${slug} is half-created (status provisioning); run \`dbm destroy ${slug}\` then create again`,
      'create',
    );
  }
  if (existing) {
    deps.io.err(`project ${slug} already exists (status: ${existing.status}); nothing to do\n`);
    return { project: existing, env: projectEnv(existing, deps.cfg), existed: true };
  }

  const dk = await deps.dokploy.getProject(deps.cfg.dokployProjectId);
  // Dokploy appends a 6-char suffix to appName; match it exactly so `pg-my` does not clash with `pg-my-app-xxxxxx`.
  const suffixed = new RegExp(`^${names.serviceName}-[a-z0-9]{6}$`);
  const clash = dk.environments
    .flatMap((e) => e.postgres)
    .find(
      (p) =>
        p.name === names.serviceName || p.appName === names.serviceName || suffixed.test(p.appName),
    );
  if (clash) {
    throw userError(
      `service ${names.serviceName} exists in Dokploy (${clash.appName}) but not in dbm state; \`dbm adopt\` is future work, remove it in Dokploy or pick another slug`,
      'create.precheck',
    );
  }

  const undos: Undo[] = [];
  const appPassword = randomSecret(32);
  const adminPassword = dokployPassword(32);
  const appScramVerifier = scramSha256Verifier(appPassword);

  try {
    deps.io.err(`creating ${slug}: postgres ${pgMajor} (${memoryBytes} bytes)\n`);
    const row = await deps.dokploy.createPostgres({
      name: names.serviceName,
      appName: names.serviceName,
      databaseName: 'postgres',
      databaseUser: names.adminRole,
      databasePassword: adminPassword,
      environmentId: deps.cfg.dokployEnvironmentId,
      dockerImage: postgresImage(pgMajor),
    });
    const appName = row.appName;
    // Undos run in reverse: pushing the volume first means the service is removed before its volume (spec section 7).
    undos.push({
      what: `remove volume ${appName}-data`,
      run: () => removeVolume(deps, appName),
    });
    undos.push({
      what: `remove Dokploy service ${appName}`,
      run: () => deps.dokploy.removePostgres(row.postgresId),
    });

    await deps.dokploy.updatePostgres({
      postgresId: row.postgresId,
      memoryLimit: String(memoryBytes),
    });
    await waitDeployed(deps, row.postgresId);

    const project: Project = {
      slug,
      createdAt: deps.now().toISOString(),
      status: 'provisioning',
      pgMajor,
      dokploy: { postgresId: row.postgresId, appName },
      postgres: {
        database: names.database,
        appRole: names.appRole,
        appPassword,
        appScramVerifier,
        adminRole: names.adminRole,
        adminPassword,
        extensions,
        memoryBytes,
      },
      betterAuthSecret: randomSecret(32),
    };

    await waitUntil(() => deps.pg.ping(adminTarget(project)), {
      timeoutMs: 60_000,
      intervalMs: 2_000,
      sleep: deps.sleep,
      what: 'postgres to accept connections',
      step: 'postgres.ready',
    });
    await deps.pg.runSql(
      adminTarget(project),
      `${createRoleSql(names.appRole, appScramVerifier)}\n${createDatabaseSql(names.database, names.appRole)}\n${grantReplicaRoleSql(names.appRole)}\n`,
    );
    await deps.pg.runSql(adminTarget(project, names.database), extensionsSql(extensions));
    await deps.pg.runSql(adminTarget(project), tuningSql(memoryBytes));
    await waitDeployed(deps, row.postgresId); // restart to apply shared_buffers
    await waitUntil(() => deps.pg.ping(adminTarget(project)), {
      timeoutMs: 60_000,
      intervalMs: 2_000,
      sleep: deps.sleep,
      what: 'postgres after restart',
      step: 'postgres.ready',
    });

    state = upsertProject(state, project);
    await deps.store.saveState(state);
    undos.push({
      what: 'remove project from state and re-render PgBouncer',
      run: async () => {
        const s = removeProject(await deps.store.loadState(), slug);
        await deps.store.saveState(s);
        await applyPgbouncer(deps, s);
      },
    });
    await applyPgbouncer(deps, state);
    // Internal probe from a throwaway container on the docker network, which has no CA bundle; the cert is for the public dbHost.
    const viaBouncer = `postgresql://${encodeURIComponent(names.appRole)}:${encodeURIComponent(appPassword)}@${deps.cfg.remote.pgbouncerContainer}:6432/${names.pgbouncerDb}?sslmode=require`;
    if (!(await deps.pg.pingViaPgbouncer(viaBouncer))) {
      throw new DbmError(
        'could not connect through PgBouncer after reload (check userlist.txt and [databases] on the VPS)',
        ExitCode.RemoteFailure,
        'pgbouncer.verify',
      );
    }

    if (withStorage) {
      const reuse = o.reuseBucket;
      deps.io.err(
        `  storage: ${reuse ? `existing bucket ${reuse.bucket}` : 'bucket'}, key, CORS\n`,
      );
      let bucket: { id: string };
      if (reuse) {
        // Kept data: a rollback must never delete this bucket.
        bucket = { id: reuse.bucketId };
      } else {
        const created = await deps.garage.createBucket(names.bucket);
        bucket = created;
        undos.push({
          what: `delete bucket ${names.bucket}`,
          run: async () => {
            await deps.garage.cleanupIncompleteUploads(created.id);
            await deps.garage.deleteBucket(created.id);
          },
        });
      }
      const key = await deps.garage.createKey(names.keyName);
      undos.push({
        what: `delete key ${key.accessKeyId}`,
        run: () => deps.garage.deleteKey(key.accessKeyId),
      });
      await deps.garage.allowBucketKey(bucket.id, key.accessKeyId, { read: true, write: true });
      await deps.garage.allowBucketKey(bucket.id, deps.cfg.garageBackupKeyId, { read: true });
      await deps.garage.updateBucket(bucket.id, {
        corsRules: [
          {
            allowedOrigins: corsOrigins,
            allowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
            allowedHeaders: ['*'],
            exposeHeaders: ['ETag'],
            maxAgeSeconds: 3600,
          },
        ],
      });
      project.storage = {
        bucketId: bucket.id,
        bucket: reuse?.bucket ?? names.bucket,
        keyId: key.accessKeyId,
        keySecret: key.secretAccessKey,
        corsOrigins,
        aliases: [],
      };
    }

    deps.io.err('  backup schedule\n');
    const backup = await deps.dokploy.createBackup({
      schedule: backupCron(slug),
      prefix: names.backupPrefix,
      destinationId: deps.cfg.dumpsDestinationId,
      database: names.database,
      databaseType: 'postgres',
      postgresId: row.postgresId,
      enabled: true,
      keepLatestCount: 35,
    });
    undos.push({
      what: `remove backup schedule ${backup.backupId}`,
      run: () => deps.dokploy.removeBackup(backup.backupId),
    });
    project.dokploy.backupId = backup.backupId;

    project.status = 'running';
    state = upsertProject(state, project);
    // A fresh project under a destroyed slug: its dumps (new appName) are the ones restore must use.
    if (!o.keepTombstone) state = removeTombstone(state, slug);
    await deps.store.saveState(state);
    deps.io.err(`created ${slug}\n`);
    return { project, env: projectEnv(project, deps.cfg), existed: false };
  } catch (e) {
    const cause =
      e instanceof DbmError
        ? e
        : new DbmError(
            e instanceof Error ? e.message : String(e),
            ExitCode.RemoteFailure,
            'create',
          );
    deps.io.err(`create failed at [${cause.step ?? 'unknown'}]: ${cause.message}\n`);
    return rollback(deps, undos, cause);
  }
}
