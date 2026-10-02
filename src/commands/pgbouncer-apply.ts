import { renderPgbouncerIni, renderUserlist } from '../core/pgbouncer.js';
import { listProjects, type State } from '../core/state.js';
import type { Deps } from './context.js';

/** Render both PgBouncer files from state, upload atomically, SIGHUP. Files are 0644: the userlist holds SCRAM verifiers, not passwords, and PgBouncer runs as uid 70. */
export async function applyPgbouncer(deps: Deps, state: State): Promise<void> {
  const projects = listProjects(state);
  const dir = deps.cfg.remote.pgbouncerConfDir;
  const certDir = `/certs/${deps.cfg.dbHost}`;
  await deps.ssh.upload(`${dir}/pgbouncer.ini`, renderPgbouncerIni(projects, { certDir }), {
    mode: '0644',
  });
  await deps.ssh.upload(`${dir}/userlist.txt`, renderUserlist(projects), { mode: '0644' });
  await deps.ssh.run(['docker', 'kill', '-s', 'HUP', deps.cfg.remote.pgbouncerContainer]);
}
