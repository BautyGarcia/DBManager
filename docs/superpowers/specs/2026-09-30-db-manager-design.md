# db-manager (`dbm`) — Design Spec

**Date:** 2026-09-30 (revision 2, after research pass)
**Status:** Approved design; revised with findings from `docs/superpowers/research/*.md`
**Repo:** public, MIT. npm package `db-manager`, binary `dbm`.

Revision 2 folds in the six research reports under `docs/superpowers/research/`. Every "verified" claim below cites the report that checked it. Items the research could not confirm are listed in Section 19 and must be verified by the implementer at the step named.

## 1. Purpose

`dbm` is a self-hosted replacement for the "one Supabase project per app" workflow. It turns a single VPS into a personal database platform where each app gets its own isolated Postgres database, its own S3 bucket, and a set of credentials that drop straight into a Next.js project on Vercel. Creating, pausing, destroying, backing up, and inspecting projects is one command each, from a laptop or from an AI agent.

The owner today runs many Supabase free-tier accounts (one per project) and is about to cross the free-tier limits on several of them. Consolidating on a paid Supabase org costs 25 USD plus 10 USD per project per month. A single 8GB VPS runs the same workload for a fraction of that, with room to grow by resizing the machine.

### Success criteria

- `dbm create <slug>` returns working Next.js env vars in under two minutes.
- A Next.js app on Vercel (gru1 region) connects through TLS with certificate verification and serves requests with acceptable latency from Argentina.
- Twenty idle projects plus three active ones (2-3k users each) fit on a 4 vCPU / 8GB VPS.
- Every project has an automatic nightly off-site backup; a destroyed project is recoverable for 30 days.
- The Dokploy dashboard shows per-project CPU, memory, and disk.
- A fresh Ubuntu 24.04 VPS goes from bare OS to a passing smoke test with `dbm init` and the documented prerequisites.
- The repo is self-explanatory enough that someone else can clone it and run their own instance.

## 2. Non-goals

