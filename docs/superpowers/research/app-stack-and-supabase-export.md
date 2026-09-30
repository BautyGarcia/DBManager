# Research: application-side stack and Supabase export

**Date checked:** 2026-09-30
**Scope:** spec sections 5.7 (templates), 11 (Vercel), 13 (Supabase migration). All versions were read from the npm registry on the date above; all doc claims carry a URL.

## Summary

- better-auth stable is **1.7.6** (published 2026-09-24). 1.7.0 (2026-08-18) was a breaking release; 1.7.0-1.7.2 added and 1.7.3 reverted a required `account.issuer` column. Pin `^1.7.6`.
- The CLI is now `npx auth@latest generate` (package `auth`, same version line as `better-auth`); `@better-auth/cli` is stale at 1.4.21. `migrate` is Kysely-only, so with Drizzle the flow is `auth generate` -> `drizzle-kit push|generate+migrate`.
- Passwords live in `account.password` with `providerId = "credential"` and `accountId = user.id`. `emailAndPassword.password.{hash,verify}` is the documented hook for legacy bcrypt; better-auth does **not** rehash on login by itself, so the template needs an `hooks.after` on `/sign-in/email` that calls `ctx.context.internalAdapter.updatePassword`.
- Drizzle ORM **0.45.3** / drizzle-kit **0.31.11**; postgres.js **3.4.9**; Next.js **16.3.8** (route.ts `params` is a Promise; `middleware` renamed `proxy`); AWS SDK v3 **3.1144.0**; Vercel CLI **62.0.0**.
- Vercel: `gru1` (sa-east-1) exists; Hobby may select any single region; `vercel.json` `{"regions":["gru1"]}` is the supported way, `vercel.ts` is an alternative. `vercel env add NAME production,preview --value "..." --yes --force` is non-interactive; development must usually be a separate call.
- Supabase: pg_dump needs the **direct** connection (`db.<ref>.supabase.co:5432`, IPv6 unless IPv4 add-on) or the session pooler; the CLI's `supabase db dump` excludes an explicit list of 30 managed schemas; `auth.users.encrypted_password` is bcrypt; S3 keys are created in Storage settings, endpoint `https://<ref>.storage.supabase.co/storage/v1/s3`, `forcePathStyle: true`.
- Security: 10+ advisories in 2025-2026, nearly all in plugins (SSO, SCIM, OAuth provider, API keys). Core email/password + sessions were touched by GHSA-qq9h-g4jm-xgf3 (magic-link/OTP) and CVE-2025-71401 (baseURL poisoning). Set `baseURL` explicitly, keep plugins minimal, use database rate-limit storage on Vercel.
- Two things could not be verified from official sources: drizzle-kit `push` through PgBouncer transaction mode (analysis says it works; needs the integration test) and `attachDatabasePool` support for postgres.js.

## Verified facts

### better-auth

