import type { Deps } from './context.js';
import { applyPgbouncer } from './pgbouncer-apply.js';

export async function syncPgbouncerCommand(deps: Deps): Promise<void> {
  await applyPgbouncer(deps, await deps.store.loadState());
  deps.io.err('pgbouncer.ini and userlist.txt re-rendered from state and reloaded\n');
}
