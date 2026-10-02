import { makeDokployClient } from '../adapters/dokploy.js';
import { makeGarageAdmin } from '../adapters/garage.js';
import { makePostgresAdmin } from '../adapters/postgres.js';
import { makeSshRunner } from '../adapters/ssh.js';
import type { StateStore } from '../adapters/store.js';
import type {
  DokployClient,
  GarageAdmin,
  PgTarget,
  PostgresAdmin,
  SshRunner,
} from '../adapters/types.js';
import type { Io } from '../cli.js';
import { IMAGES } from '../core/compose.js';
import type { Config } from '../core/config.js';
import { remoteError } from '../core/exit.js';
import type { Project } from '../core/state.js';

export interface Deps {
  cfg: Config;
  store: StateStore;
  dokploy: DokployClient;
  ssh: SshRunner;
  pg: PostgresAdmin;
  garage: GarageAdmin;
  io: Io;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  confirm: (prompt: string, expected: string) => Promise<boolean>;
}

export async function confirmOnTty(prompt: string, expected: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${prompt} Type ${expected} to continue: `);
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}

export function makeDepsFromConfig(cfg: Config, store: StateStore, io: Io): Deps {
  const ssh = makeSshRunner({ host: cfg.sshHost, user: cfg.sshUser });
  return {
    cfg,
    store,
    dokploy: makeDokployClient({ baseUrl: cfg.dokployUrl, apiKey: cfg.dokployApiKey }),
    ssh,
    pg: makePostgresAdmin(ssh, {
      network: cfg.remote.dockerNetwork,
      clientImage: IMAGES.postgres18,
    }),
    garage: makeGarageAdmin(ssh, { port: cfg.remote.garageAdminPort, token: cfg.garageAdminToken }),
    io,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    confirm: confirmOnTty,
  };
}

export async function makeDeps(store: StateStore, io: Io): Promise<Deps> {
  return makeDepsFromConfig(await store.requireConfig(), store, io);
}

export function adminTarget(p: Project, database = 'postgres'): PgTarget {
  return { appName: p.dokploy.appName, role: p.postgres.adminRole, database };
}

export function appTarget(p: Project): PgTarget {
  return { appName: p.dokploy.appName, role: p.postgres.appRole, database: p.postgres.database };
}

export async function waitUntil(
  fn: () => Promise<boolean>,
  o: {
    timeoutMs: number;
    intervalMs: number;
    sleep: (ms: number) => Promise<void>;
    what: string;
    step: string;
  },
): Promise<void> {
  const mult = Number(process.env.DBM_TIMEOUT_MULTIPLIER ?? '1') || 1;
  const deadline = Date.now() + o.timeoutMs * mult;
  let attempts = 0;
  for (;;) {
    attempts++;
    if (await fn()) return;
    if (Date.now() >= deadline)
      throw remoteError(
        `timed out after ${o.timeoutMs * mult}ms waiting for ${o.what} (${attempts} attempts)`,
        o.step,
      );
    await o.sleep(o.intervalMs);
  }
}
