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
    const rows: Record<string, number> = {
      'client-init': 2,
      query: 2,
      auth: 1,
      storage: 1,
      realtime: 1,
      rpc: 1,
      'edge-function': 1,
    };
    for (const [kind, n] of Object.entries(rows)) expect(md).toContain(`| \`${kind}\` | ${n} |`);
    expect(md).toContain('L6 `storage`');
    expect(md).toContain('L4 `query`');
    const sec2 = md.slice(md.indexOf('## 2.'), md.indexOf('## 3.'));
    expect(sec2).toContain('app/page.tsx:4');
    expect(sec2).toContain('app/page.tsx:8');
    expect(sec2).not.toContain('app/actions.ts');
    expect(md).toContain('posts_owner');
    expect(md).toContain('relation "auth.users" does not exist');
    expect(md).not.toContain('node_modules');
  });

  it('works without --import-json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inv2-'));
    await cp('test/fixtures/supabase-app', dir, { recursive: true });
    const r = await execa('node', ['skills/dbmanager/inventory.mjs', dir]);
    expect(r.stdout).toMatch(/0 policies, 0 import errors/);
  });

  it('redacts JWT-like secrets from snippets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inv3-'));
    await writeFile(
      join(dir, 'a.ts'),
      'const c = createClient("https://x.supabase.co", "eyJhbGciOiJIUzI1NiJ9.abc.def");\n',
    );
    await execa('node', ['skills/dbmanager/inventory.mjs', dir]);
    const md = await readFile(join(dir, 'MIGRATION.md'), 'utf8');
    expect(md).toContain('[redacted]');
    expect(md).not.toContain('eyJ');
  });
});
