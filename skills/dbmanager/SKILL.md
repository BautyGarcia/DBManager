---
name: dbmanager
description: Use when the user wants to start building a new app or MVP, says "/dbmanager", "/dbmanager cutover", "set this project up on dbm", "scaffold the backend", "connect this app to my database platform", "migrate off Supabase", or asks for a database, auth or file storage for a Next.js project on their own VPS. Also when an existing Next.js app or an existing Supabase project must be moved to or wired to the dbm platform.
---

# dbmanager: provision an app on the operator's dbm platform

`dbm` is the operator's CLI for their self-hosted platform (Postgres behind a TLS pooler, better-auth, Garage S3, nightly off-site backups). This skill wires a folder to a dbm project, then stops. It never writes application code; features and the Supabase rewrite belong to the user's development skills.

| Mode | Folder | Recipe |
|---|---|---|
| `create` | empty | §2 (all steps) |
| `connect` | Next.js app, no Supabase | §2 (skip step 3) |
| `migrate` | Next.js app using `@supabase/*` | §3 (rehearsal: Supabase stays live) |
| `cutover` | user typed `/dbmanager cutover` | §4 |

Nothing beyond the recipe: no demo routes, health endpoints, git commits.

## 1. Preflight

```bash
bash ~/.claude/skills/dbmanager/preflight.sh "$PWD"
```

| Field | If false/empty |
|---|---|
| `dbm` | run `dbmInstallHint`, re-run preflight |
| `configured` | STOP: platform not set up here; the operator runs `dbm init` (db-manager README) |
| `templatesDir` | STOP: dbm install is broken |
| `slugOk` | derive a corrected slug (rules in §2.2); ask if the user is present, else use it and say so |
| `mode` = `unknown` | STOP: non-Next project; ask what to do |
| `hasJq` | `brew install jq` |

`mode` picks the recipe. If the user typed `/dbmanager cutover`, the mode is `cutover` whatever preflight says. Keep `dbmRoot` and `supabase.files`.

## 2. create / connect

1. Preflight (§1).
2. **Slug**: preflight's `slug`. Rules: 3-31 chars, lowercase letters, digits, single hyphens, starts with a letter, no trailing hyphen, `dbm-` reserved. State it in one line.
3. **Scaffold** (create only):
   ```bash
   npx --yes create-next-app@latest . --ts --app --no-tailwind --no-eslint --no-src-dir --import-alias "@/*" --use-npm --yes
   ```
   Flags are fixed. Leave its `AGENTS.md`/`CLAUDE.md`/`git init`; make no commits.
4. **Provision**: `dbm create <slug> --json > .dbm-create.json` (secrets; never print it). Exit 1 with status `provisioning`: STOP, tell the user to run `dbm destroy <slug>`.
5. **`.env.local`**. No `.env.local` yet (create):
   ```bash
   jq -r '.env | to_entries[] | select(.value != "") | "\(.key)=\(.value)"' .dbm-create.json > .env.local
   ```
   `.env.local` exists: append, never overwrite; same-named old keys get commented out, Supabase variables stay until cutover:
   ```bash
   for k in $(jq -r '.env | to_entries[] | select(.value != "") | .key' .dbm-create.json); do perl -i -pe "s/^\Q$k\E=/# pre-dbm $k=/" .env.local; done
   [ -z "$(tail -c1 .env.local)" ] || echo >> .env.local
   jq -r '.env | to_entries[] | select(.value != "") | "\(.key)=\(.value)"' .dbm-create.json >> .env.local
   ```
   Then, in every mode:
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
   A first "Drizzle schema mismatch / Missing tables" line is expected. On a pooler/TLS error STOP and report the exact message (never switch the config to `DATABASE_URL`).
9. **Scripts** (merges, keeps existing):
   ```bash
   node -e 'const fs=require("fs"),p=JSON.parse(fs.readFileSync("package.json","utf8"));p.scripts={...p.scripts,"auth:schema":"auth generate --config lib/auth.ts --output lib/auth-schema.ts -y","db:push":"drizzle-kit push","db:generate":"drizzle-kit generate","db:migrate":"drizzle-kit migrate"};fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'
   ```
10. **Vercel** (only when `vercelLinked` and `hasVercelCli`; never run `vercel link` yourself). Two calls per variable (`development` cannot be combined):
    ```bash
    eval "$(dbm env <slug> --json | jq -r 'to_entries[] | select(.value != "") | "export \(.key)=\(.value|@sh)"')"
    for k in DATABASE_URL DATABASE_URL_SESSION BETTER_AUTH_SECRET S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
      vercel env add "$k" production,preview --value "${!k}" --yes --force
      vercel env add "$k" development --value "${!k}" --yes --force
    done
    ```
    `BETTER_AUTH_URL` is production-only, once the domain exists: `vercel env add BETTER_AUTH_URL production --value "https://<domain>" --yes --force`.
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

Supabase stays live and is only read.