- Latest `better-auth` is 1.7.6, published 2026-09-24T16:01Z; 1.7.0 published 2026-08-18; 1.6.11 on 2026-05-12; `release-1.6` line at 1.6.33. Source: npm registry `https://registry.npmjs.org/better-auth` (checked 2026-09-30). The GitHub releases page lists v1.7.6 as latest: https://github.com/better-auth/better-auth/releases
- Peer deps allow `next ^14 || ^15 || ^16`, `react ^18 || ^19`, Drizzle ORM, `pg`. Source: registry `better-auth/latest` (2026-09-30).
- The CLI package is `auth` (description "The CLI for Better Auth", repo directory `packages/cli`), latest 1.7.6; `@better-auth/cli` latest is 1.4.21 from 2026-03-01. Source: `https://registry.npmjs.org/auth`, `https://registry.npmjs.org/@better-auth/cli` (2026-09-30). Docs use `npx auth@latest generate`: https://www.better-auth.com/docs/concepts/cli
- CLI: `generate` supports Prisma, Drizzle, Kysely; `migrate` is Kysely only ("you'll need to apply the schema using your ORM's migration tool"). Flags `--config`, `--output`, `-y`. Drizzle default output is `schema.ts` at project root (use `--output lib/auth-schema.ts`). Source: https://www.better-auth.com/docs/concepts/cli (2026-09-30). The 1.7 upgrade guide requires Node >= 22.12 for the CLI: https://github.com/better-auth/better-auth/blob/main/docs/content/docs/guides/1-7-upgrade-guide.mdx
- Next.js App Router handler: file `app/api/auth/[...all]/route.ts`, `export const { GET, POST } = toNextJsHandler(auth)` from `better-auth/next-js`; `nextCookies()` plugin needed when server actions set cookies; for Next 16 use `proxy` file instead of middleware. Source: https://www.better-auth.com/docs/integrations/next (2026-09-30). Package exports include `./next-js`, `./adapters/drizzle`, `./crypto`, `./react`, `./api` (registry 1.7.6 `exports`).
- Drizzle adapter: `drizzleAdapter(db, { provider: "pg", schema, usePlural? })`; optional `schemaName` for a non-public Postgres schema. Source: https://www.better-auth.com/docs/adapters/drizzle (2026-09-30).
- Core tables and columns (user: id,name,email,emailVerified,image?,createdAt,updatedAt; session: id,userId,token,expiresAt,ipAddress?,userAgent?,createdAt,updatedAt; account: id,userId,accountId,providerId,accessToken?,refreshToken?,accessTokenExpiresAt?,refreshTokenExpiresAt?,scope?,idToken?,password?,createdAt,updatedAt; verification: id,identifier,value,expiresAt,createdAt,updatedAt). "Credential accounts use the `credential` provider ID and the linked user's stable `id` as `accountId`." Source: https://github.com/better-auth/better-auth/blob/main/docs/content/docs/concepts/database.mdx (2026-09-30).
- emailAndPassword options and defaults: `enabled` false, `disableSignUp` false, `minPasswordLength` 8, `maxPasswordLength` 128, `autoSignIn` true, `requireEmailVerification` false, `resetPasswordTokenExpiresIn` 3600, `revokeSessionsOnPasswordReset` false, `password: { hash(password), verify({ hash, password }) }`. Default hash is scrypt. "Better Auth stores passwords inside the `account` table with `providerId` set to `credential`." Source: https://github.com/better-auth/better-auth/blob/main/docs/content/docs/authentication/email-password.mdx (2026-09-30).
- Sign-in calls `ctx.context.password.verify({ hash: currentPassword, password })` and throws on false; there is no rehash step in the route. Source: https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/api/routes/sign-in.ts (2026-09-30).
- `internalAdapter.updatePassword(userId, password)` updates `account.password` where `userId`, `providerId = "credential"`, `accountId = userId`. Source: https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/db/internal-adapter.ts (2026-09-30).
- `hooks.after` via `createAuthMiddleware` exposes `ctx.path`, `ctx.context.newSession`, `ctx.context.password.{hash,verify}`, `ctx.context.internalAdapter`. Source: https://github.com/better-auth/better-auth/blob/main/docs/content/docs/concepts/hooks.mdx (2026-09-30).
- `better-auth/crypto` exports `hashPassword` and `verifyPassword` (scrypt defaults). Source: https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/crypto/password.ts (2026-09-30).
- Official Supabase migration guide exists and uses `bcrypt.hash(password, 10)` / `bcrypt.compare(password, hash)` as `password.hash/verify`, maps `email_confirmed_at` -> `emailVerified`, and inserts credential accounts with `providerId: 'credential'`, `accountId = user id`. Source: https://github.com/better-auth/better-auth/blob/main/docs/content/docs/guides/supabase-migration-guide.mdx (2026-09-30). Issue #5016 confirms core does not auto-detect `$2a$/$2b$` hashes; the fix (PR #5054, merged 2025-10-05) was documentation, not auto-detection. Sources: https://github.com/better-auth/better-auth/issues/5016 , https://github.com/better-auth/better-auth/pull/5054
- Session defaults: `expiresIn` 7d, `updateAge` 1d, `freshAge` 1d, `cookieCache` disabled. Source: https://www.better-auth.com/docs/concepts/session-management (2026-09-30).
- Cookie defaults from source: `secure` resolved from `advanced.useSecureCookies` -> dynamic protocol -> `baseURL` starts with `https://` -> `NODE_ENV === "production"`; `sameSite: "lax"`, `path: "/"`, `httpOnly: true`; secure cookies get the `__Secure-` prefix. Source: https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/cookies/index.ts (2026-09-30). Docs: https://www.better-auth.com/docs/concepts/cookies
- `secret` from `BETTER_AUTH_SECRET` then `AUTH_SECRET`; production throws if unset. `baseURL` from option or `BETTER_AUTH_URL`; object form `{ allowedHosts, protocol, fallback }` with wildcards like `*.vercel.app`; `allowedHosts` are auto-added to `trustedOrigins`; `basePath` default `/api/auth`. Source: https://github.com/better-auth/better-auth/blob/main/docs/content/docs/reference/options.mdx , https://github.com/better-auth/better-auth/blob/main/docs/content/docs/guides/dynamic-base-url.mdx (2026-09-30). In 1.7, forwarded headers are ignored with `allowedHosts` unless `advanced.trustedProxyHeaders: true` (1.7 upgrade guide, above).
- `trustedOrigins` accepts array, async function, and wildcards (`?`, `*`, `**`). Source: options.mdx above.
- Rate limiting: enabled in production, disabled in development; default max 100; `/sign-in/email` is limited to 3 per 10 s; storage `memory | database | secondary-storage | custom`, database model `rateLimit` (id, key, count, lastRequest bigint); docs warn memory storage is unsuitable for serverless. Source: https://github.com/better-auth/better-auth/blob/main/docs/content/docs/concepts/rate-limit.mdx (2026-09-30). Note: rate-limit.mdx says default window 60 s while options.mdx says 10 s (see Unverified).
- CSRF: origin-header validation against `trustedOrigins`, Fetch Metadata checks for first-login, `SameSite=Lax`, no mutations on GET; `advanced.disableCSRFCheck` and `disableOriginCheck` exist and are warned against. Source: https://github.com/better-auth/better-auth/blob/main/docs/content/docs/reference/security.mdx (2026-09-30).
- Breaking changes last 12 months: 1.4 (2025-11-22): `forgotPassword` -> `requestPasswordReset`, `advanced.generateId` removed in favour of `advanced.database.generateId`, `useNumberId` -> `generateId: "serial"` (https://better-auth.com/blog/1-4). 1.7 (2026-08-18): `trustedProxyHeaders` opt-in, `experimental.joins` -> `advanced.database.joins`, generic OAuth rebuilt, MCP moved to `@better-auth/mcp`, `getIp` -> `getIP`, 1.7.0-1.7.2 `account.issuer` NOT NULL reverted in 1.7.3 (upgrade guide above).

### Drizzle ORM / drizzle-kit / postgres.js

- `drizzle-orm` 0.45.3 and `drizzle-kit` 0.31.11, both published 2026-09-21; `postgres` 3.4.9 (2026-04-05, ESM `type: module` with CJS export). Source: npm registry (2026-09-30).
- postgres.js setup: `import { drizzle } from 'drizzle-orm/postgres-js'; import postgres from 'postgres'; const client = postgres(url, {...}); const db = drizzle({ client })`. Source: https://orm.drizzle.team/docs/get-started-postgresql (2026-09-30).
- `drizzle.config.ts`: `defineConfig({ dialect: "postgresql", schema, out, dbCredentials: { url } })`; `dbCredentials.ssl` accepts `"require" | "allow" | "prefer" | "verify-full"` or TLS options. Source: https://orm.drizzle.team/docs/drizzle-config-file (2026-09-30).
- drizzle-kit picks the driver from the project: `pg` first, else `postgres`; with postgres.js it opens `postgres(url, { max: 1 })` and runs queries via `client.unsafe(sql, params)`. Source: https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-kit/src/cli/connections.ts (2026-09-30). postgres.js `sql.unsafe` defaults prepared statements **off**. Source: https://github.com/porsager/postgres/blob/master/README.md (2026-09-30).
- postgres.js: `prepare: true` by default; README says `prepare: false` was needed for PgBouncer transaction mode but "since 1.21.0 PgBouncer supports protocol-level named prepared statements when configured properly". `max` default 10, `idle_timeout` 0, `max_lifetime` random 30-60 min, `connect_timeout` 30. Source: README above.
- postgres.js SSL: URL `sslmode=` is copied into `ssl`; `'require' | 'allow' | 'prefer'` set `rejectUnauthorized: false`; an object is spread into `tls.connect` options; any other string (e.g. `verify-full`) leaves Node TLS defaults (certificate verified, `servername` set to the host) so `sslmode=verify-full` behaves as verify-full. Sources: https://github.com/porsager/postgres/blob/master/src/index.js , https://github.com/porsager/postgres/blob/master/src/connection.js (2026-09-30).
- Drizzle's Supabase guide says to set `prepare: false` for Supavisor "Transaction" mode. Source: https://orm.drizzle.team/docs/connect-supabase (2026-09-30). It does not say which URL drizzle-kit must use.

### Vercel

- Region list includes `gru1 | sa-east-1 | São Paulo, Brazil`; functions default to `iad1`. Source: https://vercel.com/docs/regions (last_updated 2026-08-11; checked 2026-09-30).
- `regions`: "Users on Pro and Enterprise can deploy to multiple regions. Hobby plans can select any single region." Example `{"$schema": "https://openapi.vercel.sh/vercel.json", "regions": ["sfo1"]}`. Source: https://vercel.com/docs/project-configuration/vercel-json#regions (2026-09-30). Limits table: Hobby single region, Pro 5, Enterprise all. Dashboard path: Settings -> Functions -> Function Regions. CLI: `vercel deploy --regions gru1`. Source: https://vercel.com/docs/functions/configuring-functions/region (2026-09-30).
- `vercel.ts` exists (`import { type VercelConfig } from '@vercel/config/v1'; export const config: VercelConfig = {...}`), same properties as vercel.json, "Use only one configuration file: `vercel.ts` or `vercel.json`." Source: https://vercel.com/docs/project-configuration/vercel-ts (2026-09-30).
- Vercel CLI 62.0.0 (2026-09-30). `vercel env add name [environment] [options]`: `--value <VALUE>` (non-interactive), `--yes`, `--force` (overwrite same target), `--sensitive` / `--no-sensitive`, `--type config|secret`, `--git-branch`; environment accepts comma-separated targets: `vercel env add API_URL production,preview,development`; stdin: `echo value | vercel env add NAME production`. Source: `npx vercel@62.0.0 env add --help` run locally 2026-09-30; docs https://vercel.com/docs/cli/env (2026-08-20). The docs add: production/preview default to `sensitive`, development is `encrypted`, and "If you select development with production or preview in the same command, `vercel env add` returns an error. Add development variables in a separate command."
- `vercel env pull [file]` writes development vars to `.env.local` by default; `--environment=preview [--git-branch=x]`; `--yes` overwrites. Source: https://vercel.com/docs/cli/env (2026-09-30).
- Fluid compute pooling: `attachDatabasePool(pool)` from `@vercel/functions` (3.9.9) closes idle clients before suspension; documented clients are pg, mysql2, mariadb, mongodb, ioredis, cassandra-driver "and other compatible pool types". Guidance: short idle timeout (about 5 s), avoid `max: 1`. Sources: https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#attachdatabasepool , https://vercel.com/kb/guide/efficiently-manage-database-connection-pools-with-fluid-compute (2026-09-30).

### Supabase

- Connection strings: direct `postgresql://postgres:[PW]@db.[REF].supabase.co:5432/postgres` ("Direct connections are on IPv6, or on IPv4 if the project has the IPv4 add-on"); session pooler `postgresql://postgres.[REF]:[PW]@aws-[N]-[REGION].pooler.supabase.com:5432/postgres` (IPv4); transaction pooler port 6543. "Migrations, pg_dump, backup and restore, or replication" should use the direct connection. Source: https://supabase.com/docs/guides/database/connecting-to-postgres (2026-09-30).
- `supabase db dump` flags: `--db-url`, `--data-only`, `--role-only`, `--schema`, `-x/--exclude`, `--use-copy`, `--keep-comments`, `-f`, `--linked`, `--local`, `-p`. Default schema dump "exclude[s] Supabase managed schemas". Source: https://supabase.com/docs/reference/cli/supabase-db-dump (2026-09-30).
- The CLI's managed-schema exclusion list (`InternalSchemas`): `information_schema, pg_*, _analytics, _realtime, _supavisor, auth, etl, extensions, pgbouncer, realtime, storage, supabase_functions, supabase_migrations, cron, dbdev, graphql, graphql_public, net, pgmq, pgsodium, pgsodium_masks, pgtle, repack, tiger, tiger_data, timescaledb_*, _timescaledb_*, topology, vault`. Source: https://github.com/supabase/cli/blob/develop/apps/cli-go/pkg/migration/dump.go (2026-09-30).
- Official backup/restore recipe: `supabase db dump --db-url "$URL" -f roles.sql --role-only`, `... -f schema.sql`, `... -f data.sql --use-copy --data-only -x storage.buckets_vectors -x storage.vector_indexes`; restore with `psql --single-transaction --variable ON_ERROR_STOP=1 --command 'SET session_replication_role = replica' --file ...`. Source: https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore (2026-09-30).
- `auth.users` (GoTrue): `id uuid PK, email varchar(255) UNIQUE, encrypted_password varchar(255), raw_app_meta_data jsonb, raw_user_meta_data jsonb, created_at timestamptz, updated_at timestamptz, last_sign_in_at, invited_at, aud, role, instance_id, ...`; `confirmed_at` was renamed `email_confirmed_at` (migration 20210710035447) and `confirmed_at` re-added as `GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED` (20210722035447). Sources: https://github.com/supabase/auth/blob/master/migrations/00_init_auth_schema.up.sql , https://github.com/supabase/auth/blob/master/migrations/20210710035447_alter_users.up.sql , https://github.com/supabase/auth/blob/master/migrations/20210722035447_adds_confirmed_at.up.sql (2026-09-30).
- "Supabase Auth uses bcrypt ... to store hashes of users' passwords ... The hash is stored in the `encrypted_password` column of the `auth.users` table." Source: https://supabase.com/docs/guides/auth/password-security (2026-09-30).
- Storage S3: generate Access Key ID / Secret in project Storage settings (`/dashboard/project/_/storage/settings`), copy endpoint and region from the S3 configuration page; client config `forcePathStyle: true, region: '<project_region>', endpoint: 'https://<project_ref>.storage.supabase.co/storage/v1/s3'`; access keys bypass RLS and are server-only. Source: https://supabase.com/docs/guides/storage/s3/authentication (2026-09-30). Supported ops include ListObjectsV2, GetObject, PutObject, HeadObject, CopyObject, multipart; no versioning. Source: https://supabase.com/docs/guides/storage/s3/compatibility (2026-09-30).

### Next.js / AWS SDK

- Next.js latest 16.3.8 (2026-09-30). Route handlers: `export async function GET(request: Request, { params }: { params: Promise<{...}> })`; `context.params` became a Promise in v15.0.0-RC; GET is dynamic by default since v15. Source: https://nextjs.org/docs/app/api-reference/file-conventions/route (2026-09-30).
- Next.js 16: Node >= 20.9, TypeScript >= 5.1, Turbopack default, synchronous `params/cookies/headers` removed, `middleware.ts` -> `proxy.ts`, `next lint` removed, `revalidateTag` takes a second argument. Source: https://nextjs.org/docs/app/guides/upgrading/version-16 (2026-09-30).
- Presigned URLs: `import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"; import { getSignedUrl } from "@aws-sdk/s3-request-presigner"; getSignedUrl(client, new PutObjectCommand({ Bucket, Key }), { expiresIn: 3600 })`. Source: https://github.com/awsdocs/aws-doc-sdk-examples/blob/main/javascriptv3/example_code/s3/scenarios/presigned-url-upload.js (2026-09-30). Both packages at 3.1144.0 (npm, 2026-09-30).
- `bcryptjs` 3.0.3 (2025-11-02), ESM, bundled types, compatible with the C++ `bcrypt` hashes, ~30% slower, 72-byte input limit. Source: https://github.com/dcodeIO/bcrypt.js/blob/main/README.md , npm registry (2026-09-30).

### Security advisories (better-auth, last 18 months)

- CVE-2025-27143 open redirect in email verification `callbackURL`, < 1.1.21. https://nvd.nist.gov/vuln/detail/CVE-2025-27143
- CVE-2025-61928 (CVSS 9.3) unauthenticated API-key creation/modification via the API-keys plugin, < 1.3.26 (published 2025-11-26). https://www.wiz.io/vulnerability-database/cve/cve-2025-61928
- CVE-2025-71401 baseURL/basePath poisoning by the first request after startup (DoS), < 1.4.2. https://hol.org/guard/security/cves/CVE-2025-71401-better-auth-before-142-basepath-modification-dos
- CVE-2025-71399 (CVSS 8.6) bypass of disabled-route / rate-limit controls. https://www.redpacketsecurity.com/cve-alert-cve-2025-71399-better-auth-better-auth/
- June 2026 security update (fixed in 1.6.11 and later): critical SSRF in SSO provider registration, critical OIDC/MCP refresh-token handling, OAuth account-linking ownership, org invitation ownership, device-flow owner binding (CVE-2026-45337), OAuth-provider privilege checks (CVE-2026-41427), session cleanup after user deletion (low). https://better-auth.com/blog/security-update-june-2026
- GitHub advisories 2026: GHSA-qq9h-g4jm-xgf3 (core, High, 2026-06-26: attacker's password keeps working after magic-link/OTP sign-in), GHSA-86j7-9j95-vpqj (OIDC/MCP `javascript:` redirect URIs), GHSA-rjg6-39jm-rgg4 (SCIM, Critical), GHSA-mx9r-x6ww-qjw9 / GHSA-8c5h-wx78-2cfg / GHSA-prpr-5gj3-qqhg (SSO), GHSA-q84f-53jg-9ppm (device flow, 2026-09-28), GHSA-h3rm-78g3-j7cp (Stripe). https://github.com/better-auth/better-auth/security/advisories
- 1.7.6 "rejects passwords exceeding maximum length before hashing" (hardening). https://github.com/better-auth/better-auth/releases

## Template code

Pinned `package.json` dependencies (versions read from npm on 2026-09-30):

```json
{
  "dependencies": {
    "next": "16.3.8",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "better-auth": "^1.7.6",
    "drizzle-orm": "^0.45.3",
    "postgres": "^3.4.9",
    "@aws-sdk/client-s3": "^3.1144.0",
    "@aws-sdk/s3-request-presigner": "^3.1144.0",
    "bcryptjs": "^3.0.3"
  },
  "devDependencies": {
    "drizzle-kit": "^0.31.11",
    "auth": "^1.7.6"
  },
  "scripts": {
    "auth:schema": "auth generate --config lib/auth.ts --output lib/auth-schema.ts -y",
    "db:push": "drizzle-kit push",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

`bcryptjs` is only needed by projects that migrate Supabase users; keep it out of the base template and add it in `docs/migration-from-supabase.md`.

### `lib/db.ts`

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// DATABASE_URL ends in ?sslmode=verify-full. postgres.js copies sslmode into `ssl`;
// any value other than require/allow/prefer keeps Node TLS defaults, i.e. the
// certificate chain and hostname are verified (src/index.js, src/connection.js).
const globalForDb = globalThis as unknown as { pgClient?: ReturnType<typeof postgres> };

export const client =
  globalForDb.pgClient ??
  postgres(process.env.DATABASE_URL!, {
    max: 5,               // per Fluid instance; PgBouncer max_client_conn=1000 upstream
    idle_timeout: 20,     // seconds; Vercel suggests short idle timeouts under Fluid compute
    max_lifetime: 60 * 30,
    connect_timeout: 10,
    prepare: true,        // PgBouncer >= 1.21 with max_prepared_statements handles named statements
    connection: { application_name: process.env.VERCEL_URL ?? "nextjs" },
  });

if (process.env.NODE_ENV !== "production") globalForDb.pgClient = client;

export const db = drizzle({ client, schema });
```

### `drizzle.config.ts`

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./lib/schema.ts", "./lib/auth-schema.ts"],
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

### `lib/auth.ts`

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "./db";
import * as authSchema from "./auth-schema"; // generated: npx auth@latest generate

export const auth = betterAuth({
  // Explicit baseURL prevents request-derived baseURL poisoning (CVE-2025-71401 class).
  // Production: BETTER_AUTH_URL=https://app.example.com. Previews: see allowedHosts below.
  baseURL: process.env.BETTER_AUTH_URL
    ? process.env.BETTER_AUTH_URL
    : {
        allowedHosts: [
          process.env.VERCEL_URL!,           // exact preview host, e.g. myapp-abc123.vercel.app
          process.env.VERCEL_BRANCH_URL!,    // exact branch alias
        ].filter(Boolean),
        protocol: "https",
      },
  secret: process.env.BETTER_AUTH_SECRET,   // also read automatically from env
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    autoSignIn: true,
    requireEmailVerification: false,        // flip on once sendVerificationEmail is wired
    revokeSessionsOnPasswordReset: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,            // 7 days (default)
    updateAge: 60 * 60 * 24,                // 1 day (default)
    cookieCache: { enabled: true, maxAge: 5 * 60 }, // avoids a DB hit on every request
  },
  rateLimit: {
    enabled: true,
    storage: "database",                    // memory storage does not survive across Fluid instances
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 10, max: 3 },
      "/sign-up/email": { window: 60, max: 5 },
      "/request-password-reset": { window: 60, max: 3 },
    },
  },
  advanced: {
    useSecureCookies: true,                 // always Secure + __Secure- prefix
    database: { generateId: "uuid" },       // matches Supabase uuid ids for migrated users
    ipAddress: { ipAddressHeaders: ["x-forwarded-for"] }, // Vercel sets this
  },
  plugins: [nextCookies()],                 // must be last
});
```

Notes:
- `rateLimit.storage: "database"` adds a `rateLimit` table; regenerate the schema after enabling it.
- Do not put `https://*.vercel.app` in `allowedHosts`/`trustedOrigins`; it trusts every Vercel app. Use the exact `VERCEL_URL`/`VERCEL_BRANCH_URL` (both set by Vercel at build and runtime).
- If a reverse proxy is ever placed in front, `advanced.trustedProxyHeaders: true` is required in 1.7 for forwarded headers to be honoured.

