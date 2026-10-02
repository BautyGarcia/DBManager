import { randomBytes } from 'node:crypto';
import { chmod, link, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Config, type ConfigInput, ConfigSchema } from '../core/config.js';
import { userError } from '../core/exit.js';
import { emptyState, parseState, type State } from '../core/state.js';

export interface InitProgress {
  done: Record<string, boolean>;
  values: Record<string, string>;
}

export interface StateStore {
  readonly dir: string;
  loadConfig(): Promise<Config | undefined>;
  saveConfig(cfg: ConfigInput): Promise<Config>;
  requireConfig(): Promise<Config>;
  loadState(): Promise<State>;
  saveState(state: State): Promise<void>;
  loadInitProgress(): Promise<InitProgress>;
  saveInitProgress(p: InitProgress): Promise<void>;
  /** Serialize dbm commands on this machine; throws a user error if another one holds the lock. */
  acquireLock(): Promise<void>;
  releaseLock(): Promise<void>;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const KEEP_BACKUPS = 10;
let backupSeq = 0; // disambiguates backups taken within the same millisecond

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await rename(tmp, file);
  await chmod(file, 0o600);
}

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export function makeFileStore(dir = join(homedir(), '.dbm')): StateStore {
  const configFile = join(dir, 'config.json');
  const stateFile = join(dir, 'state.json');
  const progressFile = join(dir, 'init-progress.json');
  const lockFile = join(dir, 'lock');

  async function backupState(): Promise<void> {
    const current = await readJson(stateFile);
    if (current === undefined) return;
    const seq = String(backupSeq++ % 10000).padStart(4, '0');
    const ts = `${new Date().toISOString().replaceAll(':', '-')}.${seq}`;
    await writeJsonAtomic(join(dir, `state.json.bak.${ts}`), current);
    const backups = (await readdir(dir)).filter((f) => f.startsWith('state.json.bak.')).sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
      await unlink(join(dir, old));
    }
  }

  return {
    dir,
    async loadConfig() {
      const raw = await readJson(configFile);
      return raw === undefined ? undefined : ConfigSchema.parse(raw);
    },
    async saveConfig(cfg) {
      const parsed = ConfigSchema.parse(cfg);
      await writeJsonAtomic(configFile, parsed);
      return parsed;
    },
    async requireConfig() {
      const cfg = await this.loadConfig();
      if (!cfg)
        throw userError(
          `no config at ${configFile}; run \`dbm init <host> --domain <domain>\` first`,
          'config',
        );
      return cfg;
    },
    async loadState() {
      const raw = await readJson(stateFile);
      return raw === undefined ? emptyState() : parseState(raw);
    },
    async saveState(state) {
      await backupState();
      await writeJsonAtomic(stateFile, state);
    },
    async loadInitProgress() {
      const raw = (await readJson(progressFile)) as Partial<InitProgress> | undefined;
      return { done: raw?.done ?? {}, values: raw?.values ?? {} };
    },
    async saveInitProgress(p) {
      await writeJsonAtomic(progressFile, p);
    },
    async acquireLock() {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      for (let attempt = 0; attempt < 5; attempt++) {
        // Write the pid first, then hard-link it into place: the lock never exists without its pid.
        const tmp = join(dir, `.lock.${process.pid}.${randomBytes(4).toString('hex')}`);
        await writeFile(tmp, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
        try {
          await link(tmp, lockFile);
          return;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        } finally {
          await unlink(tmp).catch(() => {});
        }
        const raw = await readFile(lockFile, 'utf8').catch((e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return undefined; // released meanwhile: retry
          throw e;
        });
        if (raw === undefined) continue;
        const pid = Number.parseInt(raw.trim(), 10);
        if (Number.isInteger(pid) && pid > 0 && pidAlive(pid))
          throw userError(
            `another dbm command is running (pid ${pid}); wait for it, or remove ${lockFile} if that process is not dbm`,
            'lock',
          );
        await unlink(lockFile).catch(() => {}); // stale: its process is gone
      }
      throw userError(`could not acquire ${lockFile}`, 'lock');
    },
    async releaseLock() {
      const raw = await readFile(lockFile, 'utf8').catch(() => undefined);
      if (raw !== undefined && Number.parseInt(raw.trim(), 10) === process.pid)
        await unlink(lockFile).catch(() => {});
    },
  };
}
