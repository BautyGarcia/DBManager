---
name: dbmanager
description: Use when the user wants to start building a new app or MVP, says "/dbmanager", "set this project up on dbm", "scaffold the backend", "connect this app to my database platform", or asks for a database, auth or file storage for a Next.js project on their own VPS. Also when an existing Next.js app must be wired to the dbm platform.
---

# dbmanager: provision an app on the operator's dbm platform

`dbm` is the operator's CLI for their self-hosted platform (Postgres behind a TLS pooler, better-auth in-app, Garage S3 storage, nightly off-site backups). This skill takes a folder from empty (or an existing Next.js app) to **a running skeleton wired to a fresh dbm project**, then stops. Building features afterwards is the job of whatever development skills are in use; this skill never gives Next.js design or coding guidance.

**You produce exactly this, in order:** preflight → confirmed slug → (scaffold if empty) → `dbm create` → `.env.local` → templates → dependencies → auth schema + `drizzle-kit push` → scripts → Vercel env (if linked) → the hand-off summary. Nothing else: no demo routes, no health endpoints, no git commits, no CORS tightening, no `dbm destroy`/`restore`.

## 1. Preflight

```bash
bash ~/.claude/skills/dbmanager/preflight.sh "$PWD"
```

Act on the JSON:

| Field | If false/empty |
|---|---|
| `dbm` | run `dbmInstallHint`, then re-run preflight |
| `configured` | STOP. Tell the user: the platform is not set up on this machine; run `dbm init` per the db-manager README (needs a VPS, DNS, Tailscale, Backblaze). Do not continue. |
| `templatesDir` | STOP and report; the dbm install is broken |
| `slugOk` | derive a corrected slug (rules below); ask if the user is present, otherwise use it and state it |
| `hasPackageJson && !isNextApp` | STOP: this folder has a non-Next project; ask what to do |
| `hasJq` | `brew install jq` (needed only for the Vercel step) |

## 2. Slug

Use preflight's `slug` (derived from the folder name). Rules: 3-31 chars, lowercase letters, digits, single hyphens, starts with a letter, no leading/trailing hyphen, `dbm-` prefix reserved. Tell the user the slug you will use in one line; if they are not present (autonomous run), proceed with it.

## 3. Scaffold (only when `folderEmpty`)

```bash
npx --yes create-next-app@latest . --ts --app --no-tailwind --no-eslint --no-src-dir --import-alias "@/*" --use-npm --yes
```

These flags are fixed: the templates assume App Router, no `src/`, `@/*` alias. `create-next-app` may add `AGENTS.md`/`CLAUDE.md` and runs `git init`; leave all of that as is and make no commits. If the folder already holds a Next app, skip this step.

## 4. Provision

```bash
dbm create <slug> --json > .dbm-create.json
```

Progress lines go to stderr and contain no secrets; stdout is the JSON. `create` is idempotent (`"existed": true` means nothing changed). If it exits 1 with status `provisioning`, STOP and tell the user to run `dbm destroy <slug>` themselves. Never print the file's contents into the chat; it holds secrets.

## 5. `.env.local`

```bash
jq -r '.env | to_entries[] | select(.value != "") | "\(.key)=\(.value)"' .dbm-create.json > .env.local
chmod 600 .env.local && rm .dbm-create.json
grep -Fqx '.env*' .gitignore || printf '.env*\n' >> .gitignore
grep -Fqx '!.env.example' .gitignore || printf '!.env.example\n' >> .gitignore
```

`BETTER_AUTH_URL` stays unset locally; the template falls back to `http://localhost:3000`.

## 6. Templates (verbatim, from `templatesDir`)

```bash
T="<templatesDir>"
mkdir -p lib "app/api/auth/[...all]"
cp "$T"/lib/{db,schema,auth,auth-client,s3}.ts lib/
cp "$T/app/api/auth/[...all]/route.ts" "app/api/auth/[...all]/"
cp "$T/drizzle.config.ts" "$T/vercel.json" "$T/.env.example" .
```

`lib/schema.ts` is where the app's own tables go later. If the project already has `vercel.ts`, do not copy `vercel.json`; add `regions: ['gru1']` to `vercel.ts` instead.

## 7. Dependencies

