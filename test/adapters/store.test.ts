import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFileStore } from '../../src/adapters/store.js';
import { emptyState, upsertProject } from '../../src/core/state.js';
import { fakeProject } from '../helpers/project.js';

describe('file store', () => {
  it('round-trips state with 0600/0700 permissions and keeps 10 backups', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dbm-store-'));
    const store = makeFileStore(join(dir, '.dbm'));
    expect(await store.loadState()).toEqual(emptyState());
    let s = emptyState();
    for (let i = 0; i < 12; i++) {
      s = upsertProject(s, fakeProject(`p${i}`));
      await store.saveState(s);
    }
    expect(Object.keys((await store.loadState()).projects)).toHaveLength(12);
    const files = await readdir(join(dir, '.dbm'));
    expect(files.filter((f) => f.startsWith('state.json.bak.'))).toHaveLength(10);
    expect((await stat(join(dir, '.dbm'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, '.dbm', 'state.json'))).mode & 0o777).toBe(0o600);
  });
  it('config is undefined until saved, then parsed with defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dbm-store-'));
    const store = makeFileStore(join(dir, '.dbm'));
    expect(await store.loadConfig()).toBeUndefined();
    const cfg = await store.saveConfig({
      sshHost: 'h',
      dokployUrl: 'https://x.ts.net',
      dokployApiKey: 'k',
      dokployProjectId: 'p',
      dokployEnvironmentId: 'e',
      domain: 'example.com',
      dbHost: 'db.example.com',
      s3Host: 's3.example.com',
      webDomain: 'web.example.com',
      garageAdminToken: 't',
      garageBackupKeyId: 'GKb',
      dumpsDestinationId: 'd',
    });
    expect(cfg.sshUser).toBe('root');
    expect((await store.loadConfig())?.remote.dbPort).toBe(6432);
  });
});

describe('file store lock', () => {
  async function fresh() {
    const dir = join(await mkdtemp(join(tmpdir(), 'dbm-lock-')), '.dbm');
    return { dir, store: makeFileStore(dir), lock: join(dir, 'lock') };
  }
  it('fresh: creates ~/.dbm/lock holding our pid; release removes it', async () => {
    const { store, lock } = await fresh();
    await store.acquireLock();
    expect((await readFile(lock, 'utf8')).trim()).toBe(String(process.pid));
    expect((await stat(lock)).mode & 0o777).toBe(0o600);
    await store.releaseLock();
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    await store.acquireLock(); // re-acquirable after release
    await store.releaseLock();
  });
  it('stale pid: a lock left by a dead process is removed and taken over', async () => {
    const { dir, store, lock } = await fresh();
    await mkdir(dir, { recursive: true });
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
    const deadPid = Number(String(dead.stdout));
    await writeFile(lock, `${deadPid}\n`);
    await store.acquireLock();
    expect((await readFile(lock, 'utf8')).trim()).toBe(String(process.pid));
    await store.releaseLock();
  });
  it('live pid: another running process holds the lock -> user error naming the pid', async () => {
    const { dir, store, lock } = await fresh();
    await mkdir(dir, { recursive: true });
    await writeFile(lock, `${process.ppid}\n`); // the parent (vitest runner) is alive
    const err = await store.acquireLock().catch((e) => e);
    expect(err).toMatchObject({ exitCode: 1 });
    expect(err.message).toMatch(
      new RegExp(`another dbm command is running \\(pid ${process.ppid}\\)`),
    );
    // release by a non-owner leaves the other process's lock alone
    await store.releaseLock();
    expect((await readFile(lock, 'utf8')).trim()).toBe(String(process.ppid));
  });
});
