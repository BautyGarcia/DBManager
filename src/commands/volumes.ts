import type { Deps } from './context.js';

const IN_USE_ATTEMPTS = 10;
const IN_USE_DELAY_MS = 3000;

/**
 * `docker volume rm <appName>-data`, tolerant of the two benign races:
 * the volume never existed (failure before the first deploy) counts as removed, and
 * "volume is in use" right after `postgres.remove` (Swarm returns before the task
 * container is gone) is retried up to 10 attempts, 3s apart, then the last error is thrown.
 */
export async function removeVolume(deps: Deps, appName: string): Promise<void> {
  const volume = `${appName}-data`;
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.ssh.run(['docker', 'volume', 'rm', volume]);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such volume/i.test(msg)) return;
      if (!/in use/i.test(msg) || attempt >= IN_USE_ATTEMPTS) throw e;
      await deps.sleep(IN_USE_DELAY_MS);
    }
  }
}