```bash
npm i better-auth@^1.7.6 drizzle-orm@^0.45.3 postgres@^3.4.9 @aws-sdk/client-s3@^3.1144.0 @aws-sdk/s3-request-presigner@^3.1144.0
npm i -D drizzle-kit@^0.31.11 auth@^1.7.6
```

Never install `pg`; drizzle-kit would prefer it over postgres.js.

## 8. Schema

```bash
npx auth generate --config lib/auth.ts --output lib/auth-schema.ts -y
npx drizzle-kit push
```

`npx auth` uses the pinned devDependency installed in step 7 (not `@latest`). On a fresh database it first prints a "Drizzle schema mismatch / Missing tables" line and then generates the file; that is expected, not a failure.

`drizzle.config.ts` loads `.env.local` itself and uses the session pooler. If `push` fails with a pooler or TLS error, STOP and report the exact message; never switch it to `DATABASE_URL`. The generated columns are snake_case (`created_at`, `user_id`).

## 9. Scripts

Merge into `package.json` `scripts` with this one-liner (keeps existing scripts):
```bash
node -e 'const fs=require("fs"),p=JSON.parse(fs.readFileSync("package.json","utf8"));p.scripts={...p.scripts,"auth:schema":"auth generate --config lib/auth.ts --output lib/auth-schema.ts -y","db:push":"drizzle-kit push","db:generate":"drizzle-kit generate","db:migrate":"drizzle-kit migrate"};fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'
```

## 10. Vercel (only when `vercelLinked` and `hasVercelCli`)

Two calls per variable; `production,preview` cannot be combined with `development`:
```bash
eval "$(dbm env <slug> --json | jq -r 'to_entries[] | select(.value != "") | "export \(.key)=\(.value|@sh)"')"
for k in DATABASE_URL DATABASE_URL_SESSION BETTER_AUTH_SECRET S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
  vercel env add "$k" production,preview --value "${!k}" --yes --force
  vercel env add "$k" development --value "${!k}" --yes --force
done
```
`BETTER_AUTH_URL` is set for production only, once the production domain exists: `vercel env add BETTER_AUTH_URL production --value "https://<domain>" --yes --force`. Not linked? Do not run `vercel link` yourself (it creates a Vercel project); the summary's Vercel section carries these commands for later.

## 11. Verify and hand off

Run `npx tsc --noEmit && echo TSC_OK` and require the `TSC_OK` line (do not read the exit code through a pipe); if it fails, report the errors verbatim and stop (do not edit the templates). Get the database host without exposing secrets: `grep '^DATABASE_URL=' .env.local | sed -E 's|.*@([^/:]+).*|\1|'`. Then end with this summary; it is the last thing you output:

```
Project <slug> is provisioned.
- Database: Postgres 18 via <db-host>:6432 (DATABASE_URL in .env.local; DATABASE_URL_SESSION for migrations)
- Auth: better-auth, tables created (user, session, account, verification, rateLimit); POST /api/auth/*
- Storage: bucket <slug>; presigned helpers in lib/s3.ts
- Templates: lib/db.ts lib/auth.ts lib/auth-client.ts lib/s3.ts lib/schema.ts drizzle.config.ts vercel.json (gru1)
- Scripts: npm run db:push | db:generate | db:migrate | auth:schema
- Vercel: <"env pushed to production, preview and development" | "not linked. After `vercel link`, run:" followed by the step-10 commands, indented>
Next: add tables to lib/schema.ts and run npm run db:push. Development continues with your usual skills.
```

## Rules

- Secrets never reach the chat: no `cat .env.local`, no echoing `dbm create` output.
- All database access is server-side; browsers upload via presigned URLs from `lib/s3.ts`.
- `dbm destroy`, `dbm restore` into a live project, and `dbm init` are the operator's to run.
- Public asset hosting needs `dbm storage public <slug>` (operator) and `S3_PUBLIC_BASE_URL`.

## Common mistakes

| Mistake | Fix |
|---|---|
| Inventing env loading (`node --env-file`, `set -a`) for drizzle-kit | Not needed: `drizzle.config.ts` loads `.env.local` |
| Adding Tailwind/ESLint or `src/` to the scaffold | Use the fixed flags in step 3 |
| Writing a health route or committing to git | Out of scope; stop at the summary |
| Guessing the templates path under `node_modules` | Use preflight's `templatesDir` |
| Running on a machine with no `~/.dbm/config.json` | Stop; `dbm init` is a one-time operator step |