- **Browser-side database access.** No anon key, no PostgREST, no RLS-as-security-boundary. All queries run in server code.
- **Hosting an auth server.** Auth is [better-auth](https://www.better-auth.com) running inside each Next.js app, storing users in that project's database.
- **Multi-tenant SaaS.** All projects belong to the operator. No user accounts, teams, or billing in `dbm`.
- **Multi-VPS orchestration.** Version 1 targets one machine.
- **Realtime, edge functions, vector search as managed services.** Postgres extensions can be enabled per project; managed realtime is out of scope.
- **Automated migration of Supabase Auth users.** Documented procedure plus a reviewed script (Section 13), not a `dbm` command.
- **A custom web dashboard.** Dokploy's dashboard is the UI. `dbm list` covers the CLI view.
- **Anonymous public reads on the S3 endpoint.** Garage does not support them; public assets go through Garage's web endpoint on a per-project hostname (Section 5.4).

## 3. Constraints and assumptions

| Item | Decision |
|---|---|
| App hosting | Vercel, Next.js 16 App Router, functions pinned to `gru1` (São Paulo) via `vercel.json` `regions` (verified: app-stack report) |
| VPS OS | **Ubuntu 24.04 LTS only.** 26.04 is excluded until Dokploy lists it as tested and its installer regression (Dokploy issue #5471) is closed. 22.04 is dropped (vps report) |
| VPS size | 4 vCPU / 8GB / 80GB+ SSD to start, root SSH with key, public IPv4 |
| VPS location | Operator's call, documented trade-off: a São Paulo VPS (Vultr `sao`, Hostinger) is in the same metro as Vercel `gru1`; an Argentine provider (DonWeb) adds ~30 ms per query round-trip but bills in ARS and keeps data in Argentina (vps report). Both work with this design |
| Domain | One domain with three DNS records: `db.<domain>`, `s3.<domain>`, wildcard `*.web.<domain>`, all A records to the VPS IPv4 |
| Off-site backups | Backblaze B2, **two buckets**: one for database dumps with a 30-day delete rule, one for storage mirrors with 30-day version retention (Section 5.5). Server-side encryption enabled at bucket creation |
| Private access | Tailscale account with **MagicDNS on and HTTPS certificates enabled** in the admin console (prerequisite for `tailscale serve`) |
| Operator machine | macOS or Linux, **Node >= 22.12.0**, OpenSSH client, Vercel CLI |
| Scale ceiling | Vertical. Resize the VPS. Beyond that is a future spec |
| Minimum component versions | Dokploy >= 0.30.0 (0.30.8 current), PgBouncer 1.26.0, Postgres 18.6 / 17.11, Garage 2.4.1, Traefik 3.6.25 (bundled with Dokploy). `dbm doctor` fails below these (pgbouncer and dokploy reports) |

## 4. Architecture overview

```
                                PUBLIC INTERNET
                                      │
 Vercel functions (gru1) ──TLS──►     │ db.example.com:6432 ──► dbm-pgbouncer ─┬─► <appName-A>:5432
                                      │   (verify-full, Let's Encrypt)         ├─► <appName-B>:5432
                                      │                                        └─► ...
 Vercel / browsers ────────TLS──►     │ s3.example.com:443 ──► Traefik ──► dbm-garage:3900 (S3 API, signed only)
 Browsers (public assets) ─TLS──►     │ <slug>.web.example.com:443 ──► Traefik ──► dbm-garage:3902 (web endpoint)
                                      │
                                TAILSCALE ONLY
                                      │
 Operator / agent ─────────────►      │ https://<host>.<tailnet>.ts.net  (tailscale serve → 127.0.0.1:3000 Dokploy)
 dbm CLI ──────────────────────►      │ Dokploy REST API (same URL) + SSH :22 (key-only, public, fail2ban)
```

All boxes live on one VPS as Docker containers managed by Dokploy. Four layers:

1. **Dokploy** — platform. Owns Swarm services, Traefik reverse proxy with Let's Encrypt, dashboard, per-container live metrics, scheduled database backups to S3.
2. **Per-project Postgres** — one Swarm service (container) per project with its own volume, superuser, and non-superuser app role. Created via the Dokploy API. Not exposed publicly.
3. **Shared infrastructure**, deployed once by `dbm init` as Dokploy compose services with fixed container names:
   - **`dbm-pgbouncer`** — the only public database endpoint, TLS-terminating, routing by database name.
   - **`dbm-certs-dumper`** — sidecar that copies the Let's Encrypt cert for `db.<domain>` out of Traefik's `acme.json` into files PgBouncer reads.
   - **`dbm-garage`** — S3-compatible object store; one bucket and one scoped key per project.
   - **storage sync** — a host cron (`/etc/cron.d/dbm-storage-sync`) that runs a throwaway `rclone/rclone:1` container nightly to mirror Garage buckets and metadata snapshots to the off-site storage bucket. No long-running container.
4. **`dbm` CLI** — TypeScript tool on the operator's machine. Orchestrates Dokploy API calls (over the tailnet) and SSH commands. Prints env vars. Ships with an agent skill and Next.js templates.

## 5. Components

### 5.1 Dokploy

Verified in `research/dokploy.md` unless noted.

- Installed with `curl -sSL https://dokploy.com/install.sh | sh`. Current v0.30.8. The installer creates Swarm, the attachable overlay network `dokploy-network`, Traefik v3.6.25 (`docker run -p 80:80 -p 443:443/tcp -p 443:443/udp`), and the `dokploy` Swarm service published on **3000 in host mode on all interfaces**. There is no bind-to-interface option.
- **Blocking 3000 from the internet**: Docker publishes ports before ufw, so ufw alone is insufficient. `dbm init` installs a `DOCKER-USER` iptables allow-list persisted through `/etc/ufw/after.rules` (Section 9). Host-originated traffic from `tailscale serve` to `127.0.0.1:3000` never traverses that chain, so the dashboard keeps working on the tailnet.
- Dashboard and API URL: `https://<host>.<tailnet>.ts.net`, provided by `tailscale serve --bg --https=443 http://127.0.0.1:3000`. No public DNS record.
- **API**: tRPC-over-OpenAPI at `<url>/api/<router>.<procedure>`, header `x-api-key`. Live spec at `GET /api/settings.getOpenApiDocument`. GET procedures take query params; POST take JSON. Response bodies are untyped in the OpenAPI document; `dbm` validates them with zod against the fields listed in the research endpoint table.
- **API token**: the first token must be created in the UI (`/settings/profile`, API/CLI section) with **Rate limit off** (the UI default). `dbm init` then mints its own long-lived key with `POST /api/user.createApiKey {name:"dbm", metadata:{organizationId}, rateLimitEnabled:false}` and stores that; the human-created key can be revoked. Keys created via API without `rateLimitEnabled:false` get 10 requests/day. Keys are organization-wide; there is no per-project scoping, so `~/.dbm/config.json` is a root credential for the platform.
- One Dokploy project named `dbm` (`POST /api/project.create` returns `{project:{projectId}, environment:{environmentId}}`). All services live in its production environment.
- **Postgres service behaviour that shapes `dbm`**:
  - `postgres.create` requires `name, databaseName, databaseUser, databasePassword, environmentId`; `dockerImage` defaults to `postgres:18`; `appName`, if passed, is stored as `<lowercased>-<6 random chars>` and must be unique. `dbm` always reads `appName` back from the response.
  - `databasePassword` must match `^[a-zA-Z0-9@#%^&*()_+\-=[\]{}|;:,.<>?~` + "`" + `]*$` (no `$ ! ' " \ /` or space). `dbm` generates Dokploy passwords from `[A-Za-z0-9]` only.
  - `postgres.update` takes `memoryLimit` and `cpuLimit` as **raw byte / nanoCPU strings** (`"536870912"` for 512MB). Changes apply on the next deploy.
  - `postgres.deploy` is **synchronous**: it pulls the image, creates the Swarm service, waits up to 45s for convergence, and throws 500 on failure. Its response body is the pre-deploy row; `dbm` confirms with `GET /api/postgres.one` (`applicationStatus === "done"`) then `SELECT 1` via `docker exec`.
  - The service is DNS-reachable on `dokploy-network` as `<appName>:5432`. No published port unless `externalPort` is set (never set by `dbm`).
  - Volume is `<appName>-data`, mounted at `/var/lib/postgresql/data` for images < 18 and `/var/lib/postgresql/<N>/docker` for 18+ (Dokploy PR #3048).
  - `postgres.remove` runs `docker service rm` and **does not delete the volume**. `dbm destroy` runs `docker volume rm <appName>-data` over SSH afterwards.
- **Backups**: `backup.create {schedule, prefix, destinationId, database, databaseType:"postgres", postgresId, enabled, keepLatestCount}`. Dokploy runs `pg_dump -Fc --no-acl --no-owner | gzip` and uploads with `rclone rcat` to `s3://<bucket>/<appName>/<prefix>/<timestamp>.sql.gz`. The object is a **gzipped custom-format archive** despite the extension; restore uses `gunzip | pg_restore`. Cron runs in **UTC**. `keepLatestCount` prunes after each run. `backup.manualBackupPostgres {backupId}` is synchronous. Restore has no REST endpoint; `dbm restore` does it over SSH.
- **Compose services**: `compose.create {name, environmentId, composeType:"docker-compose", sourceType:"raw", composeFile, appName}`, then `compose.deploy`. Deploy runs `docker compose -p <appName> up -d`. Compose services join `dokploy-network` by default since v0.30.0; `dbm` still declares it explicitly. `dbm` sets `container_name` on each service so other containers and Traefik can address them by a stable name.
- **Traefik routing for `dbm` hostnames** uses the **file provider** (`/etc/dokploy/traefik/dynamic/dbm-*.yml`, hot-reloaded), written over SSH, instead of Dokploy compose domains (which require a compose redeploy). `acme.json` lives at `/etc/dokploy/traefik/dynamic/acme.json`; the resolver is named `letsencrypt`; HTTP-01 challenge on the `web` entrypoint.
- **Security floor**: 44 advisories published in 2026, most fixed by 0.29.13. `dbm doctor` fails if `GET /api/settings.getDokployVersion` reports < 0.30.0. Operator enables 2FA on the Dokploy account (documented step).
- **Coolify cross-check**: Coolify's API covers the same operations with a richer Postgres body and day-based S3 retention. Dokploy is kept for its lighter footprint, `appName` DNS on a shared network, and `keepLatestCount`. The earlier claim that Dokploy's database API is "more complete" is withdrawn; this is a judgment call.

### 5.2 Per-project Postgres

Verified in `research/pgbouncer-postgres-tls.md` and `research/dokploy.md`.

- **Image**: `postgres:18` (Debian) by default; `dbm create --pg 17` selects `postgres:17`. 18.6 and 17.11 are current minors with identical security cadence; 19 is not offered until 19.1. The major is recorded in state because mount paths and `pg_restore` client versions depend on it.
- **Roles**: Dokploy's `databaseUser` becomes the project **superuser** `<slug>_admin` with a random `[A-Za-z0-9]{32}` password (Dokploy alphabet constraint). After the container is healthy, `dbm` runs as that superuser:
  ```sql
  CREATE ROLE <slug>_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
    PASSWORD 'SCRAM-SHA-256$4096:<salt>$<storedkey>:<serverkey>';
  CREATE DATABASE <slug> OWNER <slug>_app;
  ```
  then, connected to `<slug>`: `CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS "uuid-ossp";` plus any `--extensions`. The `PASSWORD` literal is a **SCRAM verifier computed locally** by `dbm` (`core/scram.ts`, verified byte-for-byte against Postgres 17 in `research/cli-tooling.md`). Postgres accepts a pre-computed verifier, and the identical string goes into PgBouncer's `userlist.txt`, satisfying PgBouncer's "identical secrets" rule without reading `pg_authid`.
- **Tuning for the default 512MB limit**, applied with `ALTER SYSTEM` after first start and followed by one `postgres.deploy` restart: `max_connections=50`, `shared_buffers=128MB`, `effective_cache_size=384MB`, `work_mem=4MB`, `maintenance_work_mem=64MB`, `random_page_cost=1.1`, `huge_pages=off`. `--memory` scales `shared_buffers` to 25% and `effective_cache_size` to 75%. Settings live inside the volume, independent of how Dokploy passes args.
- **No external port.** Reachable only on `dokploy-network` as `<appName>:5432`.
- `dbm doctor` verifies for each project that `SHOW data_directory` is under the mounted volume path (`docker inspect` mounts), because a wrong mount silently loses data on recreate.

### 5.3 PgBouncer

Verified in `research/pgbouncer-postgres-tls.md`.

- **Image**: `edoburu/pgbouncer:v1.26.0-p0`, pinned. PgBouncer 1.26.0 (2026-09-23) fixes CVE-2026-19888, an **unauthenticated remote crash via SCRAM**; nothing older is acceptable. The image runs as `postgres` (uid 70), honours a bind-mounted `pgbouncer.ini`, and its entrypoint leaves mounted files alone. `pgbouncer/pgbouncer` on Docker Hub is a third-party image, and Bitnami's free catalog is frozen. A `compose/pgbouncer/Dockerfile` building from the upstream tarball is kept as an escape hatch.
- **Files** in `/etc/dokploy/dbm/pgbouncer/` on the host, written by `dbm` over SSH with an atomic `mktemp` + `mv`. The **directory** (not the individual files) is bind-mounted to `/etc/pgbouncer`, because a single-file bind mount would keep showing the old inode after `rename()`:

```ini
;; Generated by dbm. Do not edit; run `dbm sync-pgbouncer`.
[databases]
; per project, no user=/password= so SCRAM passes through to the backend
<slug>         = host=<appName> port=5432 dbname=<slug_db>
<slug>_session = host=<appName> port=5432 dbname=<slug_db> pool_mode=session pool_size=3 reserve_pool_size=0

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
unix_socket_dir =
pool_mode = transaction
max_client_conn = 1000
default_pool_size = 10
min_pool_size = 0
reserve_pool_size = 5
reserve_pool_timeout = 3
server_idle_timeout = 300
server_lifetime = 3600
pool_idle_timeout = 3600
client_idle_timeout = 0
query_wait_timeout = 30
client_login_timeout = 15
max_prepared_statements = 200
ignore_startup_parameters = extra_float_digits
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
client_tls_sslmode = require
client_tls_cert_file = /certs/db.example.com/certificate.crt
client_tls_key_file  = /certs/db.example.com/privatekey.key
client_tls_protocols = tlsv1.2,tlsv1.3
server_tls_sslmode = disable
so_reuseport = 1
tcp_keepalive = 1
log_connections = 1
log_disconnections = 1
log_pooler_errors = 1
stats_period = 60
```

  `userlist.txt` (mode 0640, uid 70): one line per app role, `"<slug>_app" "SCRAM-SHA-256$4096:..."`, the same verifier used in `CREATE ROLE`.
- **Session-mode alias**: every project also gets `<slug>_session` (`pool_mode=session`, pool of 3). It is printed as `DATABASE_URL_SESSION` and used by `drizzle-kit` for migrations, giving the Supabase-style "session pooler" without exposing 5432.
- **Reload, not restart**: `docker kill -s HUP dbm-pgbouncer` re-reads the ini, the auth file, and cert/key contents. `dbm init` also installs a host cron (`04:10` daily) that sends the same SIGHUP so renewed certificates are picked up without the dumper needing Docker socket access.
- **TLS**: `dbm init` writes a Traefik file-provider router for `db.<domain>` (pointing at a dummy service) so Traefik obtains a Let's Encrypt certificate. `dbm-certs-dumper` (`ldez/traefik-certs-dumper:v2.11.4`, `file --version v3 --watch --domain-subdir --source /acme/acme.json --dest /certs`) writes PEM files into the host directory `/etc/dokploy/dbm/certs`, bind-mounted read-only into PgBouncer. The daily host cron `chown`s that directory to uid 70 before the SIGHUP, so PgBouncer can read the renewed key without any shell inside the dumper image. Connection strings use `sslmode=verify-full`.
  - **Fallback if the dumper proves brittle**: `dbm init --tls self-ca` generates a private CA and a 10-year server certificate for `db.<domain>`; `dbm env` then also prints `DATABASE_SSL_CA` and the template passes `ssl: { ca }`. Still full chain and hostname verification. **`sslmode=require` is never used**: postgres.js maps it to `rejectUnauthorized: false`, i.e. no verification at all.
  - **Traefik STARTTLS termination is rejected**: PgBouncer loses client IPs (no PROXY protocol support), the database path would ride Dokploy's Traefik container which is recreated on settings saves, and the feature had a CVE and a regression in 2026.
- Port 6432 is the only public database port.

### 5.4 Garage (S3 storage)

Verified in `research/garage-s3.md`.

- **Image**: `dxflrs/garage:v2.4.1`, pinned (no `latest` tag exists). Command `/garage server --single-node`, which auto-creates the layout on first boot and is a no-op afterwards. Volumes for `meta`, `data`, and `snapshots`.
- **`garage.toml`** essentials: `replication_factor = 1`, `consistency_mode = "consistent"`, `db_engine = "lmdb"`, **`metadata_fsync = true`**, **`metadata_auto_snapshot_interval = "6h"`**, `metadata_snapshots_dir` on its own volume (LMDB is known to corrupt on unclean shutdown; these are the documented mitigations), `[s3_api] s3_region = "garage"`, `api_bind_addr = "[::]:3900"`, `[s3_web] bind_addr = "[::]:3902"`, `root_domain = ".web.<domain>"`, `[admin] api_bind_addr = "[::]:3903"`. Secrets via env `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`.
- **Admin API v2** (`POST /v2/<Operation>`, `Authorization: Bearer`). The admin port is published only on the host loopback (`127.0.0.1:3903`), never routed by Traefik. `dbm` calls it by running `curl -K -` on the VPS over SSH with the token and body supplied on stdin (never in argv). `dbm init` creates a **scoped admin token** for the CLI (`CreateAdminToken` with the operations `dbm` needs) and stores that; the master token stays in the compose env on the VPS.
- **Per project** at `create`: `CreateBucket {globalAlias:<slug>}` (store the returned `id`), `CreateKey {name:"<slug>-key", neverExpires:true}`, `AllowBucketKey {bucketId, accessKeyId, permissions:{read:true, write:true}}` (**no `owner`**; CORS and website flags are managed by `dbm`), `AllowBucketKey` for the shared `dbm-backup` key with `read`, and `UpdateBucket?id= {corsRules:[{allowedOrigins:["*"], allowedMethods:["GET","PUT","POST","DELETE","HEAD"], allowedHeaders:["*"], exposeHeaders:["ETag"], maxAgeSeconds:3600}]}` (tighten with `--cors-origin`). Without CORS, browser presigned PUTs fail at preflight.
- **Path-style is always on**, so `s3.<domain>/<bucket>/<key>` works behind Traefik with one certificate. Signed requests only: **Garage has no anonymous access on the S3 endpoint** and no bucket policies.
- **Public buckets** use the web endpoint, which resolves the bucket **by Host header**. `dbm storage public <slug>` sets `websiteAccess.enabled=true`, writes a Traefik file-provider router `Host(<slug>.web.<domain>)` → `dbm-garage:3902` with the `letsencrypt` resolver, and prints `S3_PUBLIC_BASE_URL=https://<slug>.web.<domain>`. `--domain assets.myapp.com` adds a global alias (`AddBucketAlias`) plus a router for a vanity hostname. `--off` reverses it.
- **AWS SDK v3 >= 3.729.0 breaks presigned PUTs** against Garage by signing an empty-body CRC32 (Garage returns `400 InvalidDigest`). The template sets `requestChecksumCalculation: "WHEN_REQUIRED"` and `responseChecksumValidation: "WHEN_REQUIRED"`.
- **`DeleteBucket` requires an empty bucket**; `dbm destroy --purge-storage` runs `CleanupIncompleteUploads`, lists and deletes objects with the project key, then `DeleteBucket`, then `DeleteKey`.
- No CVEs on record; a reflected-XSS fix on the web endpoint shipped in 2.4.0. MinIO's repository was archived on 2026-04-25; RustFS 1.0 GA is two weeks old; SeaweedFS (4.48) remains the documented fallback and, unlike Garage, has bucket policies.

### 5.5 Off-site backups

Verified in `research/dokploy.md` and `research/vps-hardening-tailscale-backups.md`.

- **Database dumps**: one Dokploy schedule per project, cron `<jitter-minute> 6 * * *` UTC (03:00 in Argentina), `prefix = db/<slug>`, `keepLatestCount = 35`. Objects land at `<appName>/db/<slug>/<ts>.sql.gz` in the **dumps bucket**.
- **Dumps bucket (B2)**: private, SSE-B2 enabled at creation, lifecycle rule `daysFromUploadingToHiding = 30, daysFromHidingToDeleting = 1` (whole bucket). This is the provider-side 30-day retention; `keepLatestCount` is the second layer. Not "Keep only the last version", which never expires uniquely named dumps. Application key scoped to this bucket, Read and Write.
- **Storage mirror**: the host cron `/etc/cron.d/dbm-storage-sync` runs nightly `rclone sync` (throwaway `rclone/rclone:1` container on `dokploy-network`) from Garage (S3 backend, `provider=Other`, `endpoint=http://dbm-garage:3900`, `region=garage`, `force_path_style=true`, `no_check_bucket=true`, the read-only `dbm-backup` key) into the **storage bucket** under `storage/<slug>/`, plus `rclone copy` of the Garage snapshots volume under `garage-meta/`. The storage bucket has **no upload-to-hiding rule** (sync would otherwise lose unchanged objects after 30 days) and instead `daysFromHidingToDeleting = 30` so deleted or overwritten objects remain recoverable for 30 days.
- Dokploy's B2 support goes through rclone's generic S3 backend (`provider: "Other"`, `endpoint: https://s3.<region>.backblazeb2.com`, `--s3-force-path-style --s3-no-check-bucket`). One open Dokploy issue (#2329) reports a B2 destination failure on an old version; `dbm init` runs `destination.testConnection` and, on failure, surfaces the rclone error and suggests `additionalFlags`.
- `dbm destroy` always triggers `backup.manualBackupPostgres` and waits before deleting anything.
- Provider-side VPS snapshots are recommended as an independent layer. Not managed by `dbm`.

### 5.6 `dbm` CLI

Verified in `research/cli-tooling.md`; every config file below was exercised in a throwaway project with the pinned versions.

**Package**: `db-manager` on npm (the name `dbm` is taken by an unrelated package), `bin: { "dbm": "./bin/dbm.js" }`. `npx db-manager <cmd>` and `npm i -g db-manager` both work; `npx dbm` cannot.

**Toolchain**: TypeScript 7.0.2 (`tsc`, no bundler), `module: nodenext`, `erasableSyntaxOnly: true` (so **no `enum`, no runtime `namespace`, no constructor parameter properties**; use `as const` objects and explicit fields), relative imports with `.js` specifiers. Biome 2.5.15 for lint and format (typescript-eslint does not support TS 7). Vitest 5.0.3 with `vite` 8.3.1 as a required peer. Node `engines: ">=22.12.0"`; CI on 22 and 24.

**Runtime dependencies**, pinned exactly: `commander` 15.0.0, `execa` 10.0.1, `pg` 8.23.1, `picocolors` 1.1.1, `shlex` 3.0.0, `zod` 4.6.5. Dev: `@biomejs/biome`, `@types/node` 22.x, `@types/pg`, `msw` 3.0.1, `tsx`, `typescript`, `vite`, `vitest`, plus `drizzle-orm`, `drizzle-kit`, `postgres` for the integration test that proves migrations work through PgBouncer.

**Layers**:

```
src/
  cli.ts            buildProgram(io, deps) / run(argv, io) — commander, exitOverride, --json, --yes
  version.ts
  core/             pure functions, no I/O; the unit-test surface
    exit.ts         ExitCode as const, DbmError { exitCode, step }
    naming.ts       validateSlug, deriveNames(slug)
    secrets.ts      randomSecret (base64url), dokployPassword ([A-Za-z0-9])
    scram.ts        scramSha256Verifier(password, { salt, iterations })
    units.ts        parseMemory('512m') → bytes, formatBytes
    state.ts        zod schemas (versioned), loadState, Project type
    config.ts       zod Config schema
    pgbouncer.ts    renderPgbouncerIni(state, cfg), renderUserlist(state)
    sql.ts          createProjectSql(...), tuningSql(memoryBytes), extensionsSql(...)
    env.ts          projectEnv(project, cfg) → Record<string,string>, formatEnvBlock
    garage-config.ts renderGarageToml(cfg)
    compose.ts      renderPgbouncerCompose, renderGarageCompose, renderStorageSyncCompose
    traefik.ts      renderS3Router, renderDbCertRouter, renderWebRouter(slug)
    harden.ts       renderHardenScript(opts) → bash
    cron.ts         backupCron(slug) → '<m> 6 * * *'
  adapters/         one module per external system, each behind an interface in types.ts
    types.ts        DokployClient, SshRunner, PostgresAdmin, GarageAdmin, StateStore
    dokploy.ts      fetch + zod, x-api-key
    ssh.ts          execa → system ssh; run(argv, {input}), upload(path, content, mode)
    postgres.ts     runSql via `ssh docker exec -i <appName> psql -v ON_ERROR_STOP=1 -f -`
    garage.ts       admin v2 via `ssh curl -K -` against 127.0.0.1:3903
    store.ts        ~/.dbm/{config,state}.json, 0600, atomic writes, timestamped .bak
  commands/         orchestration; one file per command; rollback on failure
```

**Remote execution model**: SSH uses the operator's system `ssh` with `-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10`. Remote argv is joined with `shlex`; SQL, file contents, and tokens travel on **stdin**, never in argv. Uploads are one `ssh 'umask 077; t=$(mktemp <dir>/.tmp.XXXXXX); cat > "$t"; mv -f "$t" <path>'` call. `dbm psql` uses `ssh -t` with inherited stdio.

**Local files** (`~/.dbm/`, dir 0700, files 0600, written atomically via temp file + rename):
- `config.json` — `sshHost`, `sshUser`, `dokployUrl` (tailnet HTTPS), `dokployApiKey`, `dokployProjectId`, `dokployEnvironmentId`, `domain`, `dbHost`, `s3Host`, `webDomain`, `garageAdminToken` (scoped), `garageBackupKeyId`, `dumpsDestinationId`, `tls: "letsencrypt" | "self-ca"`, `sslCaPem?`.
- `state.json` — projects (Section 8), `version: 1`.
- `state.json.bak.<ts>` — written before every mutation; last 10 kept.
- `init-progress.json` — checkpoints for resumable `init`.

Nothing under `~/.dbm/` is ever inside the repo. The repo `.gitignore` blocks `.dbm/`, `*.local.json`, `.env*`, `dist/`, `node_modules/`, `coverage/`, `.vitest/`, `*.tgz`.

**Exit codes**: 0 ok; 1 user error (bad slug, missing config, commander parse errors); 2 remote failure; 3 rollback also failed (message lists leftover resources). `--help` / `--version` exit 0. In `--json` mode stdout carries only the JSON document; diagnostics go to stderr.

### 5.7 Agent skill and templates

Verified in `research/app-stack-and-supabase-export.md` and `research/garage-s3.md`.

`skills/dbm/SKILL.md` (Claude Code skill format, symlinkable into `~/.claude/skills/`) instructs an agent to:

1. Run `dbm create <slug> --json` and parse the output.
2. Write values to `.env.local`.
3. Push to Vercel in **two calls per variable** (production/preview default to sensitive; development cannot be combined): `vercel env add NAME production,preview --value "$V" --yes --force` then `vercel env add NAME development --value "$V" --yes --force`. `BETTER_AUTH_URL` is set for production only; previews rely on `baseURL.allowedHosts` with exact `VERCEL_URL` / `VERCEL_BRANCH_URL`.
4. Add `vercel.json` with `regions: ["gru1"]` unless a `vercel.ts` exists (only one config file is allowed; then add `regions` there).
5. Copy the templates, install pinned deps (`next` 16.3.x, `better-auth` ^1.7.6, `drizzle-orm` ^0.45.3, `postgres` ^3.4.9, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` ^3.1144, dev `drizzle-kit` ^0.31.11, `auth` ^1.7.6), run `npx auth@latest generate --config lib/auth.ts --output lib/auth-schema.ts -y` then `drizzle-kit push` using `DATABASE_URL_SESSION`.

`templates/nextjs/`:

| File | Content (from research, verbatim in the repo) |
|---|---|
| `lib/db.ts` | postgres.js with `ssl: process.env.DATABASE_SSL_CA ? { ca } : "verify-full"`, `max: 10`, `idle_timeout: 5`, `connect_timeout: 10`, `max_lifetime: 1800`, `prepare: true`; Drizzle `drizzle({ client, schema })` |
| `lib/schema.ts` | empty Drizzle schema module for app tables |
| `drizzle.config.ts` | `dbCredentials.url = DATABASE_URL_SESSION ?? DATABASE_URL`, schema `["./lib/schema.ts", "./lib/auth-schema.ts"]` |
| `lib/auth.ts` | better-auth 1.7: explicit `baseURL` or `{ allowedHosts: [VERCEL_URL, VERCEL_BRANCH_URL], protocol: "https" }`, Drizzle adapter `provider: "pg"`, `emailAndPassword.enabled`, `session.cookieCache`, `rateLimit.storage: "database"` with custom rules, `advanced.useSecureCookies: true`, `advanced.database.generateId: "uuid"`, `plugins: [nextCookies()]` last |
| `lib/auth-client.ts` | `createAuthClient()` from `better-auth/react` |
| `app/api/auth/[...all]/route.ts` | `export const { GET, POST } = toNextJsHandler(auth)` |
| `lib/s3.ts` | `S3Client` with `forcePathStyle: true`, `region: "garage"`, checksum options `WHEN_REQUIRED`, `getPresignedUploadUrl(key, contentType)`, `getPresignedDownloadUrl`, `deleteObject`, `publicUrl(key)` using `S3_PUBLIC_BASE_URL` |
| `vercel.json` | `{"$schema":"https://openapi.vercel.sh/vercel.json","regions":["gru1"]}` |
| `.env.example` | all variable names with comments |

Templates are plain files copied verbatim; no templating engine. Biome excludes `templates/nextjs`.

## 6. Naming conventions

Input slug: `^[a-z][a-z0-9-]{1,30}$`. `slug_db` = slug with `-` replaced by `_`.

| Thing | Name |
|---|---|
| Dokploy Postgres service `name` | `pg-<slug>` (requested `appName` `pg-<slug>`; actual `appName` returned by Dokploy is `pg-<slug>-<6 chars>` and is the only value `dbm` uses afterwards) |
| Database | `<slug_db>` |
| App role | `<slug_db>_app` |
| Superuser role | `<slug_db>_admin` |
| PgBouncer entries | `<slug>` (transaction) and `<slug>_session` (session) — these are the `dbname` in connection strings |
| Garage bucket alias | `<slug>` (bucket `id` stored in state) |
| Garage key name | `<slug>-key` |
| Public web host | `<slug>.web.<domain>` |
| Dokploy backup prefix | `db/<slug>` → objects at `<appName>/db/<slug>/` |
| Storage mirror prefix | `storage/<slug>/` |
| Shared containers | `dbm-pgbouncer`, `dbm-certs-dumper`, `dbm-garage` (storage sync is a host cron, not a container) |
| Traefik dynamic files | `/etc/dokploy/traefik/dynamic/dbm-s3.yml`, `dbm-db-cert.yml`, `dbm-web-<slug>.yml` |

Reserved slugs: `dbm`, `pgbouncer`, `garage`, `postgres`, `admin`, `template0`, `template1`, `session`.

## 7. Command reference

All commands accept `--json` and `--yes`. Destructive commands require `--confirm <slug>` when `--yes` is used, otherwise they prompt for the slug.

### `dbm init <ssh-host> --domain <domain> [--tls letsencrypt|self-ca] [--tailscale-auth-key <key>] [--timezone America/Argentina/Buenos_Aires]`

One-time VPS bootstrap. Checkpointed in `~/.dbm/init-progress.json`; re-running resumes. Prompts for anything not passed as a flag (B2 credentials for both buckets, Dokploy API key when reached).

Prerequisites the README lists: Ubuntu 24.04 VPS with root SSH key access; DNS records `db.`, `s3.`, `*.web.` pointing at it (Traefik cannot issue a certificate before DNS resolves); Tailscale with MagicDNS and HTTPS certificates enabled plus a **non-ephemeral, single-use, pre-approved** auth key; two B2 buckets configured as in Section 5.5 with one bucket-scoped Read/Write key each.

Steps:

1. **Harden host** with the rendered bash script (`core/harden.ts`, from `research/vps-hardening-tailscale-backups.md`): refuses if `/root/.ssh/authorized_keys` is empty; removes `/etc/ssh/sshd_config.d/50-cloud-init.conf` and writes `00-dbm.conf` (`PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password`), validates with `sshd -t`; `unattended-upgrades` security-only with reboot at 04:30 local; `timedatectl set-timezone`; **writes `/etc/docker/daemon.json` log rotation before Docker exists**; ufw default deny with 22/tcp, 41641/udp, `in on tailscale0`; the `DOCKER-USER` block in `/etc/ufw/after.rules` allowing original destination ports 80/tcp, 443/tcp, 443/udp, 6432/tcp and dropping everything else DNAT'ed to containers (including 3000); `fail2ban` sshd jail with the Tailscale CGNAT range ignored.
2. **Tailscale**: pinned apt repo install, `tailscale up --auth-key=... --hostname=<name>` if not running, `tailscale serve --bg --https=443 http://127.0.0.1:3000`. Records the `https://<host>.<tailnet>.ts.net` URL.
3. **Dokploy**: `curl -sSL https://dokploy.com/install.sh | sh` if not installed. Verifies version >= 0.30.0.
4. **API key**: prints the tailnet URL, waits for the operator to create the admin account and paste an API key (rate limit off). Calls `GET /api/user.get` for `organizationId`, mints the `dbm` key with `rateLimitEnabled:false`, stores it, and tells the operator they may revoke the pasted one.
5. **Dokploy project** `dbm`; stores `projectId` and `environmentId`.
6. **Garage**: compose service `dbm-garage` (image, volumes, `garage.toml`, env secrets, admin port on `127.0.0.1:3903`), deploy, wait for `GET /health` 200 over SSH, create scoped admin token and the `dbm-backup` key. Write Traefik file `dbm-s3.yml` routing `s3.<domain>` → `http://dbm-garage:3900` with `letsencrypt`.
7. **PgBouncer + certs-dumper**: write `dbm-db-cert.yml` (router for `db.<domain>` to a no-op service so the certificate is issued), wait for the cert to appear in `acme.json` (poll `openssl s_client` from the VPS, timeout 5 min), deploy compose `dbm-pgbouncer` (PgBouncer + dumper with `/etc/dokploy/traefik/dynamic` mounted read-only, shared `certs` volume, config bind-mount `/etc/dokploy/dbm/pgbouncer/`), install the daily SIGHUP cron. With `--tls self-ca`, generate CA and server cert on the VPS instead and skip the Traefik step.
8. **Backup destinations**: `destination.create` for the dumps bucket, `destination.testConnection`; deploy compose `dbm-storage-sync` with rclone config for Garage (read-only key) and the storage bucket, cron `30 6 * * *` UTC.
9. **Smoke test**: `dbm create dbm-smoke`, connect from the operator machine to `db.<domain>:6432` with `verify-full` (`pg` client), `SELECT 1` on both `dbm-smoke` and `dbm-smoke_session`, presigned PUT and GET against `s3.<domain>` with the AWS SDK config from the template, trigger a manual backup and confirm the object appears via `backup.listBackupFiles`, then `dbm destroy dbm-smoke --purge-storage --yes --confirm dbm-smoke`.
10. Write `config.json`. Print a summary including the two things the host cannot verify itself: run `nc -zv <public-ip> 3000` from outside (must fail) and `nc -zv <public-ip> 6432` (must succeed).

### `dbm create <slug> [--memory 512m] [--pg 18|17] [--extensions pgvector,pg_trgm] [--no-storage] [--cors-origin <origin>...]`

1. Validate slug; reject if in state, reserved, or already present in Dokploy (`project.one`).
2. `postgres.create` with `name: pg-<slug>`, `appName: pg-<slug>`, `databaseName: postgres` (the maintenance database; `dbm` creates `<slug_db>` itself in step 3 so it is owned by the app role), `databaseUser: <slug_db>_admin`, `databasePassword` from `[A-Za-z0-9]{32}`, `dockerImage: postgres:<major>`. Read back `postgresId`, `appName`. `postgres.update` with `memoryLimit` in bytes. `postgres.deploy` (blocking). Poll `postgres.one` until `applicationStatus === "done"` (timeout 120s total). `SELECT 1` via `docker exec` as the superuser.
3. Compute the app role's SCRAM verifier locally; run the role/database/extension SQL; run the tuning `ALTER SYSTEM`; `postgres.deploy` again to apply `shared_buffers`; wait for `done` and `SELECT 1`.
4. Save the project to state (status `provisioning`), render `pgbouncer.ini` and `userlist.txt` from state, upload both atomically, SIGHUP `dbm-pgbouncer`, then connect **through PgBouncer from the VPS** (`docker run --rm --network dokploy-network postgres:18 psql "postgresql://<app>:<pw>@dbm-pgbouncer:6432/<slug>" -c 'select 1'`) to prove routing and SCRAM work.
5. Garage (unless `--no-storage`): create bucket, key, permissions, backup-key read, CORS.
6. `backup.create` with the UTC jittered cron, `prefix: db/<slug>`, `keepLatestCount: 35`, `enabled: true`.
7. Set status `running`, save state, print:

```
DATABASE_URL=postgresql://<slug_db>_app:<pw>@db.<domain>:6432/<slug>?sslmode=verify-full
DATABASE_URL_SESSION=postgresql://<slug_db>_app:<pw>@db.<domain>:6432/<slug>_session?sslmode=verify-full
S3_ENDPOINT=https://s3.<domain>
S3_REGION=garage
S3_BUCKET=<slug>
S3_ACCESS_KEY_ID=GK...
S3_SECRET_ACCESS_KEY=...
BETTER_AUTH_SECRET=<32 random bytes, base64url>
BETTER_AUTH_URL=            # set to the production app URL
# DATABASE_SSL_CA=...       # only with --tls self-ca
```
plus the reminder to pin Vercel functions to `gru1`. `--json` emits the same keys.

**Rollback**: any failure after step 2 undoes completed steps in reverse (delete backup schedule, delete key and bucket, remove PgBouncer entries and SIGHUP, `postgres.remove`, `docker volume rm <appName>-data`) and removes the project from state. The error names the step and includes the underlying Dokploy, SSH, or Garage message. If rollback itself fails, exit 3 with the list of leftover resources.

### `dbm list`

Table: slug, status, Postgres major, container memory (from `docker stats --no-stream` over SSH), volume size (`docker system df -v`), storage bytes and objects (`GetBucketInfo`), last backup (newest `ModTime` from `backup.listBackupFiles?destinationId=&search=<appName>/db/<slug>/`), created. `--json` for agents.

### `dbm env <slug>`

Reprints the env block from state (including `DATABASE_SSL_CA` when `tls` is `self-ca`). Superuser password is never included.

### `dbm pause <slug>` / `dbm resume <slug>`

`postgres.stop` / `postgres.start`, and `backup.update {enabled:false|true}` (Dokploy requires all fields on update; `dbm` resends them from state). Volume, bucket, and PgBouncer entries stay. Clients connecting to a paused project get a fast server-unreachable error from PgBouncer.

### `dbm destroy <slug> [--purge-storage]`

1. Confirm by slug.
2. `backup.manualBackupPostgres` and wait (skipped with a warning if the project is paused; resume first if a final backup is required).
3. Remove both PgBouncer entries and the userlist line; upload; SIGHUP.
4. `backup.remove`, `postgres.remove`, then `docker volume rm <appName>-data` over SSH.
5. Garage: `DeleteKey`. With `--purge-storage`: `CleanupIncompleteUploads`, delete all objects, `DeleteBucket`, and remove the `dbm-web-<slug>.yml` router if present. Without it, the bucket and its read-only backup grant remain and a reminder is printed.
6. Remove from state. Off-site dumps remain until the 30-day lifecycle rule removes them.

### `dbm backup <slug>` / `dbm restore <slug> <backup-id|latest> [--as <newslug>]`

`backup` triggers `manualBackupPostgres` and waits. `restore` lists objects under `<appName>/db/<slug>/` via `backup.listBackupFiles`, downloads the chosen one on the VPS with `rclone cat` inside a temporary `rclone/rclone` container using the destination credentials from `destination.one`, and pipes `gunzip | pg_restore -O --clean --if-exists -d <slug_db>` via `docker exec -i <appName>` as the superuser. With `--as`, runs the equivalent of `create <newslug>` first (this is the clone workflow). Restore drops and recreates the database if `--clean` fails on a fresh database; the sequence is documented in `runbook.md`.

### `dbm psql <slug> [--admin]`

Interactive `psql` in the project container over `ssh -t` as the app role (or superuser with `--admin`).

### `dbm storage public <slug> [--domain <host>] [--off]` / `dbm storage cors <slug> --origin <origin>...`

As described in Section 5.4. `public` writes and removes `dbm-web-<slug>.yml` and updates `publicBaseUrl` in state.

### `dbm import <slug> --from <postgres-url> [--schemas public] [--storage-endpoint <url> --storage-region <region> --storage-key <id> --storage-secret <secret> --storage-bucket <name>]`

Runs entirely on the VPS inside a temporary `postgres:18` container on `dokploy-network` (client tools must be >= the source major):

1. `pg_dump --schema-only --no-owner --no-privileges --no-comments --no-publications --no-subscriptions --schema=<each>` then `pg_dump --data-only --no-owner --no-privileges --schema=<each>`.
2. Restore schema with `psql -v ON_ERROR_STOP=0` as the app role, then data with `SET session_replication_role = replica` first, collecting stderr from both.
3. Print a report grouping errors: foreign keys to `auth.users`, `auth.uid()` in defaults or policies, `storage.objects` references, `extensions.*` function calls (suggest `gen_random_uuid()`), other. Each with the object name and a pointer to `docs/migration-from-supabase.md`.
4. With storage flags: `rclone sync` inside a temporary `rclone/rclone` container from the Supabase S3 endpoint (`provider=Other`, `force_path_style=true`, `--size-only`) into the Garage bucket using the project key.

Accepts Supabase's direct URL (IPv6 unless the IPv4 add-on is enabled) or the session pooler URL on port 5432; never the transaction pooler. `import` never modifies the source.

### `dbm doctor`

Checks and exit non-zero on failure: SSH reachable; Dokploy API reachable and version >= 0.30.0; PgBouncer version 1.26.x (`docker exec dbm-pgbouncer pgbouncer --version`); Postgres minor >= 18.6 / 17.11 per project; rendered PgBouncer files match the files on the VPS (drift); served certificate for `db.<domain>` verifies and has > 14 days left, and matches the dumped file; Garage `/health` 200 and `s3_region` equals `garage`; `daemon.json` log rotation in effect (`docker info --format '{{.LoggingDriver}}'`); Tailscale running and node key not expiring within 14 days; each project's `data_directory` is inside its mounted volume; last backup per project < 36h old; disk free > 15%; `unfinishedUploads` per bucket reported. Prints the two external checks (ports 3000 and 6432) the host cannot run itself.

### `dbm sync-pgbouncer`

Hidden maintenance command: re-render both PgBouncer files from state, upload, SIGHUP.

## 8. State model

`~/.dbm/state.json`, zod-validated, versioned with a migration table (`z.discriminatedUnion('version', ...)`):

```ts
type State = {
  version: 1;
  projects: Record<string, {
    slug: string;
    createdAt: string;                 // ISO
    status: "provisioning" | "running" | "paused";
    pgMajor: 17 | 18;
    dokploy: { postgresId: string; appName: string; backupId?: string };
    postgres: {
      database: string;
      appRole: string; appPassword: string; appScramVerifier: string;
      adminRole: string; adminPassword: string;
      extensions: string[];
      memoryBytes: number;
    };
    storage?: {
      bucketId: string; bucket: string;
      keyId: string; keySecret: string;
      corsOrigins: string[];
      publicBaseUrl?: string;          // set by `storage public`
      aliases: string[];               // vanity hostnames
    };
    betterAuthSecret: string;
  }>;
};
```

State is the source of truth for PgBouncer config: `core/pgbouncer.ts` renders both files purely from `State` and `Config`, so drift is detectable (`doctor`) and recoverable (`sync-pgbouncer`).

Losing `state.json` is recoverable but painful: Dokploy has the services, Postgres has the roles, Garage has the keys; only passwords need rotation. The README recommends keeping `~/.dbm/` in a password manager or encrypted backup.

## 9. Security model

**Threat model**: internet attackers scanning public ports; leaked credentials for one project; a compromised operator laptop; a dead or compromised VPS. Out of scope: hostile co-tenants.

| Surface | Control |
|---|---|
| Browser | Never holds database credentials. All data access is server-side. Removes the RLS-misconfiguration class of bugs. |
| PgBouncer :6432 (public) | TLS required, Let's Encrypt certificate, clients use `verify-full`; SCRAM-SHA-256 with default 4096 iterations both sides; 32-byte random passwords; app roles `NOSUPERUSER NOCREATEDB NOCREATEROLE`; `client_login_timeout 15`; PgBouncer >= 1.26.0. Supabase exposes its pooler publicly with SSL optional by default; this is stricter. |
| Garage :443 via Traefik (public) | Signed requests only; per-project key scoped to one bucket with read+write, no owner; buckets private unless `storage public`; admin API on loopback only; CLI uses a scoped admin token. |
| Garage web endpoint (public per bucket) | Only for buckets explicitly made public; no directory listing. |
| Postgres :5432 | Not published. Overlay network only. |
| Dokploy dashboard + API :3000 | Dropped in `DOCKER-USER` for internet-originated traffic; reachable on the tailnet only (`tailscale serve` HTTPS). 2FA enabled on the account. API key is org-wide: stored 0600, never in argv, never in the repo. |
| SSH :22 (public) | Key-only, `PermitRootLogin prohibit-password`, `MaxAuthTries 4`, `fail2ban` (1h ban, incremental). Kept public rather than tailnet-only to avoid lockout if Tailscale fails. |
| OS | Ubuntu 24.04, `unattended-upgrades` security-only with a 04:30 reboot window, ufw default deny, Docker log rotation. |
| Secrets at rest (VPS) | Dokploy DB holds service env; PgBouncer `userlist.txt` holds SCRAM verifiers, not plaintext; Garage master token only in compose env; Traefik dynamic files contain no secrets. |
| Secrets at rest (laptop) | `~/.dbm/` 0700/0600. Same model as `~/.aws/credentials`. |
| Backups | TLS in transit; SSE-B2 at rest; different provider from the VPS; bucket-scoped keys. |
| Supply chain | Every image pinned to a digest-able tag; dependencies pinned exactly; npm publish via OIDC trusted publishing with provenance, no long-lived token. |

**Residual risks, stated plainly**:

- Containers share one kernel and one Docker daemon. Acceptable because all tenants are the operator; not acceptable for hosting untrusted third parties.
- A single VPS is a single point of failure. Mitigation is backups and provider snapshots, not high availability. Reboot nights cause a ~1 minute PgBouncer outage.
- Backups are encrypted by the provider, not client-side. Client-side encryption is future work.
- No brute-force protection on 6432 beyond SCRAM and 32-byte passwords; shipping PgBouncer logs to a fail2ban jail is future work.
- The operator laptop holds every credential.

## 10. Networking, DNS, TLS

DNS A records: `db.<domain>`, `s3.<domain>`, `*.web.<domain>` → VPS IPv4. Dashboard uses the Tailscale MagicDNS name.

Public ports: 22/tcp (host, ufw), 80/tcp (ACME only; Traefik redirects), 443/tcp and 443/udp (Traefik), 6432/tcp (PgBouncer). Optional 41641/udp for Tailscale direct paths. Everything else DNAT'ed to containers is dropped in `DOCKER-USER`.

Certificates: Traefik/Let's Encrypt for `db.`, `s3.`, and each `<slug>.web.` host (HTTP-01 per hostname; wildcard DNS makes every `<slug>.web.` resolve). Auto-renewed; `dbm-certs-dumper` republishes the `db.` cert; the daily SIGHUP cron makes PgBouncer load it. `dbm doctor` warns at < 14 days.

## 11. Vercel integration

- `DATABASE_URL` uses port 6432 with `sslmode=verify-full`; postgres.js honours it as Node TLS defaults (chain and hostname verified). Template driver settings: `max: 10`, `idle_timeout: 5`, `connect_timeout: 10`, `prepare: true` (Vercel's Fluid guidance: short idle timeout, never `max: 1`). `attachDatabasePool` from `@vercel/functions` is not used because postgres.js support is unverified.
- `DATABASE_URL_SESSION` is used only by `drizzle-kit` and one-off scripts.
- `vercel.json` `{"regions": ["gru1"]}`. Buenos Aires to São Paulo is about 30 ms; the default `iad1` would add about 150 ms per query.
- Env push uses the two-call pattern (Section 5.7).

## 12. Backups and recovery scenarios

| Scenario | Recovery |
|---|---|
| Bad migration corrupted data | `dbm restore <slug> <backup-id>` (`pg_restore` of the chosen dump) |
| Accidental `destroy` | Dumps exist ≤ 30 days; `dbm restore <slug> latest --as <slug>` recreates the project; storage objects are in the storage bucket under `storage/<slug>/` |
| VPS disk dies | New VPS → `dbm init` → per project `dbm restore <slug> latest --as <slug>`; `scripts/recover-storage.sh` runs `rclone copy` from `storage/<slug>/` into each new bucket; Garage metadata is not needed because buckets and keys are recreated by `create` |
| Garage LMDB corruption (single node) | Stop `dbm-garage`, restore the newest snapshot from the `snapshots` volume (or from `garage-meta/` off-site) per Garage's recovery doc, start; documented in `runbook.md` |
| Laptop lost | Restore `~/.dbm/` from operator backup; or rotate: new SSH key via provider console, new Dokploy API key from the UI, new Garage scoped token, reset app passwords via `dbm psql --admin` (a `dbm rotate` command is future work) |
| Let's Encrypt renewal fails | `dbm doctor` warns; PgBouncer serves the old cert until expiry; `verify-full` clients fail only after expiry |
| Tailscale node key expires | Dashboard and API unreachable; SSH still works; `tailscale up` again on the VPS. `dbm doctor` warns 14 days ahead; the README recommends disabling key expiry for the VPS in the admin console |

RPO is 24 hours by default. Hourly schedules are a future flag (Dokploy accepts arbitrary cron).

## 13. Migration from Supabase (operator guide, summarized)

1. `dbm create <slug>`.
2. `dbm import <slug> --from <supabase-direct-or-session-pooler-url> --storage-endpoint https://<ref>.storage.supabase.co/storage/v1/s3 --storage-region <region> --storage-key ... --storage-secret ... --storage-bucket <bucket>`.
3. Read the import report and fix in code and schema:
   - Replace `supabase-js` queries with Drizzle in server code; client components call server actions or route handlers.
   - Drop FKs to `auth.users(id)`; add FKs to better-auth's `user(id)`. With `generateId: "uuid"` the types match.
   - Remove RLS policies and `auth.uid()` defaults; authorization lives in server code with the better-auth session.
   - Replace Supabase Storage calls with presigned URLs from `lib/s3.ts`; public assets use `S3_PUBLIC_BASE_URL`.
4. **Users**, two documented options:
   - *Re-register*: simplest; notify users.
   - *Preserve accounts*: export `auth.users` (`id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at`) to CSV; run `scripts/migrate-supabase-users.ts` (inserts `user` rows keeping the Supabase uuid and `account` rows with `providerId: "credential"`, `accountId = user.id`, the bcrypt hash untouched). Add to `lib/auth.ts`: `emailAndPassword.password.verify` that uses `bcryptjs.compare` when the stored hash matches `^\$2[aby]\$` and better-auth's scrypt `verifyPassword` otherwise, plus a `hooks.after` on `/sign-in/email` that calls `ctx.context.internalAdapter.updatePassword(userId, await ctx.context.password.hash(password))` when the stored hash is still bcrypt. better-auth does not rehash on its own. Remove the hook and `bcryptjs` once `SELECT count(*) FROM account WHERE password LIKE '$2%'` is zero. This is better-auth's own documented Supabase migration shape.
5. Deploy to Vercel with the new env vars and `gru1`. Verify. Pause or delete the Supabase project.

## 14. Error handling and idempotency

- Every mutating command writes `state.json.bak.<ts>` first.
- `create` is transactional-by-rollback (Section 7). Re-running `create` on a slug in state prints its status and exits 0; on a slug present in Dokploy but not in state it refuses and points to `dbm adopt` (future work).
- `init` checkpoints after each step; re-running resumes from the first incomplete step. Every step is itself idempotent (the hardening script converges; Tailscale and Dokploy installs are skipped if present; compose services are updated, not duplicated, by looking up existing services by `appName`).
- All remote errors surface the underlying message (Dokploy JSON error body, SSH stderr, curl/Garage JSON error) prefixed with the step name.
- Timeouts: Dokploy deploy 120s, SSH command 60s (import and restore 30 min), Garage admin 15s. `DBM_TIMEOUT_MULTIPLIER` env scales them.
- `--json` output is the only thing on stdout in JSON mode.

## 15. Testing strategy

Verified tooling in `research/cli-tooling.md`.

| Vitest project | Scope | Tooling | When |
|---|---|---|---|
| `unit` (`test/unit/**`) | `core/*`: slug rules, name derivation, secrets alphabet, SCRAM verifier against a known-answer vector, memory parsing, PgBouncer and userlist rendering, env rendering, SQL builders, compose/toml/traefik/harden renderers, state schema and migration, cron jitter | Vitest 5 | every commit |
| `unit` (`test/adapters/**`) | `DokployClient` against MSW 3 fixtures recorded from a real Dokploy (`server.listen({ onUnhandledFrame: 'error' })`); `SshRunner` argv construction against a fake execa; commands against in-memory fakes of all adapters, including every rollback path | Vitest 5, MSW 3 | every commit |
| `integration` (`test/integration/**`) | Real `postgres:18`, `edoburu/pgbouncer:v1.26.0-p0`, `dxflrs/garage:v2.4.1` via `docker compose` in `test/compose/` with healthchecks, started by `globalSetup` (`up -d --wait`). Proves: role creation with a locally computed verifier and login through PgBouncer with SCRAM; transaction and session aliases route correctly; **`prepare: true` prepared statements through transaction mode**; **`drizzle-kit push` through the `_session` alias** (the assumption the no-direct-port design rests on); Garage bucket/key/CORS via admin v2; presigned PUT and GET with the template `S3Client` config; `DeleteBucket` after emptying | Vitest 5 + execa | every commit locally; CI on PRs (`ubuntu-latest` has Compose preinstalled) |
| End to end | `dbm init` on a disposable VPS through the smoke test, then create/pause/resume/backup/restore/destroy, then the external port checks | `scripts/e2e.sh` | before each tagged release |

TDD applies to `core` and `commands`. Adapters are thin and covered by the integration project. Coverage and reporters are configured at the root only (Vitest 5 rule).

## 16. Repository layout

```
db-manager/
  README.md                 architecture, quick start, prerequisites, provider trade-off
  LICENSE                   MIT
  package.json              name db-manager, bin dbm, exact pins
  bin/dbm.js                #!/usr/bin/env node; imports dist/cli.js; sets process.exitCode
  tsconfig.json  tsconfig.build.json  biome.json  vitest.config.ts  .nvmrc (22)
  src/                      (Section 5.6)
  compose/
    pgbouncer/              compose.yaml.tmpl, pgbouncer.ini rendered by dbm, Dockerfile (escape hatch)
    garage/                 compose.yaml.tmpl, garage.toml rendered by dbm
    storage-sync/           compose.yaml.tmpl, rclone.conf rendered by dbm
  templates/nextjs/         (Section 5.7)
  skills/dbm/SKILL.md
  scripts/
    e2e.sh
    migrate-supabase-users.ts
    recover-storage.sh
  test/
    unit/  adapters/  integration/  fixtures/dokploy/*.json
    compose/compose.yaml    postgres + pgbouncer + garage with healthchecks
    integration/global-setup.ts
  docs/
    superpowers/specs/  superpowers/research/  superpowers/plans/
    migration-from-supabase.md
    security.md
    runbook.md
  .github/workflows/ci.yml  release.yml   (lint+typecheck, unit on Node 22/24, integration; release-please + OIDC npm publish)
```

## 17. Decisions log

| Decision | Alternatives | Why |
|---|---|---|
| Server-only DB access, no anon key | Supabase-compatible PostgREST layer | Safer, far less to build, matches Next.js server-first patterns. Operator accepted migrating client code. |
| Dokploy as platform | Coolify; hand-rolled Docker + CLI | Dashboard with per-project metrics was a stated want; lighter than Coolify; `appName` DNS on a shared network and `keepLatestCount`. Coolify's API is comparable; this is a judgment call, not a capability gap. |
| Per-project Postgres containers | One Postgres, many databases | Per-project metrics, pause/delete granularity, independent upgrades. ~40MB RAM per idle project accepted. |
| Postgres 18 default, 17 selectable | 17 only | 18.6 is six minors in with the same security cadence; `uuidv7()`; Dokploy handles the 18 mount path since PR #3048. |
| Single shared PgBouncer, pinned 1.26.0 | Per-project PgBouncer; Supavisor | One public port, one cert, routing by db name; 1.26.0 closes an unauthenticated crash. |
| Session-mode alias per project | SSH tunnel command; publishing 5432 | Gives migrations a session connection with zero extra exposure and no tunnel plumbing. |
| SCRAM verifier computed locally | Read `pg_authid` after `CREATE ROLE` | One fewer superuser round-trip; the same string goes to both Postgres and PgBouncer by construction; verified against a real server. |
| Let's Encrypt via certs-dumper, `verify-full` | Traefik STARTTLS termination; self-signed with `sslmode=require` | Real host verification. Traefik path loses client IPs and couples the DB to Dokploy's proxy lifecycle. `sslmode=require` disables verification in postgres.js. Fallback is a private CA with `ssl: { ca }`. |
| Garage 2.4.1 for S3 | MinIO; SeaweedFS; RustFS | MinIO archived 2026-04-25; RustFS GA two weeks old; Garage small, funded, no CVEs. SeaweedFS is the fallback and would allow public-by-path. |
| Public assets via `<slug>.web.<domain>` | `s3.<domain>/<bucket>/<key>` | Garage has no anonymous S3 access and resolves web buckets by Host only. Wildcard DNS makes this one record. |
| App S3 key read+write, no owner | Owner key in the app | Bucket settings (CORS, website) are managed by `dbm`; a leaked app key cannot change them or delete the bucket. |
| Garage admin over SSH `curl` to loopback | Publishing 3903 via Traefik; `garage json-api` | No new public surface; `curl` is on every Ubuntu; token and body on stdin. `json-api` syntax was not verified. |
| Traefik file provider for `dbm` routes | Dokploy compose domains | Hot-reload without redeploying compose services; per-slug public routes without touching Garage. |
| better-auth in-app | Hosting GoTrue/Keycloak/Ory | Nothing to host; users live in the project DB; official Supabase migration guide exists. |
| Dashboard on Tailscale only, `DOCKER-USER` drop for 3000 | Public with password + 2FA; ufw only; `--publish-rm` | Dashboard is root over every project. ufw alone does not gate Docker-published ports. `--publish-rm` is the documented fallback. |
| SSH stays public (key-only, fail2ban) | Tailscale-only SSH | Lockout safety if Tailscale fails. |
| Ubuntu 24.04 only | 22.04 / 26.04 | Dokploy's tested list and an open 26.04 installer regression. |
| Two B2 buckets | One bucket with prefix rules | Dumps need delete-after-30-days; a synced mirror needs the opposite (keep versions 30 days). Separate buckets keep each rule simple and provider-enforced. |
| Backup retention via B2 lifecycle + `keepLatestCount` | `dbm` pruning | Works even if the VPS or laptop is gone; two independent layers. |
| npm name `db-manager`, bin `dbm` | `dbm` | `dbm` is taken by an active unrelated package. |
| TS 7 + Biome + plain `tsc`, no bundler | TS 5/6 + ESLint + tsup | typescript-eslint does not support TS 7; tsup is unmaintained; a CLI does not need bundling. |
| State file 0600, not encrypted | Passphrase-encrypted state | Passphrase prompt breaks the agent flow. Same model as AWS/kube CLIs. |
| Vercel `gru1` region | Default `iad1` | ~30 ms vs ~150 ms per query from Buenos Aires. |

## 18. Future work (explicitly out of version 1)

- `dbm adopt <slug>` to bring an existing Dokploy Postgres into state.
- `dbm rotate <slug>` to rotate app passwords and S3 keys with a grace window.
- Hourly backup option and client-side backup encryption.
- `dbm tunnel <slug>` (SSH-forwarded direct connection) only if the integration test shows `drizzle-kit` cannot work through the session alias.
- Multi-server support via Dokploy's remote servers.
- Brute-force protection on 6432 (ship PgBouncer logs to the host, fail2ban jail).
- Realtime (Postgres `LISTEN/NOTIFY` bridge) if a project needs it.
- Ubuntu 26.04 once Dokploy supports it.

## 19. Research basis and items to verify during implementation

Reports (all dated 2026-09-30, each with sources and an "Unverified" section):

- `docs/superpowers/research/dokploy.md`
- `docs/superpowers/research/pgbouncer-postgres-tls.md`
- `docs/superpowers/research/garage-s3.md`
- `docs/superpowers/research/app-stack-and-supabase-export.md`
- `docs/superpowers/research/vps-hardening-tailscale-backups.md`
- `docs/superpowers/research/cli-tooling.md`

Must be confirmed by the implementer, at the step named, before the corresponding code is considered done:

| Item | Where | How |
|---|---|---|
| Dokploy response field names for every endpoint `dbm` uses | Dokploy adapter task | Fetch `GET /api/settings.getOpenApiDocument` on a live instance; record real responses as the MSW fixtures |
| `postgres.update {memoryLimit:"536870912"}` yields `Resources.Limits.MemoryBytes` 536870912 | e2e | `docker service inspect <appName>` |
| Volume `<appName>-data` remains after `postgres.remove` | e2e | `docker volume ls` |
| Dokploy backup cron timezone is UTC | e2e | `docker exec <dokploy task> date` |
| B2 works as a Dokploy destination with `provider:"Other"` | init step 8 | `destination.testConnection` |
| `drizzle-kit push` through the `_session` alias, and prepared statements through transaction mode | integration test | part of the suite |
| Garage `UpdateBucket.corsRules` JSON key casing | integration test | against `dxflrs/garage:v2.4.1` |
| certs-dumper output permissions readable by uid 70 | init step 7 | smoke test connects with `verify-full` |
| Swarm host-mode traffic on 3000 is dropped by the `DOCKER-USER` rule | e2e | `nc -zv <ip> 3000` from outside must fail |
| `vercel env add NAME production,preview` in one call | skill | run once |
