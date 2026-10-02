import { getProject, type Project } from '../core/state.js';
import type { Deps } from './context.js';

export function psqlArgv(container: string, p: Project, admin: boolean): string[] {
  return [
    'docker',
    'exec',
    '-it',
    container,
    'psql',
    '-U',
    admin ? p.postgres.adminRole : p.postgres.appRole,
    '-d',
    p.postgres.database,
  ];
}

export async function psqlCommand(deps: Deps, slug: string, admin: boolean): Promise<number> {
  const p = getProject(await deps.store.loadState(), slug);
  const container = await deps.pg.findContainer(p.dokploy.appName);
  return deps.ssh.interactive(psqlArgv(container, p, admin));
}
