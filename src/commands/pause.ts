import type { BackupInput } from '../adapters/types.js';
import { backupCron } from '../core/cron.js';
import { deriveNames } from '../core/naming.js';
import { getProject, type Project, upsertProject } from '../core/state.js';
import type { Deps } from './context.js';

/** Dokploy's backup.update requires every field; rebuild them from state. */
export function backupInputFor(deps: Deps, p: Project, enabled: boolean): BackupInput {
  return {
    schedule: backupCron(p.slug),
    prefix: deriveNames(p.slug).backupPrefix,
    destinationId: deps.cfg.dumpsDestinationId,
    database: p.postgres.database,
    databaseType: 'postgres',
    postgresId: p.dokploy.postgresId,
    enabled,
    keepLatestCount: 35,
  };
}

async function setRunning(deps: Deps, slug: string, running: boolean): Promise<Project> {
  const state = await deps.store.loadState();
  const p = getProject(state, slug);
  const target = running ? 'running' : 'paused';
  if (p.status === target) {
    deps.io.err(`${slug} is already ${target}\n`);
    return p;
  }
  if (running) await deps.dokploy.startPostgres(p.dokploy.postgresId);
  else await deps.dokploy.stopPostgres(p.dokploy.postgresId);
  if (p.dokploy.backupId) {
    await deps.dokploy.updateBackup({
      ...backupInputFor(deps, p, running),
      backupId: p.dokploy.backupId,
    });
  }
  const next: Project = { ...p, status: target };
  await deps.store.saveState(upsertProject(state, next));
  deps.io.err(`${slug} ${target}\n`);
  return next;
}

export const pauseCommand = (deps: Deps, slug: string) => setRunning(deps, slug, false);
export const resumeCommand = (deps: Deps, slug: string) => setRunning(deps, slug, true);
