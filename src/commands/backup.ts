import type { BackupFile } from '../adapters/types.js';
import { IMAGES } from '../core/compose.js';
import { userError } from '../core/exit.js';
import { deriveNames } from '../core/naming.js';
import { getProject, type Project } from '../core/state.js';
import type { Deps } from './context.js';
import { createCommand } from './create.js';

export function pickBackup(files: BackupFile[], backupId: string): BackupFile {
  if (!files.length) throw userError('no backups found for this project', 'restore');
  if (backupId === 'latest') {
    const sorted = [...files].sort((a, b) => a.ModTime.localeCompare(b.ModTime));
    const latest = sorted.at(-1);
    if (latest) return latest;
  }
  const f = files.find(
    (x) => x.Name === backupId || x.Path === backupId || x.Path.endsWith(`/${backupId}`),
  );
  if (!f)
    throw userError(`backup ${backupId} not found; run \`dbm backup <slug>\` to list`, 'restore');
  return f;
}

async function listFiles(deps: Deps, p: Project): Promise<BackupFile[]> {
  const names = deriveNames(p.slug);
  return deps.dokploy.listBackupFiles(
    deps.cfg.dumpsDestinationId,
    `${p.dokploy.appName}/${names.backupPrefix}/`,
  );
}

export async function backupCommand(
  deps: Deps,
  slug: string,
): Promise<{ slug: string; files: BackupFile[] }> {
  const p = getProject(await deps.store.loadState(), slug);
  if (!p.dokploy.backupId) throw userError(`${slug} has no backup schedule`, 'backup');
  if (p.status === 'paused')
    throw userError(`${slug} is paused; resume before taking a backup`, 'backup');
  deps.io.err('running backup (pg_dump -Fc | gzip -> off-site)...\n');
  await deps.dokploy.manualBackup(p.dokploy.backupId);
  return { slug, files: await listFiles(deps, p) };
}

export interface RestoreOptions {
  slug: string;
  backupId: string;
  as?: string;
}

export interface RestoreScriptInput {
  network: string;
  bucket: string;
  objectPath: string;
  container: string;
  appRole: string;
  database: string;
}

/** Pipeline run on the VPS. Credentials are never part of it; they arrive on stdin. */
export function restoreScript(i: RestoreScriptInput): string {
  const pipeline = [
    `docker run --rm -i --network ${i.network} ${IMAGES.rclone} --config /dev/stdin cat dst:${i.bucket}/${i.objectPath}`,
    'gunzip',
    `docker exec -i ${i.container} pg_restore -U ${i.appRole} -d ${i.database} -O --clean --if-exists`,
  ].join(' | ');
  // pipefail is supported by dash 0.5.12 (Ubuntu 24.04 /bin/sh).
  return `set -o pipefail; ${pipeline}`;
}

export async function restoreCommand(
  deps: Deps,
  o: RestoreOptions,
): Promise<{ target: string; file: string }> {
  const source = getProject(await deps.store.loadState(), o.slug);
  const file = pickBackup(await listFiles(deps, source), o.backupId);
  const dest = await deps.dokploy.getDestination(deps.cfg.dumpsDestinationId);

  let target = source;
  if (o.as) {
    deps.io.err(`creating ${o.as} for restore...\n`);
    const created = await createCommand(deps, {
      slug: o.as,
      pg: source.pgMajor,
      extensions: source.postgres.extensions,
      memory: String(source.postgres.memoryBytes),
    });
    target = created.project;
  }
  if (target.status === 'paused')
    throw userError(`${target.slug} is paused; resume before restoring`, 'restore');

  const container = await deps.pg.findContainer(target.dokploy.appName);
  const rcloneConf = `[dst]\ntype = s3\nprovider = ${dest.provider ?? 'Other'}\nenv_auth = false\naccess_key_id = ${dest.accessKey}\nsecret_access_key = ${dest.secretAccessKey}\nendpoint = ${dest.endpoint}\nregion = ${dest.region}\nforce_path_style = true\nno_check_bucket = true\n`;
  const script = restoreScript({
    network: deps.cfg.remote.dockerNetwork,
    bucket: dest.bucket,
    objectPath: file.Path,
    container,
    appRole: target.postgres.appRole,
    database: target.postgres.database,
  });
  deps.io.err(`restoring ${file.Name} into ${target.slug}...\n`);
  await deps.ssh.run(['sh', '-c', script], { input: rcloneConf, timeoutMs: 30 * 60_000 });
  deps.io.err('restore complete\n');
  return { target: target.slug, file: file.Name };
}
