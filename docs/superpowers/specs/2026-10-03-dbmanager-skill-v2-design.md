# /dbmanager v2: create, connect, or migrate — Design Spec

**Date:** 2026-10-03  **Status:** approved in conversation  **Scope:** `skills/dbmanager/` + two additions to the `dbm` CLI

## 1. Purpose

One entry point, `/dbmanager`, typed in a project folder, decides what the folder needs:

| Folder state | Mode | Outcome |
|---|---|---|
| Empty | **create** | Scaffold Next.js, provision a dbm project, wire templates (v1 behaviour) |
| Next.js app without Supabase | **connect** | Provision + wire (v1 behaviour, no scaffold) |
| Next.js app using `@supabase/supabase-js` | **migrate** | Provision + wire, import schema/data/files from Supabase, write a file-by-file migration checklist, optionally migrate users |
| Any of the above, invoked as `/dbmanager cutover` | **cutover** | Re-import data to match Supabase as of now, verify counts, switch Vercel env, print the two manual steps |

The skill stays a provisioning skill: it produces a wired app plus, in migrate mode, an exact to-do list. Rewriting application code is left to the user's development skills, guided by that list.

## 2. Non-goals

- Rewriting application code automatically.
- Migrating Supabase Edge Functions, Realtime, or OAuth identities (`auth.identities`) in v2; the checklist names them as manual items.
- Any Supabase mutation. Sources are read-only throughout.

## 3. Migrate mode (rehearsal)

1. **Detect**: preflight reports `supabase.detected` (package.json has `@supabase/supabase-js` or `@supabase/ssr`), the files that import it, and whether `NEXT_PUBLIC_SUPABASE_URL` exists in `.env*`.
2. **Ask once**: the Supabase connection string (direct or session pooler; the transaction pooler is rejected by `dbm import`) and, if the inventory shows Storage usage, the Supabase S3 endpoint, region, key, secret, and bucket names. Secrets are passed to `dbm` flags in the same shell command and never echoed.
3. **Provision** via the create/connect steps (templates, deps, `auth generate`, `drizzle-kit push`).
4. **Import**: `dbm import <slug> --from <url> [--storage-* per bucket] --users-out .dbm-users.csv`. The report's categories (auth.users FKs, `auth.uid()`, `storage.objects`, `extensions.*`, other) are copied into the checklist.
5. **Inventory**: `node ~/.claude/skills/dbmanager/inventory.mjs .` scans the repo and writes `MIGRATION.md`: for every `supabase-js` usage, the file, line, kind (`query`, `auth`, `storage`, `realtime`, `rpc`, `edge-function`, `client-init`), and the target pattern. It also lists the import report errors and the RLS policies found in the schema dump as explicit "re-implement in server code" items.
6. **Users**: ask which path. Re-register: nothing. Preserve: `npm i -D csv-parse && npm i bcryptjs`, copy `scripts/migrate-supabase-users.ts`, run it against `.dbm-users.csv`, patch `lib/auth.ts` with the bcrypt verify + rehash hook from the migration guide, delete the CSV.
7. **Hand off**: the v1 summary plus `MIGRATION.md`'s item count and: "Rewrite per MIGRATION.md with your development skills. When done: `/dbmanager cutover`."

## 4. Cutover mode

1. Preconditions: `MIGRATION.md` exists, `.env.local` has `DATABASE_URL`, the project is `running`.
2. `dbm import <slug> --from <url> --data-only --replace --yes --confirm <slug> [--users-out ...]`: truncates the previously imported tables (never better-auth's tables or drizzle's migration table), reloads data, and prints per-table source/target row counts.
3. Re-run the user script if the preserve path was chosen (idempotent on `user.id`).
4. Any table whose counts differ is a hard stop with the table named.
5. Vercel: push dbm env vars (two calls each), remove `NEXT_PUBLIC_SUPABASE_*` and `SUPABASE_*` with `vercel env rm`, set `BETTER_AUTH_URL` for production.
6. Print: deploy to production; verify; pause the Supabase project when satisfied; delete the Supabase S3 key.

## 5. `dbm` CLI additions (both tested in unit + integration suites)

- `dbm import ... --data-only`: skip the schema dump/restore; load data only.
- `dbm import ... --replace`: before loading data, `TRUNCATE ... RESTART IDENTITY CASCADE` every table of the imported schemas that exists in the target, except `user`, `session`, `account`, `verification`, `rateLimit`, `__drizzle_migrations`. Destructive on the target, so it requires the destroy-style confirmation (`--yes --confirm <slug>` non-interactively).
- `dbm import ... --users-out <file>`: after the import, export `auth.users` (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, raw_app_meta_data, created_at, updated_at, last_sign_in_at; `email IS NOT NULL AND deleted_at IS NULL`) as CSV to a local file with mode 0600. Works with or without `--data-only`.
- The import report gains `counts: Array<{ table, source, target }>` for every table in the imported schemas, printed as a table, and `rlsPolicies: string[]` (policy names found in the schema dump) so the checklist can list them.

## 6. Skill files

```
skills/dbmanager/
  SKILL.md          modes, recipes, hand-off contracts (target < 1600 words)
  preflight.sh      v1 fields + supabase: { detected, files[], envPresent } + mode suggestion
  inventory.mjs     zero-dependency Node script: scans *.ts/*.tsx/*.js/*.jsx, writes MIGRATION.md
```
`~/.claude/skills/dbmanager` remains a symlink to this directory.

## 7. Testing

- CLI: unit tests with fakes for flags, confirmation, truncate list exclusion, counts parsing, users export file mode; integration test against the compose stack: import a seeded "source" database into the project database twice (second time `--data-only --replace`), assert counts and that `user` rows survive.
- Inventory: unit test against `test/fixtures/supabase-app/` (a tiny Next.js tree with representative supabase-js usages) asserting the generated `MIGRATION.md` sections and counts.
- Skill: writing-skills TDD. RED: baseline agent on the fixture app without the skill. GREEN: dry-run with the skill. Real: one of the user's Supabase projects (chosen by the user), rehearsal then cutover.

## 8. Risks

- Direct Supabase hosts are IPv6-only without the add-on; the VPS may lack IPv6 egress. The skill tells the agent to fall back to the session pooler URL on a connection error.
- Large tables: `--replace` runs under one `session_replication_role = replica` session; the import timeout is 60 minutes.
- The inventory is heuristic. It must over-report (every file importing supabase) rather than under-report; the user prunes.