### `lib/auth-client.ts`

```ts
import { createAuthClient } from "better-auth/react";
export const authClient = createAuthClient();
```

### `app/api/auth/[...all]/route.ts`

```ts
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth);
```

### `lib/s3.ts`

```ts
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const s3 = new S3Client({
  region: process.env.S3_REGION ?? "garage",
  endpoint: process.env.S3_ENDPOINT,        // https://s3.example.com
  forcePathStyle: true,                     // one TLS cert covers every bucket
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
});

const Bucket = process.env.S3_BUCKET!;

export function getPresignedUploadUrl(key: string, contentType: string, expiresIn = 300) {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }),
    { expiresIn },
  );
}

export function getPresignedDownloadUrl(key: string, expiresIn = 300) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: key }), { expiresIn });
}
```

### `vercel.json`

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["gru1"]
}
```

### `.env.example`

```bash
# From `dbm env <slug>`
DATABASE_URL=postgresql://myapp_app:<pw>@db.example.com:6432/myapp?sslmode=verify-full
S3_ENDPOINT=https://s3.example.com
S3_REGION=garage
S3_BUCKET=myapp
S3_ACCESS_KEY_ID=GK...
S3_SECRET_ACCESS_KEY=...
BETTER_AUTH_SECRET=<openssl rand -base64 32>
# Production only. Leave unset on preview so allowedHosts (VERCEL_URL) is used.
BETTER_AUTH_URL=https://app.example.com
```

### Skill commands (non-interactive Vercel env push)

```bash
# production + preview in one call (sensitive by default); development separately (cannot be sensitive)
vercel env add DATABASE_URL production,preview --value "$DATABASE_URL" --yes --force
vercel env add DATABASE_URL development       --value "$DATABASE_URL" --yes --force
vercel env add BETTER_AUTH_SECRET production,preview --value "$BETTER_AUTH_SECRET" --yes --force
vercel env add BETTER_AUTH_URL production --value "https://app.example.com" --yes --force
# pull for local dev
vercel env pull .env.local --yes
```

## Supabase export procedure

All commands run on the VPS inside a `postgres:17` container (`dbm import`) or locally with the Supabase CLI. Get the **direct** connection string from Dashboard -> Connect (needs IPv6 from the runner, or the IPv4 add-on); otherwise use the **session pooler** on port 5432 (`postgres.<ref>@aws-N-<region>.pooler.supabase.com`). Never use the transaction pooler (6543) for pg_dump.

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

Equivalent with the Supabase CLI (no pg_dump install needed; it excludes the managed schema list automatically):

```bash
supabase db dump --db-url "$SRC" -f schema.sql
supabase db dump --db-url "$SRC" -f data.sql --data-only --use-copy \
  -x storage.buckets_vectors -x storage.vector_indexes
