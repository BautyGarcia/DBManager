---
name: dbmanager
description: Use when the user wants to start building a new app or MVP, says "/dbmanager", "/dbmanager cutover", "set this project up on dbm", "scaffold the backend", "connect this app to my database platform", "migrate off Supabase", or asks for a database, auth or file storage for a Next.js project on their own VPS. Also when an existing Next.js app or an existing Supabase project must be moved to or wired to the dbm platform.
---

# dbmanager: provision an app on the operator's dbm platform

`dbm` is the operator's CLI for their self-hosted platform (Postgres, better-auth, Garage S3, backups). This skill wires a folder to a dbm project and stops; features and the Supabase rewrite belong to the user's own skills.

| Mode | Folder | Recipe |
|---|---|---|
| `create` | empty | §2 |
| `connect` | Next.js app, no Supabase | §2 (skip step 3) |
| `migrate` | Next.js app using `@supabase/*` | §3 |
| `cutover` | user typed `/dbmanager cutover` | §4 |

## 1. Preflight

```bash
bash ~/.claude/skills/dbmanager/preflight.sh "$PWD"
```

| Field | If false/empty |
|---|---|
| `dbm` | run `dbmInstallHint`, re-run preflight |
| `dbmImportV2` false | STOP: the installed dbm is older than this skill. In the db-manager checkout run `npm run build` (and `npm link` once), then re-run preflight. Never drop flags from the commands in this skill. |
| `configured` | STOP: the operator must run `dbm init` first |
| `templatesDir` | STOP: dbm install is broken |
| `slugOk` | derive a corrected slug (§2.2) and ask |
| `mode` = `unknown` | STOP: non-Next project; ask what to do |
| `hasJq` | `brew install jq` |

`mode` picks the recipe; a typed `/dbmanager cutover` makes it `cutover` (preflight saying `migrate` is then normal). Keep `dbmRoot`.

## 2. create / connect

1. Preflight (§1).
2. **Slug**: preflight's `slug` (3-31 chars, `[a-z0-9-]`, starts with a letter, `dbm-` reserved). State it in one line.
3. **Scaffold** (create only):
   ```bash
   npx --yes create-next-app@latest . --ts --app --no-tailwind --no-eslint --no-src-dir --import-alias "@/*" --use-npm --yes
   ```
   Fixed flags. No commits.
4. **Provision**: `dbm create <slug> --json > .dbm-create.json` (secrets; never print it). Exit 1 with status `provisioning`: STOP; user runs `dbm destroy <slug>`.
5. **`.env.local`**. No `.env.local` yet:
   ```bash
   jq -r '.env | to_entries[] | select(.value != "") | "\(.key)=\(.value)"' .dbm-create.json > .env.local
   ```
   `.env.local` exists: append; same-named old keys get commented out, Supabase keys stay:
   ```bash
   for k in $(jq -r '.env | to_entries[] | select(.value != "") | .key' .dbm-create.json); do perl -i -pe "s/^\Q$k\E=/# pre-dbm $k=/" .env.local; done
   [ -z "$(tail -c1 .env.local)" ] || echo >> .env.local
   jq -r '.env | to_entries[] | select(.value != "") | "\(.key)=\(.value)"' .dbm-create.json >> .env.local
   ```
   Then:
   ```bash
   chmod 600 .env.local && rm .dbm-create.json
   for p in '.env*' '!.env.example' '.dbm-*'; do grep -Fqx "$p" .gitignore || printf '%s\n' "$p" >> .gitignore; done
   ```
   `BETTER_AUTH_URL` stays unset locally.
6. **Templates** (verbatim):
   ```bash
   T="<templatesDir>"
   mkdir -p lib "app/api/auth/[...all]"
   cp "$T"/lib/{db,schema,auth,auth-client,s3}.ts lib/
   cp "$T/app/api/auth/[...all]/route.ts" "app/api/auth/[...all]/"
   cp "$T/drizzle.config.ts" "$T/vercel.json" "$T/.env.example" .
   ```
   With an existing `vercel.ts`, skip `vercel.json`; add `regions: ['gru1']` there.
