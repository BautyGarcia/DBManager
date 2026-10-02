import { projectEnv } from '../core/env.js';
import { getProject } from '../core/state.js';
import type { Deps } from './context.js';

export async function envCommand(deps: Deps, slug: string): Promise<Record<string, string>> {
  const state = await deps.store.loadState();
  return projectEnv(getProject(state, slug), deps.cfg);
}