```

Expected restore errors to report (spec 7): FKs to `auth.users`, `auth.uid()` in defaults/policies, `storage.objects` references, `extensions.*` function calls (e.g. `extensions.uuid_generate_v4()` -> `gen_random_uuid()`), and `GRANT` lines for `anon`/`authenticated`/`service_role` (suppressed by `--no-privileges`).

Storage sync (Supabase -> Garage):

```bash
# Enable S3 protocol + create access keys: Dashboard -> Project Settings -> Storage -> S3 Connection
rclone sync \
  ":s3,provider=Other,endpoint=https://<REF>.storage.supabase.co/storage/v1/s3,region=<project_region>,force_path_style=true,access_key_id=$SB_KEY,secret_access_key=$SB_SECRET:<bucket>" \
  ":s3,provider=Other,endpoint=https://s3.example.com,region=garage,force_path_style=true,access_key_id=$S3_ACCESS_KEY_ID,secret_access_key=$S3_SECRET_ACCESS_KEY:<slug>" \
  --checksum=false --size-only
```

(`--size-only`: Supabase S3 does not support Content-MD5/ETag checksums per the compatibility page.)

## User migration approach

Supabase hosted projects hash with bcrypt (`$2a$10$...`). better-auth's default is scrypt and it does not detect bcrypt, so the project must (1) insert legacy rows with the bcrypt hash untouched, (2) verify bcrypt when the stored hash starts with `$2`, and (3) rehash to scrypt after a successful legacy login.

`scripts/migrate-supabase-users.ts` (review before running; idempotent on `user.id`):

```ts
import { parse } from "csv-parse/sync";
import { readFileSync } from "node:fs";
import { db } from "../lib/db";
import { user, account } from "../lib/auth-schema";