7. **Dependencies** (never install `pg`; drizzle-kit would prefer it):
   ```bash
   npm i better-auth@^1.7.6 drizzle-orm@^0.45.3 postgres@^3.4.9 @aws-sdk/client-s3@^3.1144.0 @aws-sdk/s3-request-presigner@^3.1144.0
   npm i -D drizzle-kit@^0.31.11 auth@^1.7.6
   ```
8. **Schema**:
   ```bash
   npx auth generate --config lib/auth.ts --output lib/auth-schema.ts -y
   npx drizzle-kit push
   ```
   A first "Missing tables" line is expected. Pooler/TLS error: STOP, report verbatim.
9. **Scripts** (merges, keeps existing):
   ```bash
   node -e 'const fs=require("fs"),p=JSON.parse(fs.readFileSync("package.json","utf8"));p.scripts={...p.scripts,"auth:schema":"auth generate --config lib/auth.ts --output lib/auth-schema.ts -y","db:push":"drizzle-kit push","db:generate":"drizzle-kit generate","db:migrate":"drizzle-kit migrate"};fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'
   ```
10. **Vercel** (only if `vercelLinked` and `hasVercelCli`; never `vercel link`). Two calls per variable:
    ```bash
    eval "$(dbm env <slug> --json | jq -r 'to_entries[] | select(.value != "") | "export \(.key)=\(.value|@sh)"')"
    for k in DATABASE_URL DATABASE_URL_SESSION BETTER_AUTH_SECRET S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
      vercel env add "$k" production,preview --value "$(printenv "$k")" --yes --force
      vercel env add "$k" development --value "$(printenv "$k")" --yes --force
    done
    ```
    Production domain known: `vercel env add BETTER_AUTH_URL production --value "https://<domain>" --yes --force`.
11. **Verify and hand off**. Require the `TSC_OK` line from `npx tsc --noEmit && echo TSC_OK`; on failure report the errors verbatim and stop. DB host without secrets: `grep '^DATABASE_URL=' .env.local | sed -E 's|.*@([^/:]+).*|\1|'`. End with:
    ```
    Project <slug> is provisioned.
    - Database: Postgres 18 via <db-host>:6432 (DATABASE_URL in .env.local; DATABASE_URL_SESSION for migrations)
    - Auth: better-auth, tables created (user, session, account, verification, rateLimit); POST /api/auth/*
    - Storage: bucket <slug>; presigned helpers in lib/s3.ts
    - Templates: lib/db.ts lib/auth.ts lib/auth-client.ts lib/s3.ts lib/schema.ts drizzle.config.ts vercel.json (gru1)
    - Scripts: npm run db:push | db:generate | db:migrate | auth:schema
    - Vercel: <"env pushed to production, preview and development" | "not linked. After `vercel link`, run:" + the step-10 commands, indented>
    Next: add tables to lib/schema.ts and run npm run db:push. Development continues with your usual skills.
    ```

## 3. migrate (rehearsal)

Supabase stays live, read-only. Write only the skill's files (`lib/*.ts` templates, `drizzle.config.ts`, `scripts/`, the bcrypt hook in `lib/auth.ts`); never edit application code.

