import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

describe('skills/dbmanager/inventory.mjs', () => {
  it('writes MIGRATION.md with every usage kind, per-file lines, import errors and policies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inv-'));
    await cp('test/fixtures/supabase-app', dir, { recursive: true });
    const report = join(dir, 'import.json');
    await writeFile(
      report,
      JSON.stringify({
        slug: 'fixture',
        schemas: ['public'],
        errors: {
          authUsers: ['ERROR: relation "auth.users" does not exist'],
          authUid: [],
          storageObjects: [],
          extensions: [],
          other: [],
        },
        storageSynced: true,
        counts: [{ table: 'public.posts', source: 10, target: 10 }],
        rlsPolicies: ['public.posts: posts_owner'],
        usersExported: 3,
        mismatched: [],
      }),
    );
    const r = await execa('node', ['skills/dbmanager/inventory.mjs', dir, '--import-json', report]);
    expect(r.stdout).toMatch(/MIGRATION\.md: 9 usages in 3 files, 1 policies, 1 import errors/);
    const md = await readFile(join(dir, 'MIGRATION.md'), 'utf8');
    for (const kind of [
      'client-init',
      'query',
      'auth',
      'storage',
      'realtime',
      'rpc',
      'edge-function',
    ]) {
      expect(md).toContain(`\`${kind}\``);
    }
    expect(md).toContain('app/page.tsx:4'); // the .from("posts") query line
    expect(md).toContain('app/actions.ts'); // query via a helper-free admin client (Review Focus 3)
    expect(md).toContain('posts_owner');
    expect(md).toContain('auth.users');
    expect(md).toContain('"use client"'); // flags client components that query the database
    expect(md).not.toContain('node_modules');
  });

  it('works without --import-json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inv2-'));
    await cp('test/fixtures/supabase-app', dir, { recursive: true });
    const r = await execa('node', ['skills/dbmanager/inventory.mjs', dir]);
    expect(r.stdout).toMatch(/0 policies, 0 import errors/);
  });
});
