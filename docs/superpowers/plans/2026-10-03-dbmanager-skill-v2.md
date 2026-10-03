# /dbmanager v2 (create · connect · migrate · cutover) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/dbmanager` handle an existing Supabase app as well as a new one: detect the mode from the folder, import schema/data/files/users from Supabase, write a file-by-file `MIGRATION.md`, and provide a `cutover` mode that re-syncs data, verifies row counts and switches Vercel env.

**Architecture:** Two small additions to the `dbm` CLI (`import --data-only --replace --users-out`, with per-table counts and RLS-policy detection in the report), a mode-aware `preflight.sh`, a zero-dependency `inventory.mjs` that produces `MIGRATION.md`, and a rewritten `SKILL.md` with four recipes. Everything stays provisioning-only; code rewriting is handed to the user's development skills via the checklist.

**Tech Stack:** existing repo toolchain (TS 7, Vitest 5, Biome, commander 15, execa), bash for preflight, plain Node ESM for the inventory, Docker compose stack for the integration test, superpowers:writing-skills for the skill itself.

**Spec:** `docs/superpowers/specs/2026-10-03-dbmanager-skill-v2-design.md` (read it first; also `docs/superpowers/specs/2026-09-30-db-manager-design.md` §7 `dbm import`, §13).

## Global Constraints

- Everything in the repo's existing Global Constraints applies (`docs/superpowers/plans/2026-09-30-db-manager.md`): secrets on stdin never argv, shlex-quote interpolations, `--json` stdout purity, exit codes 0/1/2/3, Biome clean, `erasableSyntaxOnly`.
- `dbm import` never writes to the source database. Every statement against `$SRC` is a `SELECT`, `COPY ... TO STDOUT`, or `pg_dump`.
- `--replace` must never truncate `user`, `session`, `account`, `verification`, `rateLimit`, `__drizzle_migrations`, and requires the destroy-style confirmation.
- The users CSV is written locally with mode 0600 and its contents are never printed.
- The skill must not contain Next.js development guidance; it ends at a summary + `MIGRATION.md`.
- `~/.claude/skills/dbmanager` is a symlink to `skills/dbmanager/`; edit the repo copy only.
- Commits end with a blank line and `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **A table that exists in the source but not the target** (schema import failed for it) must appear in `counts` with target `-`, not crash the import. Pinned in Task 1.
2. **`--replace` on a target whose better-auth tables hold migrated users** must leave those rows intact while reloading app tables. Pinned in Task 3 (integration).
3. **A Supabase app where `createClient` lives in one helper file and queries elsewhere**: the inventory must list the query files, not only the helper. Pinned in Task 5.
4. **`cutover` with mismatched counts** must stop before touching Vercel. Pinned in Task 6 (skill text) and Task 2 (`formatReport` flags mismatches).
5. **`--users-out` when the source has no `auth` schema** (a plain Postgres source) must produce a clear error, not an empty file. Pinned in Task 2.

---

## Task 1: `importScript` options — data-only, replace, counts, policies

**Files:**
- Modify: `src/commands/import.ts`, `test/commands/import.test.ts`

**Interfaces:**
- Consumes: `quote` (shlex), `userError`.
- Produces:
```ts
export const PROTECTED_TABLES = ['user','session','account','verification','rateLimit','__drizzle_migrations'] as const;
export function importScript(o: { src: string; dst: string; schemas: string[]; dataOnly?: boolean; replace?: boolean }): string;
export interface ImportCount { table: string; source: number; target: number | null }
export function parseImportOutput(out: string): { schemaErr: string; dataErr: string; counts: ImportCount[]; policies: string[] };
```

- [ ] **Step 1: Write the failing tests** (add to `test/commands/import.test.ts`)

```ts
describe('importScript options', () => {
  const base = { src: 'postgresql://u:p@h:5432/d', dst: 'postgresql://a:b@c:5432/e', schemas: ['public'] };
  it('lists tables once, dumps schema+data, prints policies and counts by default', () => {
    const s = importScript(base);
    expect(s).toContain(`TABLES=$(psql "$SRC" -Atc "select format('%I.%I', schemaname, tablename) from pg_tables where schemaname in ('public') order by 1")`);
    expect(s).toContain('--schema-only');
    expect(s).toContain("grep -E '^CREATE POLICY'");
    expect(s).toContain('---POLICIES---');
    expect(s).toContain('---COUNTS---');
    expect(s).not.toContain('TRUNCATE');
  });
  it('--data-only skips the schema dump/restore and the policies section', () => {
    const s = importScript({ ...base, dataOnly: true });
    expect(s).not.toContain('--schema-only');
    expect(s).not.toContain('---POLICIES---');
    expect(s).toContain('---DATA-ERRORS---');
  });
  it('--replace truncates imported tables that exist in the target, except protected ones', () => {
    const s = importScript({ ...base, replace: true });
    expect(s).toContain('---REPLACE---');
    expect(s).toContain('TRUNCATE TABLE $t RESTART IDENTITY CASCADE');
    for (const p of PROTECTED_TABLES) expect(s).toContain(`public.${p}`);
    expect(s).toContain(`to_regclass('$t') is not null`);
  });
  it('quotes multiple schema names in the pg_tables filter', () => {
    expect(importScript({ ...base, schemas: ['public', 'app'] })).toContain("schemaname in ('public','app')");
  });
});