1. **State check**. `MIGRATION.md` exists: STOP "This app was already rehearsed. Run /dbmanager cutover, or start over (step 1 text below)." `.dbm-rehearsal` exists (a rehearsal stopped before hand-off): read the slug from it, require `dbm list --json | jq -e '.[] | select(.slug=="<slug>" and .status=="running")' >/dev/null` (else start over), then **resume**: steps 2-3, the `.gitignore` loop and `chmod` of §2.5, §2 steps 6-9 (idempotent) and the db-host grep, then step 5. Start over = "`dbm destroy <slug>` (operator); `rm -f MIGRATION.md .dbm-rehearsal`; delete the dbm and `# pre-dbm` lines from .env.local; then /dbmanager."
2. **Storage check**: `grep -rlF '.storage.' --exclude-dir={node_modules,.next} --include='*.[jt]s' --include='*.[jt]sx' .`. If it matches, list bucket names: `grep -rhoE "storage\.from\(['\"][^'\"]+['\"]\)" --exclude-dir={node_modules,.next} --include='*.[jt]s' --include='*.[jt]sx' . | sort -u`.
3. **Ask once, in one message**: "Paste your Supabase **Session pooler** connection string (Dashboard > Connect > Session pooler, port 5432, never 6543; the direct host is IPv6-only)." Only if step 2 matched, add: "and the Storage S3 endpoint, region, access key id and secret (Settings > Storage > S3). I found buckets: <names>. Confirm which to copy, name any missing; each lands under `<bucket>/`." Say: "Used once, never shown back."
4. Run §2 step 2, then §2 step 4. Before §2 step 5: if `jq -e '.existed' .dbm-create.json` succeeds, `rm -f .dbm-create.json` and STOP "Project <slug> already exists on dbm but this folder was never rehearsed: pick another slug or have the operator run `dbm destroy <slug>`." Otherwise `echo <slug> > .dbm-rehearsal`, then §2 steps 5-9 (append mode in step 5) and the db-host grep of step 11. No Vercel until cutover.
5. **Import** (secrets only here; never repeat the command or its output in prose):
   ```bash
   dbm import <slug> --from "<url>" [--storage-endpoint <e> --storage-region <r> --storage-key <id> --storage-secret <s> --storage-bucket <a> --storage-bucket <b>] --users-out .dbm-users.csv --json > .dbm-import.json
   ```
   One `--storage-bucket` per bucket. Non-zero exit: `rm -f .dbm-import.json .dbm-users.csv`, report the one-line error without URLs, STOP. Connection error: re-running /dbmanager resumes at step 2. rclone/storage error: data already loaded, so start over (step 1 text).
6. **Inventory**:
   ```bash
   node ~/.claude/skills/dbmanager/inventory.mjs . --import-json .dbm-import.json && rm -f .dbm-import.json
   ```
   Keep the `MIGRATION.md: ...` line.
7. **Users**: ask "Preserve existing accounts (passwords keep working) or have users re-register?"
   - Preserve:
     ```bash
     npm i -D csv-parse tsx && npm i bcryptjs@^3.0.3
     mkdir -p scripts && cp <dbmRoot>/scripts/migrate-supabase-users.ts scripts/
     npx tsx scripts/migrate-supabase-users.ts .dbm-users.csv
     ```
     Then apply step 3 of "Preserve accounts" in `<dbmRoot>/docs/migration-from-supabase.md` (bcrypt verify + rehash hook) to `lib/auth.ts`.
   - Both: `rm -f .dbm-users.csv`.
8. **Hand off** (`rm -f .dbm-rehearsal`; no tsc gate: old Supabase code still compiles; `MIGRATION.md` is the gate). End with the §2.11 summary with `- Storage (dbm): bucket <slug>; presigned helpers in lib/s3.ts`, `- Vercel: untouched until cutover`, and its `Next:` line replaced by:
   ```
   - Supabase: data copied (rehearsal); storage buckets <a, b> copied under <bucket>/ prefixes | not used; users preserved | re-register
   - MIGRATION.md: N usages in F files, P policies, E import errors
   Rewrite per MIGRATION.md with your development skills (imported tables are not in lib/schema.ts yet; add them before db:push). When no `- [ ]` is left in MIGRATION.md: /dbmanager cutover
   ```

## 4. cutover

