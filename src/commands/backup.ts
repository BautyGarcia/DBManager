import { quote } from 'shlex';
import type { BackupFile } from '../adapters/types.js';
import { newestBackupFile } from '../core/backup-files.js';
import { IMAGES } from '../core/compose.js';
import { userError } from '../core/exit.js';
import { deriveNames } from '../core/naming.js';
import { getProject, removeTombstone } from '../core/state.js';
import type { Deps } from './context.js';
import { createCommand } from './create.js';
import { requireConfirmation } from './destroy.js';

export function pickBackup(files: BackupFile[], backupId: string): BackupFile {
  if (!files.length) throw userError('no backups found for this project', 'restore');
  if (backupId === 'latest') {
    const latest = newestBackupFile(files);
    if (latest) return latest;
  }
  const f = files.find(
    (x) => x.Name === backupId || x.Path === backupId || x.Path.endsWith(`/${backupId}`),
  );
  if (!f)
    throw userError(`backup ${backupId} not found; run \`dbm backup <slug>\` to list`, 'restore');
  return f;
}

async function listFiles(deps: Deps, p: { slug: string; appName: string }): Promise<BackupFile[]> {
  const names = deriveNames(p.slug);
  return deps.dokploy.listBackupFiles(
    deps.cfg.dumpsDestinationId,
    `${p.appName}/${names.backupPrefix}/`,
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
  return { slug, files: await listFiles(deps, { slug, appName: p.dokploy.appName }) };
}

export interface RestoreOptions {
  slug: string;
  backupId: string;
  as?: string;
  yes: boolean;
  confirmSlug?: string;
}

export interface RestoreScriptInput {
  network: string;
  bucket: string;
  objectPath: string;
  container: string;
  appRole: string;
  database: string;
  /**
   * Shell command that writes the gzipped dump to stdout. Defaults to `rclone cat` of the object
   * from the dumps destination (credentials on stdin); the integration test feeds a local file.
   * Never add `--s3-no-head-object` here: with it rclone resolves the path as a directory and
   * `cat` prints nothing (verified against Backblaze with rclone 1.75).
   */
  source?: string;
}

export const RESTORE_DUMP = '/tmp/dbm-restore.dump';
export const RESTORE_LIST = '/tmp/dbm-restore.list';

/**
 * Pipeline run on the VPS. Credentials are never part of it; they arrive on stdin.
 *
 * Dumps are taken by the superuser and carry `CREATE EXTENSION` / `COMMENT ON EXTENSION`
 * entries (plus `DROP EXTENSION` under --clean). The app role does not own the extensions
 * (create installed them as admin), so those entries are filtered out of the TOC list and
 * comments are skipped; everything else is restored as the app role.
 */
export function restoreScript(i: RestoreScriptInput): string {
  const source =
    i.source ??
    `docker run --rm -i --network ${quote(i.network)} ${quote(IMAGES.rclone)} --config /dev/stdin cat ${quote(`dst:${i.bucket}/${i.objectPath}`)}`;
  const c = quote(i.container);
  const dump = quote(RESTORE_DUMP);
  const list = quote(RESTORE_LIST);
  const filter = `pg_restore -l ${dump} | grep -Ev ${quote('^;|[[:space:]]EXTENSION[[:space:]]|COMMENT - EXTENSION')} > ${list}`;
  return [
    // pipefail is supported by dash 0.5.12 (Ubuntu 24.04 /bin/sh).
    'set -e -o pipefail',
    `trap ${quote(`rc=$?; docker exec ${c} rm -f ${dump} ${list}; exit $rc`)} EXIT`,
    `${source} | gunzip | docker exec -i ${c} sh -c ${quote(`cat > ${dump}`)}`,
    `docker exec ${c} sh -c ${quote(filter)}`,
    `docker exec ${c} pg_restore -U ${quote(i.appRole)} -d ${quote(i.database)} -O --clean --if-exists --no-comments -L ${list} ${dump}`,
  ].join('\n');
}

export async function restoreCommand(
  deps: Deps,
  o: RestoreOptions,
): Promise<{ target: string; file: string }> {
  const state = await deps.store.loadState();
  const live = state.projects[o.slug];
  const tomb = state.destroyed?.[o.slug];
  if (!live && !tomb)
    throw userError(
      `${JSON.stringify(o.slug)} is neither a live project nor a destroyed one in state (run \`dbm list\`)`,
      'restore',
    );
  if (!o.as && !live)
    throw userError(
      `${o.slug} was destroyed; use --as <newslug> (same slug allowed) to recreate it from a dump`,
      'restore',
    );
  // Retry of an interrupted tombstone restore: the project already exists from the earlier attempt.
  const retry = Boolean(o.as && o.as === o.slug && tomb && live);
  if (o.as && state.projects[o.as] && !retry)
    throw userError(`${o.as} already exists; restore without --as to restore in place`, 'restore');

  // Dumps live under the appName the data was written by. The tombstone (the destroyed
  // project's appName) is used only on the --as path: recreating a destroyed slug, or retrying
  // that recreate. Without --as the live project wins, even if the slug was destroyed and
  // re-created earlier (create removes the tombstone, but a stale one must never win).
  const useTomb = Boolean(o.as && tomb && (!live || o.as === o.slug));
  const src = useTomb
    ? tomb
    : live
      ? {
          slug: live.slug,
          appName: live.dokploy.appName,
          pgMajor: live.pgMajor,
          extensions: live.postgres.extensions,
          memoryBytes: live.postgres.memoryBytes,
        }
      : undefined;
  if (!src) throw userError(`${o.slug} not found`, 'restore');
  const file = pickBackup(await listFiles(deps, src), o.backupId);

  // Overwriting an existing database needs the same confirmation as destroy.
  const inPlace = !o.as || retry;
  const targetSlug = o.as ?? o.slug;
  if (inPlace) {
    await requireConfirmation(
      deps,
      { slug: targetSlug, yes: o.yes, ...(o.confirmSlug ? { confirmSlug: o.confirmSlug } : {}) },
      'overwrite the database of',
    );
  }
  const dest = await deps.dokploy.getDestination(deps.cfg.dumpsDestinationId);

  let target = inPlace ? live : undefined;
  if (!inPlace && o.as) {
    deps.io.err(`creating ${o.as} for restore...\n`);
    // Recreating the destroyed slug: its kept bucket still holds the global alias, so reuse it.
    let reuseBucket: { bucketId: string; bucket: string } | undefined;
    if (useTomb && tomb?.bucketId && tomb.bucket && o.as === o.slug) {
      if (await deps.garage.getBucket({ id: tomb.bucketId })) {
        reuseBucket = { bucketId: tomb.bucketId, bucket: tomb.bucket };
        deps.io.err(`  reusing kept bucket ${tomb.bucket}\n`);
      } else {
        deps.io.err(`  kept bucket ${tomb.bucket} no longer exists; creating a new one\n`);
      }
    }
    const created = await createCommand(deps, {
      slug: o.as,
      pg: src.pgMajor,
      extensions: src.extensions,
      memory: String(src.memoryBytes),
      // The tombstone stays until the data is restored, so a failed restore can be retried.
      keepTombstone: true,
      ...(reuseBucket ? { reuseBucket } : {}),
    });
    target = created.project;
  }
  if (!target) throw userError(`${o.slug} not found`, 'restore');
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
  if (useTomb && o.as === o.slug) {
    await deps.store.saveState(removeTombstone(await deps.store.loadState(), o.slug));
  }
  deps.io.err('restore complete\n');
  return { target: target.slug, file: file.Name };
}
