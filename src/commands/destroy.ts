import { IMAGES } from '../core/compose.js';
import { DbmError, ExitCode, userError } from '../core/exit.js';
import { deriveNames } from '../core/naming.js';
import { addTombstone, getProject, type Project, removeProject } from '../core/state.js';
import type { Deps } from './context.js';
import { applyPgbouncer } from './pgbouncer-apply.js';
import { removeVolume } from './volumes.js';

export interface DestroyOptions {
  slug: string;
  purgeStorage: boolean;
  yes: boolean;
  confirmSlug?: string;
}

export interface DestroyResult {
  slug: string;
  purgedStorage: boolean;
  warnings: string[];
}

export async function requireConfirmation(
  deps: Deps,
  o: { slug: string; yes: boolean; confirmSlug?: string },
  action: string,
): Promise<void> {
  if (o.yes) {
    if (o.confirmSlug !== o.slug)
      throw userError(`--yes requires --confirm ${o.slug} to ${action}`, 'confirm');
    return;
  }
  if (!(await deps.confirm(`This will ${action} ${o.slug}.`, o.slug)))
    throw userError('aborted', 'confirm');
}

/** Delete every object with the project's own key from a throwaway rclone container on the docker network. */
export async function emptyBucket(deps: Deps, p: Project): Promise<void> {
  if (!p.storage) return;
  const conf = `[garage]\ntype = s3\nprovider = Other\nenv_auth = false\naccess_key_id = ${p.storage.keyId}\nsecret_access_key = ${p.storage.keySecret}\nendpoint = http://${deps.cfg.remote.garageContainer}:3900\nregion = garage\nforce_path_style = true\nno_check_bucket = true\n`;
  await deps.ssh.run(
    [
      'docker',
      'run',
      '--rm',
      '-i',
      '--network',
      deps.cfg.remote.dockerNetwork,
      IMAGES.rclone,
      '--config',
      '/dev/stdin',
      'purge',
      `garage:${p.storage.bucket}`,
    ],
    { input: conf, timeoutMs: 30 * 60_000 },
  );
}

export async function destroyCommand(deps: Deps, o: DestroyOptions): Promise<DestroyResult> {
  const state = await deps.store.loadState();
  const p = getProject(state, o.slug);
  await requireConfirmation(deps, o, 'permanently destroy');
  const names = deriveNames(p.slug);
  const warnings: string[] = [];

  if (p.status === 'paused') {
    warnings.push(`${p.slug} is paused: no final backup was taken (resume first if you need one)`);
  } else if (p.dokploy.backupId) {
    deps.io.err('final backup...\n');
    await deps.dokploy.manualBackup(p.dokploy.backupId);
  }

  const remaining = removeProject(state, p.slug);
  // Stop routing traffic first; state is saved only once every resource is gone.
  await applyPgbouncer(deps, remaining);

  const steps: { label: string; run: () => Promise<void> }[] = [];
  if (p.dokploy.backupId) {
    const id = p.dokploy.backupId;
    steps.push({ label: 'backup schedule', run: () => deps.dokploy.removeBackup(id) });
  }
  steps.push({
    label: 'postgres service',
    run: () => deps.dokploy.removePostgres(p.dokploy.postgresId),
  });
  steps.push({
    label: `volume ${p.dokploy.appName}-data`,
    run: () => removeVolume(deps, p.dokploy.appName),
  });

  let purgedStorage = false;
  const st = p.storage;
  if (st) {
    if (o.purgeStorage) {
      steps.push({
        label: `bucket ${st.bucket}`,
        run: async () => {
          deps.io.err('emptying and deleting bucket...\n');
          await emptyBucket(deps, p);
          await deps.garage.cleanupIncompleteUploads(st.bucketId);
          await deps.garage.deleteBucket(st.bucketId);
        },
      });
      if (st.publicBaseUrl) {
        steps.push({
          label: 'web router',
          run: () =>
            deps.ssh
              .run(['rm', '-f', `${deps.cfg.remote.traefikDynamicDir}/${names.traefikWebFile}`])
              .then(() => undefined),
        });
      }
      purgedStorage = true;
    } else {
      deps.io.err(`bucket ${st.bucket} kept (use --purge-storage to delete it)\n`);
    }
    steps.push({ label: `key ${st.keyId}`, run: () => deps.garage.deleteKey(st.keyId) });
  }

  const done: string[] = [];
  for (const [i, step] of steps.entries()) {
    try {
      await step.run();
      done.push(step.label);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const notAttempted = steps.slice(i + 1).map((x) => x.label);
      throw new DbmError(
        `destroy of ${p.slug} failed at ${step.label}: ${msg}. ` +
          `completed: ${done.join(', ') || 'none'}. not attempted: ${notAttempted.join(', ') || 'none'}. ` +
          `PgBouncer routing for ${p.slug} was already removed and stays removed. ` +
          `${p.slug} is still in dbm state; fix the cause and re-run \`dbm destroy ${p.slug}\``,
        ExitCode.RemoteFailure,
        e instanceof DbmError && e.step ? e.step : 'destroy',
      );
    }
  }
  await deps.store.saveState(
    addTombstone(remaining, {
      slug: p.slug,
      appName: p.dokploy.appName,
      pgMajor: p.pgMajor,
      extensions: p.postgres.extensions,
      memoryBytes: p.postgres.memoryBytes,
      destroyedAt: deps.now().toISOString(),
    }),
  );

  for (const w of warnings) deps.io.err(`warning: ${w}\n`);
  deps.io.err(`destroyed ${p.slug}; off-site dumps remain for 30 days\n`);
  return { slug: p.slug, purgedStorage, warnings };
}