1. **Gate** (STOP with the quoted text on any failure):
   - `grep -q '^DATABASE_URL=' .env.local` or say "No DATABASE_URL in .env.local: run /dbmanager (migrate) first."
   - `dbm list --json | jq -e '.[] | select(.slug=="<slug>" and .status=="running")' >/dev/null` or say "Project <slug> is not running (dbm list): resume it first."
   - `MIGRATION.md` exists or say "No MIGRATION.md here: run /dbmanager first (migrate mode)."
   - Unchecked = lines matching `^- \[ \]` (checked or deleted lines are done). N = `grep -c '^- \[ \]' MIGRATION.md`; if N > 0, print `grep '^- \[ \]' MIGRATION.md` and say "Cutover blocked: MIGRATION.md has N unchecked items (listed above). Finish them with your development skills, then run /dbmanager cutover again. Nothing changed."
2. **Ask once**: "Did the rehearsal copy Storage buckets? If yes, paste the S3 endpoint, region, access key id, secret and the bucket names again. Also paste the Supabase Session pooler connection string (port 5432, never 6543) and the production domain (for BETTER_AUTH_URL)." Never shown back. Before answering, freeze writes on the Supabase-backed app (maintenance or read-only): later writes are not copied. Deploy right after cutover.
3. **Rollback point**: `dbm backup <slug>`. If it fails, STOP before the import and report the error.
4. **Re-import** (add `--users-out .dbm-users.csv` if `scripts/migrate-supabase-users.ts` exists, and the `--storage-*` flags with one `--storage-bucket` per bucket if any were given):
   ```bash
   dbm import <slug> --from "<url>" --data-only --replace --yes --confirm <slug> --json > .dbm-import.json
   jq -e '.mismatched | length == 0' .dbm-import.json
   ```
   If the import exits non-zero (reason: "the replace import failed: <one-line stderr summary, no URLs>") or `jq -e` fails (reason: "these tables did not match after the replace import: <`jq -r '.mismatched[]' .dbm-import.json`> (a source still taking writes causes this; freeze writes, re-run /dbmanager cutover)"): `rm -f .dbm-users.csv .dbm-import.json`, say "Cutover stopped before Vercel: <reason>. Vercel and Supabase are untouched. To roll the dbm database back, run `dbm restore <slug>` with this cutover's backup (docs/runbook.md)." and STOP (no summary). Else, if preserving users, `npx tsx scripts/migrate-supabase-users.ts .dbm-users.csv` (on failure print the error, keep `.dbm-users.csv`, STOP before Vercel); then `rm -f .dbm-users.csv .dbm-import.json`.
5. **Vercel**: linked, run §2 step 10 including `BETTER_AUTH_URL`; not linked, print those commands under "After `vercel link`, run:".
6. End with exactly:
   ```
   Cutover done for <slug>. Rollback point: the backup from `dbm backup <slug>`.
   1. Deploy to production: vercel --prod
   2. Verify sign-in and one write on the production URL.
   3. Remove the Supabase env vars from Vercel ("not found" is fine):
      for k in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
        for e in production preview development; do vercel env rm "$k" "$e" --yes; done
      done
   4. Pause the Supabase project (Dashboard > Settings > General > Pause).
   5. Delete the Supabase S3 access key (Settings > Storage > S3) and reset the database password (both were pasted into a chat).
   6. Locally: delete the `# pre-dbm` and `*SUPABASE*` lines from .env.local.
   ```

## Rules

- Secrets never reach the chat: no `cat .env.local`; never repeat `dbm create`/`dbm import` commands or output in prose.
- Never read `.dbm-users.csv` or `.dbm-import.json` into the chat beyond the `jq` filters.
- Never run `dbm import --replace` outside cutover.
- `dbm destroy`, `dbm restore`, `dbm init` are the operator's.

## Common mistakes

| Mistake | Fix |
|---|---|
| `> .env.local` over an existing file (loses Supabase keys) | §2.5 append recipe |
| Inventing a data/users/storage procedure | §3.5-3.7 |
| Rewriting Supabase calls yourself | Stop at the summary |
| tsc gate in migrate mode | Skip (§3.8) |
| Inventing env loading for drizzle-kit | `drizzle.config.ts` loads `.env.local` |
