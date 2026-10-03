# Migrating from Supabase to dbm

This guide moves one Supabase project to one `dbm` project: schema, data, storage files, and optionally users. Code changes are unavoidable, because `dbm` has no anon key, no PostgREST and no RLS-as-security-boundary: all database access happens in server code.

Nothing here modifies the Supabase project. Keep it running until the new deployment is verified.

## With the /dbmanager skill (recommended)

Install the skill once by symlinking `skills/dbmanager` into `~/.claude/skills/`. Then, in the app folder, run two commands.

1. `/dbmanager` detects Supabase code and runs migrate mode, a rehearsal. It creates the dbm project, wires the templates, and runs `dbm import` with `--users-out` (and one storage bucket if you gave S3 details). Supabase stays live and read-only. It then writes `MIGRATION.md`, an inventory of Supabase usages, RLS policies and import errors, as `- [ ]` items. It also asks whether to preserve user accounts.
2. Rewrite the app per `MIGRATION.md` with your usual development skills. Check items off or delete them.
3. `/dbmanager cutover` refuses to run while any `- [ ]` is left. It takes `dbm backup <slug>` as the rollback point, re-imports with `--data-only --replace`, checks that every table count matches, loads users if you preserved them, and pushes the env vars to Vercel. It ends with the closing checklist (see [Deploy and verify](#4-deploy-and-verify)).

The sections below describe what the skill runs and how to do the same by hand.

## 1. Create the target project

```bash
dbm create <slug>
```

Keep the printed `DATABASE_URL`; you will also want the env block in `.env.local` (see the README).

## 2. Import with `dbm import`

`dbm import` runs entirely on the VPS inside a temporary `postgres:18` container on the Docker network (client tools must be at least the source major version). It never modifies the source.

Get a source URL from Supabase Dashboard, Connect:

- The **direct** connection (`postgresql://postgres:<PW>@db.<REF>.supabase.co:5432/postgres`). It is IPv6-only unless the IPv4 add-on is enabled, and whether your VPS has IPv6 egress depends on the provider.
- Otherwise the **session pooler** on port 5432 (`postgres.<REF>@aws-N-<region>.pooler.supabase.com`).
- Never the transaction pooler (port 6543): `pg_dump` does not work through it.

Enable the S3 protocol and create an access key in Dashboard, Project Settings, Storage, S3 Connection. **Supabase S3 keys bypass RLS and grant full access to every bucket. Treat them like the database password: never commit them, and delete them in Supabase once the migration is done.**

```bash
dbm import <slug> \
  --from 'postgresql://postgres:<PW>@db.<REF>.supabase.co:5432/postgres' \
  --schemas public \
  --storage-endpoint https://<REF>.storage.supabase.co/storage/v1/s3 \
  --storage-region <project-region> \
  --storage-key <access-key-id> \
  --storage-secret <secret> \
  --storage-bucket <bucket>
```

`--schemas` defaults to `public`; pass a comma-separated list for other user-owned schemas. The storage flags are optional and copy one bucket at a time into the project's bucket (rerun for more buckets; the target bucket is the project's own, so use key prefixes if you merge several).

What it does, in order: `pg_dump --schema-only --no-owner --no-privileges --no-comments --no-publications --no-subscriptions`, then `pg_dump --data-only --no-owner --no-privileges`; restores the schema with `psql -v ON_ERROR_STOP=0` as the app role, then the data with `SET session_replication_role = replica` so foreign-key and trigger order does not matter; collects stderr from both; copies storage with `rclone copy --size-only` (Supabase S3 does not support Content-MD5 or ETag checksums). It is a copy, not a sync: objects already in the project's bucket are never deleted, so re-running an import or merging several source buckets is safe.

### Reading the report

Errors are grouped. Each group is expected for Supabase sources; fix them in your schema and code.

| Report category | What it means | Fix |
|---|---|---|
| Foreign keys / references to `auth.users` | Your tables point at Supabase's `auth.users`, which does not exist here | Drop the FK, add one to better-auth's `"user"(id)`. With the template's `advanced.database.generateId: "uuid"` the id types match, and migrated users keep their Supabase uuid (see [Users](#users)) |
| `auth.uid()` and friends | RLS policies or column defaults call `auth.uid()`, `auth.jwt()` or `auth.role()` | Remove the policies and defaults. Authorization lives in server code using the better-auth session; set the user id explicitly on insert |
| `storage.objects` / `storage.buckets` | Rows or FKs reference Supabase Storage tables | Store the S3 object key in your own table. The files themselves are in your Garage bucket if you passed the storage flags |
| `extensions` schema | Calls like `extensions.uuid_generate_v4()` | Use `gen_random_uuid()` (pgcrypto and `uuid-ossp` are installed by default), or recreate the project with `--extensions` for others |
| Other errors | Anything else (missing roles such as `anon`, `authenticated`, `service_role`, extension-owned objects) | Review each one. Grants to Supabase roles are already suppressed by `--no-privileges` |

Because the restore runs with `ON_ERROR_STOP=0`, objects that failed are missing. Fix the SQL, then re-run only the failed statements with `dbm psql <slug>`.

### Re-import flags

- `--data-only` skips the schema phase (and RLS policy detection). Use it when the schema already exists, as after a rehearsal.
- `--replace` truncates the tables that exist in both source and target, then loads the data again. Protected tables are never truncated: `user`, `session`, `account`, `verification`, `rateLimit` and `__drizzle_migrations`. It runs one `TRUNCATE ... RESTART IDENTITY` without CASCADE. If any table outside the replace set (a protected table, or one created during the rewrite) has a foreign key to an imported table, the statement fails and the import aborts with `---REPLACE-FAILED---` before any data is loaded. It asks you to retype the slug; non-interactively pass `--yes --confirm <slug>`.
- `--users-out <file>` writes `auth.users` as CSV with mode 0600 and never prints it. Rows need a non-null email and a null `deleted_at`. Columns: `id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, raw_app_meta_data, created_at, updated_at, last_sign_in_at`. A source without an `auth` schema fails with a clear error.

Take `dbm backup <slug>` before a `--replace` run. It is your rollback point.

Caveat: a source table named like a protected table (`user`, `session`, `account`, `verification`, `rateLimit`, `__drizzle_migrations`) collides with the better-auth one. The schema import reports "already exists" and the data load copies its rows into the existing table. With `--replace` that table is never truncated, so at cutover its rows are loaded on top, fail as duplicates, and the table shows MISMATCH every time. Rename or drop it in the source before importing, or expect to clean it up afterwards.

`--storage-bucket` copies one bucket per run.

### Counts and policies in the report

The report ends with a counts table (`table source target`). A row marked `MISMATCH` means the row counts differ, and the report adds `COUNT MISMATCH in: ...`. It then lists `RLS policies to re-implement in server code (N)` (omitted when `--data-only` was used and no policies were found), and `users exported: N -> <file>` when `--users-out` was used. With `--json` the same data is in `counts`, `rlsPolicies`, `mismatched` and `usersExported`.

### Doing it by hand

The same procedure with plain tools, from a machine that can reach the source and the target:

```bash
export SRC="postgresql://postgres:<PW>@db.<REF>.supabase.co:5432/postgres"

# 1. Schema of user-owned schemas only (public by default; add others with --schema)
pg_dump "$SRC" --schema=public --schema-only \
  --no-owner --no-privileges --no-comments --no-publications --no-subscriptions \
  -f schema.sql

# 2. Data, COPY format
pg_dump "$SRC" --schema=public --data-only --no-owner --no-privileges -f data.sql

# 3. Optional: users for the migration script (read-only extract, not restored as-is)
psql "$SRC" -Atc "COPY (
  SELECT id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, raw_app_meta_data,
         created_at, updated_at, last_sign_in_at
  FROM auth.users WHERE email IS NOT NULL AND deleted_at IS NULL
) TO STDOUT WITH (FORMAT csv, HEADER)" > auth-users.csv

# 4. Restore into the dbm project (app role owns the DB; run as the app role)
psql "$DBM_URL" -v ON_ERROR_STOP=0 -f schema.sql 2> schema.errors
psql "$DBM_URL" -v ON_ERROR_STOP=0 -c 'SET session_replication_role = replica' -f data.sql 2> data.errors
```

Step 3 is also how you produce the CSV for the user migration below; `dbm import --users-out <file>` does the same. Note: `DBM_URL` must be a connection that allows `SET session_replication_role` (the app role has that grant). Run the restore through `DATABASE_URL_SESSION`, not the transaction-mode `DATABASE_URL`, because the `SET` must persist across statements in one session.

The Supabase CLI is an alternative that needs no `pg_dump` install and excludes managed schemas automatically:

```bash
supabase db dump --db-url "$SRC" -f schema.sql
supabase db dump --db-url "$SRC" -f data.sql --data-only --use-copy \
  -x storage.buckets_vectors -x storage.vector_indexes
```

Storage by hand (Supabase to Garage):

```bash
rclone copy \
  ":s3,provider=Other,endpoint=https://<REF>.storage.supabase.co/storage/v1/s3,region=<project_region>,force_path_style=true,access_key_id=$SB_KEY,secret_access_key=$SB_SECRET:<bucket>" \
  ":s3,provider=Other,endpoint=https://s3.<domain>,region=garage,force_path_style=true,access_key_id=$S3_ACCESS_KEY_ID,secret_access_key=$S3_SECRET_ACCESS_KEY:<slug>" \
  --checksum=false --size-only
```

## 3. Change the application code

- Replace `supabase-js` queries with Drizzle in server code (templates in `templates/nextjs/`). Client components call server actions or route handlers.
- Drop foreign keys to `auth.users(id)`; add foreign keys to better-auth's `user(id)`.
- Remove RLS policies and `auth.uid()` defaults. Authorization moves into server code.
- Replace Supabase Storage calls with presigned URLs from `lib/s3.ts`. Public assets need `dbm storage public <slug>` and `S3_PUBLIC_BASE_URL`.
- Generate the better-auth tables and push them: `npx auth generate --config lib/auth.ts --output lib/auth-schema.ts -y`, then `npx drizzle-kit push` (uses `DATABASE_URL_SESSION`).

## Users

Supabase hosted projects hash passwords with bcrypt (`$2a$10$...`). better-auth defaults to scrypt and does not detect bcrypt, so a migration must (1) insert legacy rows with the bcrypt hash untouched, (2) verify bcrypt when the stored hash starts with `$2`, and (3) rehash to scrypt after a successful legacy login. better-auth does not rehash on its own. This is the shape of better-auth's own Supabase migration guide.

There are two options:

- **Re-register**: simplest. Tell users to sign up again. Nothing to do here.
- **Preserve accounts**: follow the steps below.

### Preserve accounts

1. Export `auth.users` to `auth-users.csv` (step 3 of the manual procedure above).
2. In the target Next.js project (after `drizzle-kit push` created `user` and `account`), copy `scripts/migrate-supabase-users.ts` from this repository into the project's `scripts/` and install its parser:
   ```bash
   npm i -D csv-parse
   npx tsx scripts/migrate-supabase-users.ts auth-users.csv
   ```
   It inserts `user` rows keeping the Supabase uuid (so application foreign keys survive) and `account` rows with `providerId: "credential"`, `accountId = user.id` and the bcrypt hash untouched. It is idempotent on `user.id` (`onConflictDoNothing`), skips any row whose hash does not match `^\$2[aby]\$` and logs the skip, and never prints hashes. **Review it before running.** OAuth identities (`auth.identities`) are not migrated; map them to `account` rows with `providerId = <provider>` and `accountId = identity.provider_id` if you need them.
3. Add bcrypt verification and a rehash-on-login hook to `lib/auth.ts`:
   ```bash
   npm i bcryptjs@^3.0.3
   ```
   ```ts
   import { compare as bcryptCompare } from "bcryptjs";
   import { hashPassword, verifyPassword } from "better-auth/crypto";
   import { createAuthMiddleware } from "better-auth/api";

   const isBcrypt = (h: string) => /^\$2[aby]\$/.test(h);

   export const auth = betterAuth({
     // ...as in the template...
     emailAndPassword: {
       enabled: true,
       password: {
         hash: hashPassword,                        // new passwords stay on scrypt
         verify: async ({ hash, password }) =>
           isBcrypt(hash) ? bcryptCompare(password, hash) : verifyPassword({ hash, password }),
       },
     },
     hooks: {
       after: createAuthMiddleware(async (ctx) => {
         if (ctx.path !== "/sign-in/email") return;
         const session = ctx.context.newSession;
         const password = (ctx.body as { password?: string } | undefined)?.password;
         if (!session || !password) return;
         const accounts = await ctx.context.internalAdapter.findAccounts(session.user.id);
         const cred = accounts.find((a) => a.providerId === "credential");
         if (cred?.password && isBcrypt(cred.password)) {
           await ctx.context.internalAdapter.updatePassword(
             session.user.id,
             await ctx.context.password.hash(password),
           );
         }
       }),
     },
   });
   ```
   `newSession` only exists in `after` hooks after a successful sign-in, so the rehash never runs for failed attempts. bcryptjs is pure JavaScript (no native build on Vercel).
4. Once nobody has a bcrypt hash left, remove the hook, the custom `password` block and `bcryptjs`. Detect that moment with:
   ```sql
   SELECT count(*) FROM account WHERE password LIKE '$2%';
   ```
   (run it with `dbm psql <slug>`). Users who never log in again keep a bcrypt hash; decide when to stop waiting and force a password reset for the rest.

## 4. Deploy and verify

Push the env vars to Vercel (production, preview and development as separate calls; `BETTER_AUTH_URL` for production only) and pin `gru1` in `vercel.json`. Put the Supabase-backed app into maintenance or read-only mode first: writes after the snapshot are not copied. A count mismatch usually means the source was still taking writes: freeze writes and re-run the cutover. Then follow the order of the skill's closing checklist:

1. Deploy to production: `vercel --prod`.
2. Verify sign-in and one write on the production URL, plus uploads and the main queries.
3. Remove the Supabase env vars from Vercel (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, in all three environments).
4. Pause the Supabase project.
5. Delete the Supabase S3 access key.
6. Locally, delete the `# pre-dbm` and `*SUPABASE*` lines from `.env.local`.

If something goes wrong before step 3, see [Roll back a cutover](runbook.md#roll-back-a-cutover).