describe('parseImportOutput', () => {
  it('extracts error sections, counts (with missing target as null) and policies', () => {
    const out = [
      '---SCHEMA-ERRORS---', 'psql:x: ERROR:  relation "auth.users" does not exist',
      '---POLICIES---', 'public.items: items_owner', 'public.items: items_admin',
      '---REPLACE---',
      '---DATA-ERRORS---',
      '---COUNTS---', 'public.items\t12\t12', 'public.profiles\t3\t-', 'public."Mixed"\t1\t1',
      '---END---',
    ].join('\n');
    const r = parseImportOutput(out);
    expect(r.schemaErr).toContain('auth.users');
    expect(r.policies).toEqual(['public.items: items_owner', 'public.items: items_admin']);
    expect(r.counts).toEqual([
      { table: 'public.items', source: 12, target: 12 },
      { table: 'public.profiles', source: 3, target: null },
      { table: 'public."Mixed"', source: 1, target: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/commands/import.test.ts`
Expected: FAIL (`PROTECTED_TABLES`, `parseImportOutput` not exported; script lacks sections).

- [ ] **Step 3: Implement** in `src/commands/import.ts`

Replace `importScript` with:
```ts
export const PROTECTED_TABLES = [
  'user', 'session', 'account', 'verification', 'rateLimit', '__drizzle_migrations',
] as const;

export interface ImportScriptOptions {
  src: string;
  dst: string;
  schemas: string[];
  dataOnly?: boolean;
  replace?: boolean;
}

export function importScript(o: ImportScriptOptions): string {
  checkSchemas(o.schemas);
  const schemaFlags = o.schemas.map((s) => quote(`--schema=${s}`)).join(' ');
  const schemaIn = o.schemas.map((s) => `'${s}'`).join(','); // names validated by SCHEMA_RE
  const protectedCase = PROTECTED_TABLES.map((t) => `public.${t}`).join('|');
  const schemaPhase = o.dataOnly
    ? ''
    : `pg_dump "$SRC" --schema-only --no-owner --no-privileges --no-comments --no-publications --no-subscriptions ${schemaFlags} -f /tmp/schema.sql || { echo '---DUMP-FAILED---'; exit 1; }
echo '---SCHEMA-ERRORS---'
psql "$DST" -v ON_ERROR_STOP=0 -q -f /tmp/schema.sql 2>&1 >/dev/null | grep -E 'ERROR|FATAL' || true
echo '---POLICIES---'
grep -E '^CREATE POLICY' /tmp/schema.sql | sed -E 's/^CREATE POLICY ("?[^" ]+"?) ON ([^ ]+).*/\\2: \\1/' || true
`;
  const replacePhase = o.replace
    ? `echo '---REPLACE---'
for t in $TABLES; do
  case "$t" in ${protectedCase}) continue;; esac
  if psql "$DST" -Atc "select to_regclass('$t') is not null" | grep -q t; then
    psql "$DST" -qc "TRUNCATE TABLE $t RESTART IDENTITY CASCADE" 2>&1 | grep -E 'ERROR' || true
  fi
done
`
    : '';
  return `set -u
SRC='${o.src.replaceAll("'", "'\\''")}'
DST='${o.dst.replaceAll("'", "'\\''")}'
TABLES=$(psql "$SRC" -Atc "select format('%I.%I', schemaname, tablename) from pg_tables where schemaname in (${schemaIn}) order by 1") || { echo '---DUMP-FAILED---'; exit 1; }
${schemaPhase}pg_dump "$SRC" --data-only --no-owner --no-privileges ${schemaFlags} -f /tmp/data.sql || { echo '---DUMP-FAILED---'; exit 1; }
${replacePhase}echo '---DATA-ERRORS---'
psql "$DST" -v ON_ERROR_STOP=0 -q -c 'SET session_replication_role = replica' -f /tmp/data.sql 2>&1 >/dev/null | grep -E 'ERROR|FATAL' || true
echo '---COUNTS---'
for t in $TABLES; do
  s=$(psql "$SRC" -Atc "select count(*) from $t" 2>/dev/null || echo '-')
  d=$(psql "$DST" -Atc "select count(*) from $t" 2>/dev/null || echo '-')
  printf '%s\\t%s\\t%s\\n' "$t" "$s" "$d"
done
echo '---END---'
`;
}

export interface ImportCount {
  table: string;
  source: number;
  target: number | null;
}

function section(out: string, start: string, ends: string[]): string {
  const i = out.indexOf(start);
  if (i < 0) return '';
  let rest = out.slice(i + start.length);
  for (const e of ends) {
    const j = rest.indexOf(e);
    if (j >= 0) rest = rest.slice(0, j);
  }
  return rest;
}

export function parseImportOutput(out: string): {
  schemaErr: string;
  dataErr: string;
  counts: ImportCount[];
  policies: string[];
} {
  const markers = ['---POLICIES---', '---REPLACE---', '---DATA-ERRORS---', '---COUNTS---', '---END---'];
  const schemaErr = section(out, '---SCHEMA-ERRORS---', markers);
  const policies = section(out, '---POLICIES---', ['---REPLACE---', '---DATA-ERRORS---', '---COUNTS---', '---END---'])
    .split('\n').map((l) => l.trim()).filter(Boolean);
  const dataErr = section(out, '---DATA-ERRORS---', ['---COUNTS---', '---END---']);
  const counts: ImportCount[] = section(out, '---COUNTS---', ['---END---'])
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const [table = '', s = '-', d = '-'] = l.split('\t');
      return { table, source: Number(s) || 0, target: d === '-' ? null : Number(d) };
    });
  return { schemaErr, dataErr, counts, policies };
}
```
Then make `importCommand` use `parseImportOutput(out)` instead of the two `split` lines (keep the `---END---` check).

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run --project unit test/commands/import.test.ts && npm run typecheck && npx biome ci .`

- [ ] **Step 5: Commit**

```bash
git add src/commands/import.ts test/commands/import.test.ts
git commit -m "feat(import): data-only and replace modes, per-table counts, RLS policy detection in the script"
```

---

## Task 2: `importCommand` + CLI — confirmation for replace, users export, counts in the report

**Files:**
- Modify: `src/commands/import.ts`, `src/cli.ts`, `test/commands/import.test.ts`, `test/helpers/fake-runner.ts` (only if needed)

**Interfaces:**
- Consumes: `requireConfirmation(deps, { slug, yes, confirmSlug }, action)` from `src/commands/destroy.ts`; `writeFile`/`chmod` from `node:fs/promises`.
- Produces:
```ts
export interface ImportOptions { /* existing */ dataOnly?: boolean; replace?: boolean; usersOut?: string; yes?: boolean; confirmSlug?: string }
export interface ImportReport { /* existing */ counts: ImportCount[]; rlsPolicies: string[]; usersExported: number | null; mismatched: string[] }
export function usersExportScript(src: string): string;
```

- [ ] **Step 1: Write the failing tests**

```ts
const OUT_OK = '---SCHEMA-ERRORS---\n---POLICIES---\npublic.items: items_owner\n---DATA-ERRORS---\n---COUNTS---\npublic.items\t2\t2\npublic.gone\t5\t-\n---END---';

describe('importCommand v2', () => {
  it('returns counts, policies and mismatches in the report', async () => {
    const runner = makeFakeRunner([{ match: /bash -s/, stdout: OUT_OK }]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    const r = await importCommand(t.deps, { slug: 'my-app', from: 'postgresql://u:p@h:5432/d' });
    expect(r.counts).toHaveLength(2);
    expect(r.rlsPolicies).toEqual(['public.items: items_owner']);
    expect(r.mismatched).toEqual(['public.gone']);
    expect(r.usersExported).toBeNull();
    const text = formatReport(r);
    expect(text).toMatch(/public\.items\s+2\s+2/);
    expect(text).toMatch(/MISMATCH.*public\.gone/);
    expect(text).toContain('RLS policies to re-implement in server code (1)');
  });
  it('--replace requires confirmation and passes replace/dataOnly into the script', async () => {
    const runner = makeFakeRunner([{ match: /bash -s/, stdout: OUT_OK }]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    t.deps.confirm = async () => false;
    await expect(importCommand(t.deps, { slug: 'my-app', from: 'postgresql://u:p@h:5432/d', replace: true, yes: false }))
      .rejects.toMatchObject({ exitCode: 1 });
    expect(t.runner.calls).toHaveLength(0);
    await importCommand(t.deps, { slug: 'my-app', from: 'postgresql://u:p@h:5432/d', replace: true, dataOnly: true, yes: true, confirmSlug: 'my-app' });
    const script = t.runner.calls[0]?.input ?? '';
    expect(script).toContain('---REPLACE---');
    expect(script).not.toContain('--schema-only');
  });
  it('--users-out exports auth.users to a 0600 CSV without printing it', async () => {
    const csv = 'id,email,encrypted_password\n1,a@b.c,$2a$10$x\n';
    const runner = makeFakeRunner([
      { match: /bash -s/, stdout: OUT_OK },
      { match: /bash -s/, stdout: csv },
    ]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    const dir = await mkdtemp(join(tmpdir(), 'dbm-users-'));
    const file = join(dir, 'auth-users.csv');
    const r = await importCommand(t.deps, { slug: 'my-app', from: 'postgresql://u:p@h:5432/d', usersOut: file });
    expect(r.usersExported).toBe(1);
    expect(await readFile(file, 'utf8')).toBe(csv);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(t.outLines.join('') + t.errLines.join('')).not.toContain('$2a$10$x');
    const exportCall = t.runner.calls[1];
    expect(exportCall?.input).toContain('COPY (');
    expect(exportCall?.input).toContain('FROM auth.users WHERE email IS NOT NULL AND deleted_at IS NULL');
  });
  it('--users-out on a source without an auth schema is a clear remote error', async () => {
    const runner = makeFakeRunner([
      { match: /bash -s/, stdout: OUT_OK },
      { match: /bash -s/, fail: true, stderr: 'ERROR:  relation "auth.users" does not exist' },
    ]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    await expect(importCommand(t.deps, { slug: 'my-app', from: 'postgresql://u:p@h:5432/d', usersOut: '/tmp/x.csv' }))
      .rejects.toMatchObject({ exitCode: 2, step: 'import.users', message: /auth\.users/ });
  });
});
```
`makeFakeRunner` currently returns the first matching responder for every call, so both `bash -s` calls would get the import output. Extend `test/helpers/fake-runner.ts` first: add `once?: boolean` to the responder type and, when set, remove the responder from the list after it matches (`responders.splice(idx, 1)`). Mark the two `bash -s` responders in the users tests `once: true` (import first, export second). Existing tests are unaffected because they never set the flag.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/commands/import.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/commands/import.ts`:
```ts
import { chmod, writeFile } from 'node:fs/promises';
import { requireConfirmation } from './destroy.js';

export function usersExportScript(src: string): string {
  return `set -u
SRC='${src.replaceAll("'", "'\\''")}'
psql "$SRC" -v ON_ERROR_STOP=1 -Atc "COPY (
  SELECT id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, raw_app_meta_data,
         created_at, updated_at, last_sign_in_at
  FROM auth.users WHERE email IS NOT NULL AND deleted_at IS NULL
) TO STDOUT WITH (FORMAT csv, HEADER)"
`;
}
```
In `importCommand`, after the existing validations and before the dump:
```ts
  if (o.replace)
    await requireConfirmation(deps, { slug: o.slug, yes: o.yes ?? false, ...(o.confirmSlug ? { confirmSlug: o.confirmSlug } : {}) }, 'truncate the imported tables of');
```
Pass `dataOnly: o.dataOnly, replace: o.replace` into `importScript`. After parsing:
```ts
  const parsed = parseImportOutput(out);
  const errors = classifyErrors(`${parsed.schemaErr}\n${parsed.dataErr}`);
  const mismatched = parsed.counts.filter((c) => c.target === null || c.target !== c.source).map((c) => c.table);
```
Users export (after storage copy):
```ts
  let usersExported: number | null = null;
  if (o.usersOut) {
    deps.io.err('exporting auth.users...\n');
    let csv: string;
    try {
      csv = (await deps.ssh.run(
        ['docker', 'run', '--rm', '-i', '--network', deps.cfg.remote.dockerNetwork, IMAGES.postgres18, 'bash', '-s'],
        { input: usersExportScript(o.from), timeoutMs: 30 * 60_000 },
      )).stdout;
    } catch (e) {
      throw remoteError(`could not export auth.users (is this a Supabase source?): ${e instanceof Error ? e.message : String(e)}`, 'import.users');
    }
    await writeFile(o.usersOut, csv.endsWith('\n') ? csv : `${csv}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(o.usersOut, 0o600);
    usersExported = Math.max(0, csv.trim().split('\n').length - 1);
  }
  return { slug: o.slug, schemas, errors, storageSynced, counts: parsed.counts, rlsPolicies: parsed.policies, usersExported, mismatched };
```
`formatReport`: append a counts table (`table  source  target`, with ` MISMATCH` on rows whose target is null or differs), a section `RLS policies to re-implement in server code (N)` listing `rlsPolicies`, and `users exported: N -> <file>` when applicable. Mismatches also print a final line `COUNT MISMATCH in: a, b` so a cutover can grep it.

In `src/cli.ts` import command add:
```ts
    .option('--data-only', 'skip schema; load data only (rehearsal already created the schema)', false)
    .option('--replace', 'truncate previously imported tables before loading (needs confirmation)', false)
    .option('--users-out <file>', 'export auth.users to a local CSV (mode 0600) for scripts/migrate-supabase-users.ts')
    .option('--confirm <slug>', 'required with --yes --replace')
```
and pass `dataOnly`, `replace`, `usersOut`, `yes: g.yes`, `confirmSlug`. In `--json` mode the report JSON includes `counts`, `rlsPolicies`, `mismatched`, `usersExported`.

- [ ] **Step 4: Run tests, expect pass**

Run: `npm run test:unit && npm run typecheck && npx biome ci .`

- [ ] **Step 5: Commit**

```bash
git add src/commands/import.ts src/cli.ts test/commands/import.test.ts test/helpers/fake-runner.ts
git commit -m "feat(import): --replace with confirmation, --users-out CSV export, counts/policies/mismatches in the report"
```

---

## Task 3: Integration test — rehearsal import, then `--data-only --replace`

**Files:**
- Modify: `test/integration/stack.test.ts`

**Interfaces:**
- Consumes: `importScript`, `parseImportOutput`, `PROTECTED_TABLES` from `src/commands/import.js`; `pgAdmin` (`makePostgresAdmin(testRunner, ...)`), `admin` target, `APP_PW`, `testRunner` from the file.

- [ ] **Step 1: Write the test** (append a new `describe`)

```ts
describe('import (rehearsal, then cutover --data-only --replace)', () => {
  const SRC = 'postgresql://test_admin:adminpw@dbm-test-pg:5432/src_db';
  const DST = `postgresql://my_app_app:${encodeURIComponent(APP_PW)}@dbm-test-pg:5432/my_app`;
  async function runImport(opts: { dataOnly?: boolean; replace?: boolean }) {
    const r = await testRunner.run(
      ['docker', 'run', '--rm', '-i', '--network', 'dbmtest', 'postgres:18', 'bash', '-s'],
      { input: importScript({ src: SRC, dst: DST, schemas: ['public'], ...opts }), timeoutMs: 180_000 },
    );
    expect(r.stdout, r.stdout).toContain('---END---');
    return parseImportOutput(r.stdout);
  }
  beforeAll(async () => {
    await pgAdmin.runSql(admin, `DROP DATABASE IF EXISTS src_db; CREATE DATABASE src_db;`);
    await pgAdmin.runSql({ ...admin, database: 'src_db' }, `
      CREATE TABLE items (id serial PRIMARY KEY, name text NOT NULL);
      CREATE TABLE profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), display_name text);
      ALTER TABLE items ENABLE ROW LEVEL SECURITY;
      CREATE POLICY items_owner ON items USING (true);
      INSERT INTO items (name) VALUES ('a'), ('b'), ('c');
      INSERT INTO profiles (display_name) VALUES ('p1');`);
    // the app role needs the same grant create.ts gives in production
    await pgAdmin.runSql(admin, `GRANT SET ON PARAMETER session_replication_role TO my_app_app;`);
    // better-auth-like table that must survive --replace
    await pgAdmin.runSql({ ...admin, database: 'my_app' }, `
      DROP TABLE IF EXISTS "user"; CREATE TABLE "user" (id text PRIMARY KEY, email text);
      ALTER TABLE "user" OWNER TO my_app_app;
      INSERT INTO "user" VALUES ('u1', 'keep@me.test');
      DROP TABLE IF EXISTS items; DROP TABLE IF EXISTS profiles;`);
  });

  it('rehearsal: schema + data land, policies are reported, counts match', async () => {
    const r = await runImport({});
    expect(r.policies).toEqual(['public.items: items_owner']);
    expect(r.counts).toEqual(expect.arrayContaining([
      { table: 'public.items', source: 3, target: 3 },
      { table: 'public.profiles', source: 1, target: 1 },
    ]));
  });

  it('cutover: --data-only --replace reloads changed data without duplicates and keeps "user" rows', async () => {
    await pgAdmin.runSql({ ...admin, database: 'src_db' }, `INSERT INTO items (name) VALUES ('d'); DELETE FROM profiles;`);
    const r = await runImport({ dataOnly: true, replace: true });
    expect(r.policies).toEqual([]);
    expect(r.counts).toEqual(expect.arrayContaining([
      { table: 'public.items', source: 4, target: 4 },
      { table: 'public.profiles', source: 0, target: 0 },
    ]));
    const users = await pgAdmin.runSql({ ...admin, database: 'my_app' }, `select count(*) from "user";`);
    expect(users.trim()).toBe('1');
    expect(PROTECTED_TABLES).toContain('user');
  });
});
```

- [ ] **Step 2: Run the integration suite**

Run: `npm run test:integration`
Expected: new tests pass (Docker must be running). If `GRANT SET ON PARAMETER` fails, Postgres is < 15; the compose stack pins 18, so investigate rather than remove the grant.

- [ ] **Step 3: Commit**

```bash
git add test/integration/stack.test.ts
git commit -m "test(integration): import rehearsal then --data-only --replace against a seeded source database"
```

---

## Task 4: `preflight.sh` — Supabase detection and mode

**Files:**
- Modify: `skills/dbmanager/preflight.sh`
- Create: `test/fixtures/supabase-app/` (also used by Task 5), `test/unit/skill-preflight.test.ts`

**Interfaces:**
- Produces new JSON fields: `"mode": "create"|"connect"|"migrate"|"unknown"`, `"supabase": { "detected": bool, "files": string[], "envPresent": bool }`.

- [ ] **Step 1: Create the fixture app** (minimal, no node_modules):

`test/fixtures/supabase-app/package.json`
```json
{ "name": "fixture", "private": true, "dependencies": { "next": "16.3.8", "@supabase/supabase-js": "2.49.0", "@supabase/ssr": "0.6.1" } }
```
`test/fixtures/supabase-app/lib/supabase.ts`
```ts
import { createBrowserClient } from "@supabase/ssr";
export const supabase = createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
```
`test/fixtures/supabase-app/app/page.tsx`
```tsx
"use client";
import { supabase } from "@/lib/supabase";
export default async function Page() {
  const { data } = await supabase.from("posts").select("*").eq("published", true);
  const { data: { user } } = await supabase.auth.getUser();
  const { data: url } = supabase.storage.from("avatars").getPublicUrl("x.png");
  const ch = supabase.channel("posts").on("postgres_changes", { event: "*", schema: "public" }, () => {}).subscribe();
  await supabase.rpc("increment_views", { post_id: 1 });
  await supabase.functions.invoke("send-email");
  return null;
}
```
`test/fixtures/supabase-app/app/actions.ts`
```ts
"use server";
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
export async function del(id: number) { await admin.from("posts").delete().eq("id", id); }
```
`test/fixtures/supabase-app/.env.local.example` (NOT `.env.local`, which is gitignored): `NEXT_PUBLIC_SUPABASE_URL=https://ref.supabase.co` — the preflight test copies it to `.env.local` in a temp dir.

- [ ] **Step 2: Write the failing test** `test/unit/skill-preflight.test.ts`

```ts
import { cp, mkdtemp, rename } from 'node:fs/promises';
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
    await rename(join(dir, '.env.local.example'), join(dir, '.env.local'));
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
    await execa('node', ['-e', `const f=require('fs');const p=JSON.parse(f.readFileSync('${dir}/package.json'));delete p.dependencies['@supabase/supabase-js'];delete p.dependencies['@supabase/ssr'];f.writeFileSync('${dir}/package.json',JSON.stringify(p))`]);
    expect((await preflight(dir)).mode).toBe('connect');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run --project unit test/unit/skill-preflight.test.ts`
Expected: FAIL (`mode` undefined).

- [ ] **Step 4: Implement** in `preflight.sh`, after the folder-state block:

```bash
# 7. supabase detection
SB_DETECTED=false; SB_ENV=false; SB_FILES_JSON="[]"
if [ "$HAS_PKG" = true ] && grep -qE '"@supabase/(supabase-js|ssr)"' "$DIR/package.json"; then
  SB_DETECTED=true
  SB_FILES_JSON="$(cd "$DIR" && grep -rlE "from ['\"]@supabase/" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' . 2>/dev/null \
    | grep -vE '/(node_modules|\.next|dist)/' | sed 's#^\./##' | sort | head -200 \
    | python3 -c 'import json,sys; print(json.dumps([l.rstrip("\n") for l in sys.stdin if l.strip()]))')"
fi
for f in "$DIR"/.env "$DIR"/.env.local "$DIR"/.env.development "$DIR"/.env.production; do
  [ -f "$f" ] && grep -q 'NEXT_PUBLIC_SUPABASE_URL\|SUPABASE_URL' "$f" && SB_ENV=true
done

# 8. mode
if [ "$EMPTY" = true ]; then MODE=create
elif [ "$IS_NEXT" = true ] && [ "$SB_DETECTED" = true ]; then MODE=migrate
elif [ "$IS_NEXT" = true ]; then MODE=connect
else MODE=unknown; fi
```
and add to the JSON: `"mode": "$MODE",` and `"supabase": { "detected": $SB_DETECTED, "files": $SB_FILES_JSON, "envPresent": $SB_ENV },`.

- [ ] **Step 5: Run tests, expect pass; commit**

Run: `npx vitest run --project unit test/unit/skill-preflight.test.ts && bash -n skills/dbmanager/preflight.sh`

```bash
git add skills/dbmanager/preflight.sh test/fixtures/supabase-app test/unit/skill-preflight.test.ts
git commit -m "feat(skill): preflight detects Supabase apps and reports the mode"
```

---

## Task 5: `inventory.mjs` — generate `MIGRATION.md`

**Files:**
- Create: `skills/dbmanager/inventory.mjs`, `test/unit/skill-inventory.test.ts`

**Interfaces:**
- CLI: `node skills/dbmanager/inventory.mjs <dir> [--import-json <file>] [--out MIGRATION.md]`. Exit 0; writes the file; prints one summary line `MIGRATION.md: <N> usages in <F> files, <P> policies, <E> import errors`.
- Kinds and target patterns (the mapping table written into the file):

| kind | detector (per line) | target |
|---|---|---|
| client-init | `createClient(`, `createBrowserClient(`, `createServerClient(` | delete; import `db` from `@/lib/db` in server code, `authClient` from `@/lib/auth-client` in client code |
| query | `.from(` (not preceded by `.storage`) | Drizzle query in a server action / route handler; client components call the action |
| auth | `.auth.` | better-auth: `authClient.signIn.email` / `signUp.email` / `signOut` / `useSession` on the client; `auth.api.getSession({ headers })` on the server |
| storage | `.storage.` | presigned URLs from `@/lib/s3` (`getPresignedUploadUrl`, `getPresignedDownloadUrl`); public files via `S3_PUBLIC_BASE_URL` after `dbm storage public` |
| realtime | `.channel(` or `postgres_changes` | not provided by dbm; polling, server-sent events, or a later `LISTEN/NOTIFY` bridge (manual decision) |
| rpc | `.rpc(` | call the SQL function with Drizzle `sql\`select fn(...)\`` from a server action, or move the logic into TypeScript |
| edge-function | `.functions.invoke(` | Next.js route handler or server action (manual) |

- [ ] **Step 1: Write the failing test** `test/unit/skill-inventory.test.ts`

```ts
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
    await writeFile(report, JSON.stringify({
      slug: 'fixture', schemas: ['public'],
      errors: { authUsers: ['ERROR: relation "auth.users" does not exist'], authUid: [], storageObjects: [], extensions: [], other: [] },
      storageSynced: true, counts: [{ table: 'public.posts', source: 10, target: 10 }], rlsPolicies: ['public.posts: posts_owner'], usersExported: 3, mismatched: [],
    }));
    const r = await execa('node', ['skills/dbmanager/inventory.mjs', dir, '--import-json', report]);
    expect(r.stdout).toMatch(/MIGRATION\.md: 8 usages in 3 files, 1 policies, 1 import errors/);
    const md = await readFile(join(dir, 'MIGRATION.md'), 'utf8');
    for (const kind of ['client-init', 'query', 'auth', 'storage', 'realtime', 'rpc', 'edge-function']) expect(md).toContain(`\`${kind}\``);
    expect(md).toContain('app/page.tsx:4'); // the .from("posts") query line
    expect(md).toContain('app/actions.ts');  // query via a helper-free admin client (Review Focus 3)
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/unit/skill-inventory.test.ts`
Expected: FAIL (script missing).

- [ ] **Step 3: Implement** `skills/dbmanager/inventory.mjs` (zero dependencies):

```js
#!/usr/bin/env node
// Scan a Next.js project for supabase-js usage and write MIGRATION.md (a checklist for the rewrite).
// Usage: node inventory.mjs <dir> [--import-json <dbm import --json output>] [--out MIGRATION.md]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const dir = args[0] && !args[0].startsWith('--') ? args[0] : process.cwd();
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const outFile = join(dir, opt('--out') ?? 'MIGRATION.md');
const report = opt('--import-json') ? JSON.parse(readFileSync(opt('--import-json'), 'utf8')) : null;

const SKIP = new Set(['node_modules', '.next', 'dist', '.git', 'out', 'coverage']);
const EXT = /\.(tsx?|jsx?|mjs|cjs)$/;
const KINDS = [
  { kind: 'client-init', re: /\b(createClient|createBrowserClient|createServerClient)\s*\(/, target: 'delete; server code imports `db` from `@/lib/db`, client code imports `authClient` from `@/lib/auth-client`' },
  { kind: 'storage', re: /\.storage\s*\./, target: 'presigned URLs from `@/lib/s3` (`getPresignedUploadUrl` / `getPresignedDownloadUrl`); public files via `S3_PUBLIC_BASE_URL` after `dbm storage public <slug>`' },
  { kind: 'query', re: /(?<!\.storage)\.from\s*\(/, target: 'Drizzle query inside a server action or route handler; client components call the action' },
  { kind: 'auth', re: /\.auth\s*\./, target: 'better-auth: `authClient.signIn.email` / `signUp.email` / `signOut` / `useSession` (client); `auth.api.getSession({ headers: await headers() })` (server)' },
  { kind: 'realtime', re: /\.channel\s*\(|postgres_changes/, target: 'not provided by dbm: polling, server-sent events, or a later LISTEN/NOTIFY bridge (decide manually)' },
  { kind: 'rpc', re: /\.rpc\s*\(/, target: 'call the SQL function with Drizzle `sql`select fn(...)`` from a server action, or move the logic to TypeScript' },
  { kind: 'edge-function', re: /\.functions\s*\.invoke\s*\(/, target: 'Next.js route handler or server action (manual)' },
];

function walk(d, acc = []) {
  for (const name of readdirSync(d)) {
    if (SKIP.has(name)) continue;
    const p = join(d, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (EXT.test(name)) acc.push(p);
  }
  return acc;
}

const usages = [];
const files = new Set();
for (const file of walk(dir)) {
  const text = readFileSync(file, 'utf8');
  const touchesSupabase = /@supabase\//.test(text) || /\bsupabase\b/.test(text);
  if (!touchesSupabase) continue;
  const rel = relative(dir, file);
  const isClient = /^\s*["']use client["']/m.test(text);
  text.split('\n').forEach((line, i) => {
    for (const k of KINDS) {
      if (k.re.test(line)) {
        usages.push({ file: rel, line: i + 1, kind: k.kind, snippet: line.trim().slice(0, 100), isClient });
        files.add(rel);
      }
    }
  });
}

const byKind = Object.fromEntries(KINDS.map((k) => [k.kind, usages.filter((u) => u.kind === k.kind).length]));
const policies = report?.rlsPolicies ?? [];
const importErrors = report ? Object.values(report.errors ?? {}).flat() : [];
const clientQueries = usages.filter((u) => u.isClient && (u.kind === 'query' || u.kind === 'rpc'));

const md = [];
md.push('# Migration checklist: Supabase -> dbm', '');
md.push(`Generated by /dbmanager. ${usages.length} supabase-js usages in ${files.size} files. Rewrite each item, delete it from this list, and run \`/dbmanager cutover\` when the list is empty.`, '');
md.push('## 1. Mapping', '', '| kind | count | target pattern |', '|---|---|---|');
for (const k of KINDS) md.push(`| \`${k.kind}\` | ${byKind[k.kind]} | ${k.target} |`);
md.push('');
if (clientQueries.length) {
  md.push('## 2. Client components that touch the database ("use client" + query/rpc)', '', 'These move to server actions; the component keeps only the call.', '');
  for (const u of clientQueries) md.push(`- [ ] ${u.file}:${u.line} \`${u.snippet}\``);
  md.push('');
}
md.push('## 3. Per file', '');
for (const f of [...files].sort()) {
  md.push(`### ${f}`, '');
  for (const u of usages.filter((u) => u.file === f)) md.push(`- [ ] L${u.line} \`${u.kind}\` -> ${KINDS.find((k) => k.kind === u.kind).target.split(';')[0]}  \n  \`${u.snippet}\``);
  md.push('');
}
md.push('## 4. Schema items from `dbm import`', '');
if (!report) md.push('_Run `dbm import <slug> --from <url> --json > .dbm-import.json` and re-run the inventory with `--import-json .dbm-import.json` to fill this section._', '');
else {
  md.push(`### RLS policies to re-implement in server code (${policies.length})`, '');
  for (const p of policies) md.push(`- [ ] ${p}`);
  md.push('', `### Import errors to fix in the schema (${importErrors.length})`, '');
  for (const e of importErrors) md.push(`- [ ] ${e}`);
  if (report.mismatched?.length) md.push('', `**Count mismatches:** ${report.mismatched.join(', ')}`);
  if (report.usersExported != null) md.push('', `Users exported: ${report.usersExported} (see the Users section of docs/migration-from-supabase.md)`);
  md.push('');
}
md.push('## 5. Always', '', '- [ ] Foreign keys to `auth.users(id)` -> `"user"(id)`', '- [ ] Remove `NEXT_PUBLIC_SUPABASE_*` / `SUPABASE_*` env vars after cutover', '- [ ] `npm rm @supabase/supabase-js @supabase/ssr` after the last usage is gone', '- [ ] OAuth identities (`auth.identities`) are not migrated automatically', '');
writeFileSync(outFile, md.join('\n'));
console.log(`MIGRATION.md: ${usages.length} usages in ${files.size} files, ${policies.length} policies, ${importErrors.length} import errors`);
```

- [ ] **Step 4: Run tests, expect pass** (adjust the expected usage count in the test to what the fixture really yields if it differs from 8, and say so in the commit message)

Run: `npx vitest run --project unit test/unit/skill-inventory.test.ts && npx biome ci .` (add `skills/dbmanager/inventory.mjs` to Biome's `files.includes` exclusions only if its style rules fight the plain-JS style; prefer making it pass.)

- [ ] **Step 5: Commit**

```bash
git add skills/dbmanager/inventory.mjs test/unit/skill-inventory.test.ts
git commit -m "feat(skill): inventory.mjs writes MIGRATION.md from supabase-js usage and the import report"
```

---

## Task 6: `SKILL.md` v2 — four modes, test-first

**REQUIRED SUB-SKILL:** superpowers:writing-skills (RED baseline → GREEN → refactor). Also read `skills/dbmanager/SKILL.md` (v1) and keep its create/connect recipe intact.

**Files:**
- Modify: `skills/dbmanager/SKILL.md`
- Create (scratch, not committed): a copy of `test/fixtures/supabase-app/` in a temp folder for the dry-run agents.

- [ ] **Step 1: RED baseline.** Dispatch a subagent (dry-run rules as in the v1 campaign: read-only, no resources) into the fixture copy with the prompt "/dbmanager — migrate this project off Supabase so I can keep developing" and NO reference to the new skill text (point it only at the v1 skill). Record verbatim: does it detect migrate mode, what it does about Supabase data/users/storage, whether it rewrites code itself, whether it asks for secrets safely.

- [ ] **Step 2: Write the v2 skill.** Structure (frontmatter description must stay triggers-only; add "existing Supabase project", "migrate off Supabase", "/dbmanager cutover"):

```
# dbmanager
Overview (unchanged purpose + the mode table from the spec)
## 1. Preflight  (v1 table + `mode`; `/dbmanager cutover` typed by the user overrides mode = cutover)
## 2. create / connect  (v1 steps 2-11 unchanged, referenced not repeated)
## 3. migrate (rehearsal)
   3.1 Ask once: Supabase URL (direct/session pooler; never 6543), and only if preflight files contain `.storage.`: S3 endpoint/region/key/secret + bucket names.
   3.2 Run the connect recipe (templates, deps, auth generate, drizzle-kit push). Keep the Supabase env vars in .env.local for now.
   3.3 dbm import <slug> --from "$URL" [--storage-... per bucket] --users-out .dbm-users.csv --json > .dbm-import.json   (secrets only in this one command; never echo)
   3.4 node ~/.claude/skills/dbmanager/inventory.mjs . --import-json .dbm-import.json ; rm .dbm-import.json
   3.5 Users: ask "re-register" or "preserve accounts". Preserve → npm i -D csv-parse && npm i bcryptjs; cp <dbmRoot>/scripts/migrate-supabase-users.ts scripts/; npx tsx scripts/migrate-supabase-users.ts .dbm-users.csv; apply the bcrypt verify + rehash hook from <dbmRoot>/docs/migration-from-supabase.md to lib/auth.ts; rm .dbm-users.csv. Re-register → rm .dbm-users.csv.
   3.6 Hand-off summary (v1 summary + "MIGRATION.md: N items" + "when the list is empty: /dbmanager cutover"). Stop. Do not rewrite code.
## 4. cutover
   4.1 Preconditions: MIGRATION.md exists; grep -c '^- \[ \]' MIGRATION.md == 0 (else list the remaining items and stop); project running.
   4.2 dbm import <slug> --from "$URL" --data-only --replace --yes --confirm <slug> [--users-out .dbm-users.csv] --json > .dbm-import.json
   4.3 If the JSON `mismatched` is non-empty: print the tables and STOP (Review Focus 4). Else re-run the users script if preserve was chosen; rm the CSV/JSON.
   4.4 Vercel (linked): push dbm env (two calls each); `vercel env rm NEXT_PUBLIC_SUPABASE_URL production preview development --yes` and the same for NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY when present; set BETTER_AUTH_URL production. Not linked: print the commands.
   4.5 Print exactly: deploy to production; verify sign-in and one write; pause the Supabase project; delete the Supabase S3 key.
## Rules (v1 + "never run `dbm import --replace` outside cutover", "never read .dbm-users.csv into the chat")
## Common mistakes (from the RED baseline, verbatim counters)
```
Keep the whole file under 1600 words; move the mapping table out (it lives in `MIGRATION.md` produced by the script).

- [ ] **Step 3: GREEN dry-run.** Same prompt, agent reads the new skill. It must: report mode `migrate`, ask for the URL and (because the fixture uses `.storage.`) the S3 details in one message, plan `dbm import --users-out`, run the inventory, offer the two user paths, and end at the summary without proposing code changes. Record gaps verbatim.

- [ ] **Step 4: Refactor** the skill for each gap; re-run the dry run until it complies. Then a cutover dry run: in the fixture copy, create `MIGRATION.md` with one unchecked item → the agent must stop and list it; with zero unchecked items → it must plan `dbm import --data-only --replace --yes --confirm` and the Vercel removal lines.

- [ ] **Step 5: Commit**

```bash
git add skills/dbmanager/SKILL.md
git commit -m "feat(skill): /dbmanager v2 — migrate (rehearsal) and cutover modes"
```

---

## Task 7: Docs

**Files:**
- Modify: `README.md` (Commands table: new `import` flags; a "Migrating from Supabase" paragraph pointing to `/dbmanager`), `docs/migration-from-supabase.md` (lead with the skill flow; document `--data-only --replace --users-out`, counts and policies in the report; keep the by-hand section), `docs/runbook.md` (cutover rollback: `dbm restore <slug> <pre-cutover-backup>`; recommend `dbm backup <slug>` right before cutover — add that to the skill's 4.2 as the first command).

- [ ] **Step 1:** Make the edits. Add `dbm backup <slug>` before the replace import in the skill's cutover recipe if Task 6 did not already (it is the rollback point).
- [ ] **Step 2:** `npm run lint && npm run typecheck && npm run test:unit && npm run build`.
- [ ] **Step 3:** Commit: `docs: supabase migration via /dbmanager, import v2 flags, cutover rollback`.

---

## Task 8: Real-world run (with the user)

Not automatable from the plan; the user supplies a Supabase project (preferably small, using Supabase Auth). Steps the executor performs with them present:

1. `cp -r` the app into a scratch branch/folder; `/dbmanager` → confirm mode `migrate`, provide the URL and S3 details when asked.
2. Check `MIGRATION.md` by eye against the app; note misses as inventory gaps (fix in `inventory.mjs` with a fixture addition + test, then re-run).
3. Choose "preserve accounts"; confirm a migrated user can sign in locally with their old password (proves the bcrypt hook) and that the hash is rehashed afterwards (`select password from account where "userId"='…'` no longer starts with `$2`).
4. After the user finishes the rewrite (later session): `/dbmanager cutover`; verify counts; deploy.

Record every finding in `docs/superpowers/research/e2e-migration-<date>.md`.
