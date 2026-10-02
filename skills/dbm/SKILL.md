---
name: dbm
description: Provision a database + storage project on the operator's own VPS with the dbm CLI and wire a Next.js app to it (env vars, Vercel, Drizzle, better-auth, S3). Use when asked to "create a db for this app", "connect this project to dbm", "scaffold backend for an MVP", or to migrate off Supabase.
---

# dbm: personal database platform

`dbm` (npm `db-manager`; run it as `dbm` if installed globally, otherwise `npx db-manager`) runs on the operator's machine and talks to their VPS. It prints the env vars a Next.js app needs. You never touch the VPS directly.

`--json` and `--yes` are global options and must come BEFORE the subcommand: `dbm --json create <slug>`, not `dbm create <slug> --json`.

## Create a project and wire the app

1. Pick a slug: lowercase, starts with a letter, letters/digits/hyphens, 2-31 chars. Usually the app's folder name.
2. Run and parse:
   ```bash
   dbm --json create <slug>
   ```
   `create` is idempotent: if the slug already exists it changes nothing, exits 0 and returns the same JSON with `"existed": true`. (`dbm --json env <slug>` also reprints the env block without creating anything.) The JSON is `{ slug, existed, env: { DATABASE_URL, DATABASE_URL_SESSION, S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, BETTER_AUTH_SECRET, BETTER_AUTH_URL, DATABASE_SSL_CA? } }`. `BETTER_AUTH_URL` is an empty string until you set it. Projects created with `--no-storage` have no `S3_*` keys.
3. Write every non-empty key to `.env.local` (create or merge; never commit it). Leave `BETTER_AUTH_URL` unset locally; the template falls back to `http://localhost:3000`.
4. Push to Vercel, two calls per variable (production/preview default to sensitive; development cannot be combined):
   ```bash
   for k in DATABASE_URL DATABASE_URL_SESSION S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY BETTER_AUTH_SECRET; do
     vercel env add "$k" production,preview --value "${!k}" --yes --force
     vercel env add "$k" development       --value "${!k}" --yes --force
   done
   vercel env add BETTER_AUTH_URL production --value "https://<production-domain>" --yes --force
   ```
   Do not set `BETTER_AUTH_URL` for preview; the template falls back to `VERCEL_URL`. Skip the `S3_*` names for `--no-storage` projects. If the JSON has `DATABASE_SSL_CA`, push it the same way.
5. Pin functions to São Paulo: add `templates/nextjs/vercel.json` (`"regions": ["gru1"]`). If the project already has `vercel.ts`, add `regions: ['gru1']` there instead; never keep both files.
6. Copy the templates from the dbm repo `templates/nextjs/` (shipped inside the npm package) into the project (`lib/db.ts`, `lib/schema.ts`, `drizzle.config.ts`, `lib/auth.ts`, `lib/auth-client.ts`, `app/api/auth/[...all]/route.ts`, `lib/s3.ts`, `.env.example`). Keep them verbatim except for `lib/schema.ts`, where the app's tables go.
7. Install pinned dependencies:
   ```bash
   npm i better-auth@^1.7.6 drizzle-orm@^0.45.3 postgres@^3.4.9 @aws-sdk/client-s3@^3.1144.0 @aws-sdk/s3-request-presigner@^3.1144.0
   npm i -D drizzle-kit@^0.31.11 auth@^1.7.6
   ```
   Do not install `pg`; drizzle-kit would prefer it over postgres.js.
8. Generate the auth schema and push:
   ```bash
   BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://localhost:3000}" npx auth@latest generate --config lib/auth.ts --output lib/auth-schema.ts -y
   npx drizzle-kit push
   ```
   `auth generate` needs a base URL, so set `BETTER_AUTH_URL=http://localhost:3000` for that step if the environment has none. `drizzle-kit` reads `DATABASE_URL_SESSION` (session-mode pooler). If push fails with a pooler error, stop and report it; do not switch to `DATABASE_URL`.
9. Add `"auth:schema"`, `"db:push"`, `"db:generate"`, `"db:migrate"` scripts as in `templates/nextjs/README.md`.

## Rules

- All database access is server-side (server components, server actions, route handlers). Never import `lib/db.ts` from a client component. There is no anon key.
- Browser uploads use presigned URLs from `lib/s3.ts`; the browser never sees S3 credentials.
- Public assets need `dbm storage public <slug>` (operator runs it) and then `S3_PUBLIC_BASE_URL` in env.
- Never use `sslmode=require` or `rejectUnauthorized: false`.
- If the operator asks to remove a project: `dbm destroy <slug>` is theirs to run; do not run it yourself. Same for `dbm restore` into an existing project (it overwrites the database).

## Other useful commands

`dbm list`, `dbm env <slug>`, `dbm pause|resume <slug>`, `dbm backup <slug>`, `dbm restore <slug> latest --as <staging-slug>`, `dbm storage cors <slug> --origin <origin>...`, `dbm doctor`, `dbm import <slug> --from <postgres-url> ...` (see `docs/migration-from-supabase.md`).