type Row = {
  id: string; email: string; encrypted_password: string | null;
  email_confirmed_at: string | null; raw_user_meta_data: string;
  created_at: string; updated_at: string;
};

const rows = parse(readFileSync("auth-users.csv"), { columns: true }) as Row[];

for (const r of rows) {
  const meta = r.raw_user_meta_data ? JSON.parse(r.raw_user_meta_data) : {};
  const createdAt = new Date(r.created_at);
  const updatedAt = new Date(r.updated_at || r.created_at);

  await db.insert(user).values({
    id: r.id,                                    // keep the Supabase uuid so app FKs survive
    email: r.email.toLowerCase(),
    emailVerified: r.email_confirmed_at != null,
    name: meta.full_name ?? meta.name ?? r.email.split("@")[0],
    image: meta.avatar_url ?? null,
    createdAt, updatedAt,
  }).onConflictDoNothing();

  if (r.encrypted_password) {
    await db.insert(account).values({
      id: crypto.randomUUID(),
      userId: r.id,
      accountId: r.id,                           // credential accounts use user.id
      providerId: "credential",
      password: r.encrypted_password,            // bcrypt, stored as-is
      createdAt, updatedAt,
    }).onConflictDoNothing();
  }
  // OAuth identities (auth.identities) map to account rows with providerId = provider,
  // accountId = identity.provider_id; see the official guide for the join query.
}
```

`lib/auth.ts` additions for migrated projects:

```ts
import { compare as bcryptCompare } from "bcryptjs";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { createAuthMiddleware } from "better-auth/api";

