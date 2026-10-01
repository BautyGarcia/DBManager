import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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
  };
}