1. **Storage check**: `grep -lE '\.storage\s*\.' <each file in supabase.files>`.
2. **Ask once, in one message**: "Paste your Supabase connection string: direct or session pooler (Dashboard > Connect, port 5432, never 6543)." Only if step 1 matched, add: "and the Storage S3 endpoint, region, access key id, secret, and the bucket name (Settings > Storage > S3)." Say: "These are used in a single command and never shown back." `--storage-bucket` takes one bucket; if there are several, import the one the user names first and list the rest as not copied in the summary.
3. Run §2 steps 2, 4-10 (append mode in step 5).
4. **Import** (secrets only here; never echo the command or the JSON):
   ```bash
   dbm import <slug> --from "<url>" [--storage-endpoint <e> --storage-region <r> --storage-key <id> --storage-secret <s> --storage-bucket <b>] --users-out .dbm-users.csv --json > .dbm-import.json
   ```
   On a connection error with the direct host (IPv6-only), ask for the session pooler URL and retry.
5. **Inventory**:
   ```bash
   node ~/.claude/skills/dbmanager/inventory.mjs . --import-json .dbm-import.json && rm .dbm-import.json
   ```
   Keep its printed `MIGRATION.md: N usages in F files, P policies, E import errors` line.
6. **Users**: ask "Preserve existing accounts (passwords keep working) or have users re-register?"
   - Preserve:
     ```bash
     npm i -D csv-parse tsx && npm i bcryptjs@^3.0.3
     mkdir -p scripts && cp <dbmRoot>/scripts/migrate-supabase-users.ts scripts/
     npx tsx scripts/migrate-supabase-users.ts .dbm-users.csv
     ```
     Then apply step 3 of "Preserve accounts" in `<dbmRoot>/docs/migration-from-supabase.md` (bcrypt verify + rehash hook) to `lib/auth.ts`, exactly as shown there.
   - Either way: `rm .dbm-users.csv`.
7. **Hand off**. Skip the tsc gate: the Supabase code still compiles against its old clients, and `MIGRATION.md` is the gate. End with the §2.11 summary, replacing its `Next:` line with:
   ```
   - Supabase: data copied (rehearsal); storage <copied bucket | not used>; users <preserved | re-register>
   - MIGRATION.md: N usages in F files, P policies, E import errors
   Rewrite per MIGRATION.md with your development skills (imported tables are not in lib/schema.ts yet; add them before any db:push). When every `- [ ]` in MIGRATION.md is checked: /dbmanager cutover
   ```

## 4. cutover

1. **Gate**: `grep -c '^- \[ \]' MIGRATION.md` must print `0`. Otherwise (or no `MIGRATION.md`) print `grep '^- \[ \]' MIGRATION.md` and STOP.
2. **Ask once** (same wording as §3.2): the Supabase URL, the S3 details again if storage was copied, and the production domain.
3. **Rollback point**: `dbm backup <slug>`.
4. **Re-import** (the user opted in by typing cutover; add `--users-out .dbm-users.csv` if `scripts/migrate-supabase-users.ts` exists, and the same `--storage-*` flags if storage was copied):
   ```bash
   dbm import <slug> --from "<url>" --data-only --replace --yes --confirm <slug> --json > .dbm-import.json
   jq -r '.mismatched[]' .dbm-import.json
   ```
   Any table printed: report those tables, `rm .dbm-import.json .dbm-users.csv`, and STOP before Vercel. Else `rm .dbm-import.json`; if preserving users, `npx tsx scripts/migrate-supabase-users.ts .dbm-users.csv && rm .dbm-users.csv`.
5. **Vercel** (linked): §2 step 10 including `BETTER_AUTH_URL`, then:
   ```bash
   for k in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
     for e in production preview development; do vercel env rm "$k" "$e" --yes; done
   done
   ```
   "not found" errors are fine. Not linked: print these commands instead.
6. End with exactly:
   ```
   Cutover done for <slug>. Rollback point: the backup from `dbm backup <slug>`.
   1. Deploy to production: vercel --prod
   2. Verify sign-in and one write on the production URL.
   3. Pause the Supabase project (Dashboard > Settings > General > Pause).
   4. Delete the Supabase S3 access key (Settings > Storage > S3).
   ```

## Rules

- Secrets never reach the chat: no `cat .env.local`, no echoing `dbm create`/`dbm import` commands or output.
- Never read `.dbm-users.csv` or `.dbm-import.json` into the chat; only `jq` filters shown above.
- Never run `dbm import --replace` outside cutover.
- `dbm destroy`, `dbm restore`, `dbm init` are the operator's.

## Common mistakes

| Mistake | Fix |
|---|---|
| `> .env.local` over an existing file (loses Supabase keys) | §2.5 append recipe |
| Treating a Supabase app as plain connect | `mode` = `migrate` → §3 |
| Inventing a data/users/storage procedure | `dbm import` + `inventory.mjs` + users script, §3.4-3.6 |
| Rewriting Supabase calls yourself | Stop at the summary; `MIGRATION.md` is the user's list |
| Running tsc as a gate in migrate mode | Skip it (§3.7) |
| Summary saying "data not migrated" | §3.7 summary lines |
| Inventing env loading for drizzle-kit | `drizzle.config.ts` loads `.env.local` |
