import { chmod, cp, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

async function preflight(dir: string) {
  const r = await execa('bash', ['skills/dbmanager/preflight.sh', dir]);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

describe('skills/dbmanager/preflight.sh modes', () => {
  it('empty folder -> create', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pf-empty-'));
    const j = await preflight(dir);
    expect(j.mode).toBe('create');
    expect((j.supabase as { detected: boolean }).detected).toBe(false);
  });
  it('supabase fixture -> migrate with the importing files listed and env detected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pf-sb-'));
    await cp('test/fixtures/supabase-app', dir, { recursive: true });
    await rename(join(dir, 'env.local.example'), join(dir, '.env.local'));
    const j = await preflight(dir);
    expect(j.mode).toBe('migrate');
    const sb = j.supabase as { detected: boolean; files: string[]; envPresent: boolean };
    expect(sb.detected).toBe(true);
    expect(sb.envPresent).toBe(true);
    expect(sb.files.sort()).toEqual(['app/actions.ts', 'app/page.tsx', 'lib/supabase.ts']);
  });
  it('next app without supabase -> connect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pf-next-'));
    await cp('test/fixtures/supabase-app', dir, { recursive: true });
    await execa('node', [
      '-e',
      `const f=require('fs');const p=JSON.parse(f.readFileSync('${dir}/package.json'));delete p.dependencies['@supabase/supabase-js'];delete p.dependencies['@supabase/ssr'];f.writeFileSync('${dir}/package.json',JSON.stringify(p))`,
    ]);
    expect((await preflight(dir)).mode).toBe('connect');
  });
});

describe('preflight dbmImportV2', () => {
  async function withFakeDbm(helpText: string) {
    const fakeDir = await mkdtemp(join(tmpdir(), 'pf-fake-'));
    const bin = join(fakeDir, 'dbm');
    await writeFile(bin, `#!/bin/sh\necho '${helpText}'\n`);
    await chmod(bin, 0o755);
    const dir = await mkdtemp(join(tmpdir(), 'pf-v2-'));
    const r = await execa('bash', ['skills/dbmanager/preflight.sh', dir], {
      env: { ...process.env, PATH: `${fakeDir}:${process.env.PATH}` },
    });
    return JSON.parse(r.stdout) as Record<string, unknown>;
  }
  it('true when dbm import --help mentions --replace', async () => {
    expect((await withFakeDbm('Usage: dbm import --replace --users-out')).dbmImportV2).toBe(true);
  });
  it('false when the installed dbm is older', async () => {
    expect((await withFakeDbm('Usage: dbm import --from')).dbmImportV2).toBe(false);
  });
});
