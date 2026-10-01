import { mkdtemp, readdir, stat } from 'node:fs/promises';
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