const isBcrypt = (h: string) => /^\$2[aby]\$/.test(h);

export const auth = betterAuth({
  // ...as above...
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

Why this shape:
- `verify` receives `{ hash, password }` (documented signature); `hashPassword`/`verifyPassword` are the exported scrypt defaults.
- `internalAdapter.updatePassword(userId, hash)` targets exactly `providerId = "credential" AND accountId = userId` (source-verified), which is the row the script inserts.
- `newSession` is only present in `after` hooks after a successful sign-in, so the rehash never runs for failed attempts.
- bcryptjs is pure JS (no native build on Vercel); its 72-byte input limit matches bcrypt semantics of the original hashes.
- Once no `$2` hashes remain (`SELECT count(*) FROM account WHERE password LIKE '$2%'`), remove the hook and `bcryptjs`.

## Unverified / uncertain

- **drizzle-kit `push`/`migrate` through PgBouncer transaction mode.** No official drizzle-kit or PgBouncer doc addresses it. Source analysis: with only `postgres` installed, drizzle-kit opens `postgres(url, { max: 1 })` and issues queries via `client.unsafe()`, which is unprepared by default; drizzle's migrator wraps migrations in a transaction. That should be compatible with transaction pooling and with `max_prepared_statements=200`. It must be proven by the integration test (`test/compose`), including `drizzle-kit push` with an FK change. If `pg` is also installed drizzle-kit prefers it; keep `pg` out of the template.
- **`attachDatabasePool` with postgres.js.** Vercel lists pg, mysql2, mariadb, mongodb, ioredis, cassandra "and other compatible pool types"; postgres.js is not named. The template relies on `idle_timeout` instead.
- **better-auth rate-limit default window.** `rate-limit.mdx` says 60 s, `options.mdx` says 10 s. The template sets `window` explicitly, so it does not matter, but the spec should not quote a default.
- **`vercel env add production,preview,development` in one call.** The CLI help shows it; the docs say combining development with production/preview errors because production/preview default to sensitive. Untested; the skill uses two calls.
- **Supabase direct connection reachability from the VPS.** Direct host is IPv6-only without the IPv4 add-on; whether the VPS has IPv6 egress is provider-specific. Fallback documented: session pooler on 5432.
- **GoTrue hash formats other than bcrypt.** GoTrue can verify argon2/firebase-scrypt hashes imported by users; hosted Supabase sign-ups are bcrypt. The migration script should log and skip any hash not matching `^\$2[aby]\$`.
- **Presigned PUT against Garage with path-style + SigV4.** Standard, but Garage-specific quirks (e.g. `ContentType` in the signature, CORS for browser PUT) were not tested here; the S3 research track owns this.
- Release dates from the GitHub releases page rendered incorrectly in the fetch tool; npm `time` data was used instead.

## Recommended spec deviations

1. **5.7 / SKILL step 4-5:** install the CLI as `auth` (not `@better-auth/cli`) and run `npx auth@latest generate --output lib/auth-schema.ts` before `drizzle-kit push`. Add `lib/auth-schema.ts` and `lib/schema.ts` to the template list. Node >= 22.12 is required by the CLI (spec says Node 22+; tighten to 22.12+).
2. **5.7 templates:** add `rateLimit.storage: "database"` (memory storage is per-instance on Vercel) and `advanced.useSecureCookies: true`. Add `advanced.database.generateId: "uuid"` so migrated Supabase ids and new ids share a type.
3. **11 Vercel env:** replace "`vercel env add` for production, preview, development" with the two-call pattern `production,preview` then `development`, using `--value --yes --force`; note `BETTER_AUTH_URL` should be set for production only and preview should rely on `baseURL.allowedHosts` with exact `VERCEL_URL`/`VERCEL_BRANCH_URL`, not `*.vercel.app`.
4. **11 pool sizing:** keep `max: 5`, but lower `idle_timeout` toward 10-20 s and set `max_lifetime`; note `attachDatabasePool` is optional/unverified for postgres.js.
5. **11 vercel.json:** keep vercel.json; mention `vercel.ts` only as an alternative, since "only one configuration file" is allowed and the skill should refuse to add `vercel.json` if `vercel.ts` exists.
6. **7 `dbm import`:** default pg_dump flags should also include `--no-publications --no-subscriptions` and split schema/data (`--schema-only` then `--data-only` with `session_replication_role = replica`) so trigger/FK ordering does not create noise in the report. Accept a session-pooler URL as fallback when the direct host is IPv6-only.
7. **13 Users:** the "rehash on next login" step needs an explicit `hooks.after` (better-auth does not rehash by itself). Ship it in the migration doc as above and document the SQL to detect when the hook can be removed.
8. **5.7 / 15 testing:** add an integration test that runs `drizzle-kit push` and `drizzle-kit migrate` through PgBouncer (transaction mode, `max_prepared_statements=200`) since this is the unverified assumption the whole "no direct port" design rests on. Fallback if it fails: `dbm tunnel <slug>` (SSH local forward to the container's 5432) for migrations.
9. **9 security:** pin `better-auth` to `^1.7.6`, avoid optional plugins (SSO, SCIM, OAuth provider, API keys are where the 2025-2026 advisories concentrate), and add a Dependabot/renovate note for `better-auth` in the template README.

## Sources

- npm registry: https://registry.npmjs.org/better-auth , https://registry.npmjs.org/auth , https://registry.npmjs.org/@better-auth/cli , https://registry.npmjs.org/drizzle-orm , https://registry.npmjs.org/drizzle-kit , https://registry.npmjs.org/postgres , https://registry.npmjs.org/next , https://registry.npmjs.org/@aws-sdk/client-s3 , https://registry.npmjs.org/@aws-sdk/s3-request-presigner , https://registry.npmjs.org/bcryptjs , https://registry.npmjs.org/@vercel/functions , https://registry.npmjs.org/vercel
- better-auth docs: https://www.better-auth.com/docs/integrations/next , https://www.better-auth.com/docs/adapters/drizzle , https://www.better-auth.com/docs/concepts/cli , https://www.better-auth.com/docs/concepts/session-management , https://www.better-auth.com/docs/concepts/cookies , https://www.better-auth.com/docs/concepts/rate-limit , https://www.better-auth.com/docs/reference/options , https://better-auth.com/blog/1-4 , https://better-auth.com/blog/security-update-june-2026
- better-auth source/docs on GitHub: https://github.com/better-auth/better-auth/blob/main/docs/content/docs/authentication/email-password.mdx , https://github.com/better-auth/better-auth/blob/main/docs/content/docs/concepts/database.mdx , https://github.com/better-auth/better-auth/blob/main/docs/content/docs/concepts/hooks.mdx , https://github.com/better-auth/better-auth/blob/main/docs/content/docs/reference/security.mdx , https://github.com/better-auth/better-auth/blob/main/docs/content/docs/guides/dynamic-base-url.mdx , https://github.com/better-auth/better-auth/blob/main/docs/content/docs/guides/1-7-upgrade-guide.mdx , https://github.com/better-auth/better-auth/blob/main/docs/content/docs/guides/supabase-migration-guide.mdx , https://github.com/better-auth/better-auth/blob/main/docs/content/docs/guides/auth0-migration-guide.mdx , https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/api/routes/sign-in.ts , https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/db/internal-adapter.ts , https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/cookies/index.ts , https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/crypto/password.ts , https://github.com/better-auth/better-auth/issues/5016 , https://github.com/better-auth/better-auth/pull/5054 , https://github.com/better-auth/better-auth/releases , https://github.com/better-auth/better-auth/security/advisories
- CVEs: https://nvd.nist.gov/vuln/detail/CVE-2025-27143 , https://www.wiz.io/vulnerability-database/cve/cve-2025-61928 , https://hol.org/guard/security/cves/CVE-2025-71401-better-auth-before-142-basepath-modification-dos , https://www.redpacketsecurity.com/cve-alert-cve-2025-71399-better-auth-better-auth/
- Drizzle: https://orm.drizzle.team/docs/get-started-postgresql , https://orm.drizzle.team/docs/drizzle-config-file , https://orm.drizzle.team/docs/drizzle-kit-push , https://orm.drizzle.team/docs/connect-supabase , https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-kit/src/cli/connections.ts
- postgres.js: https://github.com/porsager/postgres/blob/master/README.md , https://github.com/porsager/postgres/blob/master/src/index.js , https://github.com/porsager/postgres/blob/master/src/connection.js
- Vercel: https://vercel.com/docs/regions , https://vercel.com/docs/functions/configuring-functions/region , https://vercel.com/docs/project-configuration/vercel-json , https://vercel.com/docs/project-configuration/vercel-ts , https://vercel.com/docs/cli/env , https://vercel.com/docs/environment-variables/manage-across-environments , https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package , https://vercel.com/kb/guide/efficiently-manage-database-connection-pools-with-fluid-compute , https://community.vercel.com/t/add-multiple-environments-with-vercel-env-add/25662 , local `npx vercel@62.0.0 env add --help`
- Supabase: https://supabase.com/docs/guides/database/connecting-to-postgres , https://supabase.com/docs/reference/cli/supabase-db-dump , https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore , https://supabase.com/docs/guides/auth/password-security , https://supabase.com/docs/guides/storage/s3/authentication , https://supabase.com/docs/guides/storage/s3/compatibility , https://github.com/supabase/cli/blob/develop/apps/cli-go/pkg/migration/dump.go , https://github.com/supabase/auth/blob/master/migrations/00_init_auth_schema.up.sql , https://github.com/supabase/auth/blob/master/migrations/20210710035447_alter_users.up.sql , https://github.com/supabase/auth/blob/master/migrations/20210722035447_adds_confirmed_at.up.sql
- Next.js / AWS / bcryptjs: https://nextjs.org/docs/app/api-reference/file-conventions/route , https://nextjs.org/docs/app/guides/upgrading/version-16 , https://github.com/awsdocs/aws-doc-sdk-examples/blob/main/javascriptv3/example_code/s3/scenarios/presigned-url-upload.js , https://github.com/dcodeIO/bcrypt.js/blob/main/README.md
