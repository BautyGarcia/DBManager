import { IMAGES } from '../core/compose.js';
import { userError } from '../core/exit.js';
import { deriveNames } from '../core/naming.js';
import { getProject, type Project, removeProject } from '../core/state.js';
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
  let state = await deps.store.loadState();
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

  state = removeProject(state, p.slug);
  await deps.store.saveState(state);
  await applyPgbouncer(deps, state);

  if (p.dokploy.backupId) await deps.dokploy.removeBackup(p.dokploy.backupId);
  await deps.dokploy.removePostgres(p.dokploy.postgresId);
  await removeVolume(deps, p.dokploy.appName);

  let purgedStorage = false;
  if (p.storage) {
    if (o.purgeStorage) {
      deps.io.err('emptying and deleting bucket...\n');
      await emptyBucket(deps, p);
      await deps.garage.cleanupIncompleteUploads(p.storage.bucketId);
      await deps.garage.deleteBucket(p.storage.bucketId);
      if (p.storage.publicBaseUrl) {
        await deps.ssh.run([
          'rm',
          '-f',
          `${deps.cfg.remote.traefikDynamicDir}/${names.traefikWebFile}`,
        ]);
      }
      purgedStorage = true;
    } else {
      deps.io.err(`bucket ${p.storage.bucket} kept (use --purge-storage to delete it)\n`);
    }
    await deps.garage.deleteKey(p.storage.keyId);
  }

  for (const w of warnings) deps.io.err(`warning: ${w}\n`);
  deps.io.err(`destroyed ${p.slug}; off-site dumps remain for 30 days\n`);
  return { slug: p.slug, purgedStorage, warnings };
}
