# Research: PgBouncer, Postgres, TLS delivery, and the Node driver side

**For spec:** `docs/superpowers/specs/2026-09-30-db-manager-design.md` (sections 5.2, 5.3, 10, 11, 17)
**Date checked:** 2026-09-30 (all "checked" dates below are this date unless stated)

## Summary

- PgBouncer **1.26.0 (2026-09-23)** is current; it fixes three CVEs (one unauthenticated crash) and now tracks `search_path` by default. Run nothing older. `max_prepared_statements` exists (default 200) and works in transaction mode.
- `userlist.txt` SCRAM line is `"user" "SCRAM-SHA-256$<iter>:<salt>$<storedkey>:<serverkey>"`; copying `pg_authid.rolpassword` works **only if** the `[databases]` entry has no `user=`; PgBouncer then does SCRAM pass-through to Postgres. The spec's config satisfies this.
- Per-database `host=`, `port=`, and `pool_mode=` overrides are documented, so one PgBouncer can route to many containers and can also expose a **session-mode alias** for `drizzle-kit push`.
- Cert/key file contents are re-read on `RELOAD`/SIGHUP; the dumper approach is viable. `ldez/traefik-certs-dumper` is maintained (v2.11.4, 2026-06-15) and has `--version v3`.
- **TLS recommendation: keep the dumper (Let's Encrypt, `verify-full`)**, but trigger SIGHUP from a host cron rather than mounting the Docker socket in the dumper. Do **not** terminate at Traefik (loses client IP, couples the DB data path to Dokploy's Traefik restarts, driver-compat reports, recent CVE and regression). Fallback should be a **private CA pinned via `ssl: { ca }`**, not `sslmode=require`, because postgres.js maps `'require'` to `rejectUnauthorized: false` (zero verification).
- **Postgres: default new projects to 18** (18.6, six minor releases in; 19 is only at beta 4). Use the Debian image, and note the PG18 volume path change (`/var/lib/postgresql`, PGDATA `/var/lib/postgresql/18/docker`), which Dokploy fixed in PR #3048 (2025-11-26).
- Image: `edoburu/pgbouncer:v1.26.0-p0` (Alpine 3.24, `USER postgres`, honours a mounted `pgbouncer.ini`). Bitnami is off the table (catalog moved to paid `bitnamisecure` / frozen `bitnamilegacy` on 2025-08-28).
- postgres.js **3.4.9**, drizzle-orm **0.45.3**, drizzle-kit **0.31.11** are current. Keep `prepare: true` (PgBouncer >= 1.21 handles it) but cover it with the integration test; Vercel guidance is idle timeout ~5 s and never `max: 1`.

## Verified facts

### PgBouncer

- Latest release is **1.26.0, 2026-09-23**. Prior: 1.25.2 (2026-05-08), 1.25.1 (2025-12-03), 1.25.0 (2025-11-09), 1.24.1 (2025-04-16). https://www.pgbouncer.org/changelog.html and https://github.com/pgbouncer/pgbouncer/releases (checked 2026-09-30).
- 1.26.0 security fixes: CVE-2026-19888 (SCRAM client-final-message without nonce crashes PgBouncer; **unauthenticated remote**), CVE-2026-6668 (packet-buffer integer overflow -> infinite loop), CVE-2026-6669 (unbounded SCRAM iteration count from a malicious server; now capped at 1,000,000). https://github.com/pgbouncer/pgbouncer/releases/tag/pgbouncer_1_26_0
- 1.26.0 behaviour changes: tracks **all parameters PostgreSQL reports by default** (notably `search_path`, `default_transaction_read_only`) in transaction mode; new `pool_idle_timeout` frees pools with no clients and no servers for N seconds (default 0 = disabled); online restart (`-R`) removed in favour of `so_reuseport` rolling restarts; new `ParameterStatus` messages `pgbouncer.version`, `pgbouncer.pool_mode`, `pgbouncer.max_prepared_statements` are sent to clients. Same URL.
- 1.25.2 fixed CVE-2026-6664..6667 (malformed SCRAM packet crash, stack overflow from long server nonce, null deref, missing authz on `KILL_CLIENT`). 1.25.1 fixed CVE-2025-12819 (arbitrary SQL via `search_path` in StartupMessage when using `auth_query`; CVSS 8.1). 1.24.1 fixed CVE-2025-2291 (`auth_query` ignored `VALID UNTIL`). https://www.pgbouncer.org/changelog.html and https://www.cvedetails.com/vulnerability-list/vendor_id-21373/product_id-64659/Pgbouncer-Pgbouncer.html
- `max_prepared_statements`: default **200**; "When this is set to a non-zero value PgBouncer tracks protocol-level named prepared statements related commands sent by the client in transaction and statement pooling mode"; it is an LRU cache per server connection. Introduced 1.21.0, enabled by default since 1.24.0. https://www.pgbouncer.org/config.html
- FAQ: SQL-level `PREPARE`/`EXECUTE`/`DEALLOCATE` are not tracked; only protocol-level Parse/Bind/Close are. JDBC needs `prepareThreshold=0`; PHP/PDO needs `ATTR_EMULATE_PREPARES`. https://www.pgbouncer.org/faq.html
- `auth_type = scram-sha-256`: "Use password check with SCRAM-SHA-256. `auth_file` has to contain SCRAM secrets or plain-text passwords." https://www.pgbouncer.org/config.html
- Auth file format (verbatim): at least two double-quoted fields per line; third form is `"username2" "SCRAM-SHA-256$<iterations>:<salt>$<storedkey>:<serverkey>"`. Constraint: "SCRAM secrets can only be used for logging into a server if the client authentication also uses SCRAM, the PgBouncer database definition does not specify a user name, and the SCRAM secrets are identical in PgBouncer and the PostgreSQL server." https://www.pgbouncer.org/config.html (section "Authentication file format")
- The same doc's `auth_query` mechanism reads exactly this value from `pg_shadow`/`pg_authid` ("The query must return two columns, the user name and the password (appropriately encrypted/hashed)"), which confirms that Postgres's stored SCRAM verifier is the format PgBouncer expects. So copying `pg_authid.rolpassword` into `userlist.txt` is the documented model. https://www.pgbouncer.org/config.html
- `[databases]` entries are `name = key=value ...` connection strings; each entry can independently set `host=` (hostname, IP, `/`-prefixed unix socket, or comma-separated list for round robin), `port=`, `dbname=`, `pool_size=`, `reserve_pool_size=`, `pool_mode=` ("Set the pool mode specific to this database"), `max_db_connections=`, `max_db_client_connections=`, `query_wait_timeout=`, `server_lifetime=`, `connect_query=`. Multi-backend routing by database name is therefore native. https://www.pgbouncer.org/config.html (section "[databases]")
- TLS reload: "If the contents of any of the cert or key files are changed without changing the actual setting filename in the config, the new file contents will be used for new connections after a RELOAD." SIGHUP == `RELOAD` ("Reload config. Same as issuing the command RELOAD on the console"); `RELOAD` also re-reads `auth_file`. Changing TLS *settings* triggers an automatic `RECONNECT`. https://www.pgbouncer.org/config.html and https://www.pgbouncer.org/usage.html
- `client_tls_sslmode` values: `disable` (default), `allow`, `prefer`, **`require`: "Client must use TLS. If not, the client connection is rejected."**, `verify-ca`/`verify-full` (require a client certificate; not what we want). `client_tls_protocols` default `secure` = tlsv1.2,tlsv1.3. `server_tls_sslmode` default `prefer`; `disable` = "Plain TCP. TLS is not even requested from the server." https://www.pgbouncer.org/config.html
- Defaults relevant to sizing: `max_client_conn` 100, `default_pool_size` 20, `reserve_pool_size` 0, `server_idle_timeout` 600, `query_wait_timeout` 120, `client_idle_timeout` 0, `server_lifetime` 3600, `client_login_timeout` 60, `server_reset_query` `DISCARD ALL` (only used in session mode unless `server_reset_query_always`), `scram_iterations` 4096, `ignore_startup_parameters` empty. https://www.pgbouncer.org/config.html
- `PAUSE <db>` / `KILL <db>` target a single database, so per-project maintenance is possible without touching other projects. https://www.pgbouncer.org/usage.html
- PgBouncer does **not** support PROXY protocol (issue #241 open since 2017): anything that terminates TCP in front of it hides the real client IP from `SHOW CLIENTS` and logs. https://github.com/pgbouncer/pgbouncer/issues/241

### Docker images

- **`edoburu/pgbouncer`**: GitHub tag `v1.26.0-p0` created **2026-09-30** ("Bump pgbouncer to v1.26.0 (#136)", "Use Alpine 3.24"); previous tags `v1.25.2-p0` (2026-06-10), `v1.25.1-p0` (2025-12-20), `v1.24.1-p1` (2025-05-30). Dockerfile: `alpine:3.24`, `ARG VERSION=1.26.0`, downloads the upstream tarball from `pgbouncer.github.io/downloads` (no checksum verification), `USER postgres`, `ENTRYPOINT /entrypoint.sh`, `CMD pgbouncer /etc/pgbouncer/pgbouncer.ini`. Entrypoint only generates config `if [ ! -f "${PG_CONFIG_FILE}" ]`, so a bind-mounted `/etc/pgbouncer/pgbouncer.ini` and `/etc/pgbouncer/userlist.txt` are used verbatim. Its auto-generated userlist for `AUTH_TYPE=scram-sha-256` stores the *plaintext* password (it does not compute a SCRAM verifier), which is irrelevant when we mount our own file. Docker Hub `latest` was pushed "17 hours ago". https://github.com/edoburu/docker-pgbouncer/tags , https://github.com/edoburu/docker-pgbouncer/commits/master , https://raw.githubusercontent.com/edoburu/docker-pgbouncer/master/Dockerfile , https://raw.githubusercontent.com/edoburu/docker-pgbouncer/master/entrypoint.sh , https://hub.docker.com/r/edoburu/pgbouncer
- **`pgbouncer/pgbouncer` on Docker Hub is not the PgBouncer project's image.** Its page says "Not affiliated with the PgBouncer project", maintained by Canary9, source at gitlab.com/canary9/pgbouncer-container (GPL-3.0 build files), Alpine, runs as uid 70, rebuilt weekly, configured "entirely through environment variables" (`<SECTION>_<KEY>`), tag `1.25.2` at check time (1.26.0 not yet published). https://hub.docker.com/r/pgbouncer/pgbouncer . The PgBouncer install page lists no container image at all. https://www.pgbouncer.org/install.html
- **`ghcr.io/cloudnative-pg/pgbouncer`**: Debian slim, Apache-2.0, already at 1.26.0 (Renovate PR 2026-09-28), but "designed to be used as operands with the CloudNativePG Operator"; no documented standalone config contract. https://github.com/cloudnative-pg/pgbouncer-containers , https://github.com/cloudnative-pg/cloudnative-pg/pull/11571
- **Bitnami**: effective 2025-08-28 the free `docker.io/bitnami` catalog was reduced to "latest"-only hardened images; versioned images moved to `docker.io/bitnamilegacy` with "no further updates or support"; maintained images are the commercial `bitnamisecure` tier. https://github.com/bitnami/containers/issues/83267 , https://www.docker.com/blog/broadcoms-new-bitnami-restrictions-migrate-easily-with-docker/

### PostgreSQL

- PostgreSQL 18.0 released **2025-09-25**. Headline: async I/O (`io_method` = `worker` default, `io_uring`, `sync`), `uuidv7()`, virtual generated columns, skip scan, OAuth auth, `pg_upgrade --swap` and preserved planner stats, **data checksums on by default**, `md5` password auth deprecated, wire protocol 3.2. https://www.postgresql.org/about/news/postgresql-18-released-3142/
- Current minors: **18.6 and 17.11, both released 2026-08-13**. https://www.postgresql.org/docs/release/18.6/ , https://www.postgresql.org/docs/release/17.11/ . PostgreSQL **19 Beta 4 was announced 2026-09-24**, so 19 GA is imminent but not out. https://www.postgresql.org/docs/release/
- 18.6/17.11 fixed 15+ CVEs (e.g. CVE-2026-16239 cursor type confusion RCE 8.8, CVE-2026-14669 `to_char` overflow 8.8, CVE-2026-14672 SCRAM user-existence oracle with non-default `scram_iterations`, CVE-2026-6471 logical decoding dlopen). 18.4/17.10 fixed CVE-2026-6479 (SSL/GSS init DoS via recursion, 7.5) and CVE-2026-6478 (MD5 timing channel). Two 18-only CVEs exist (CVE-2026-16238 `pg_restore_attribute_stats`, CVE-2026-14676 `pg_stat_statements` overflow), both fixed in 18.6. https://www.postgresql.org/support/security/
- 18.6 requires no dump/restore; it adds `output_plugin_libraries` (only matters for custom logical-decoding plugins) and recommends reindexing some `btree_gist`/`ltree`/GIN indexes. https://www.postgresql.org/docs/release/18.6/
- Docker image: "the `PGDATA` environment variable of the image was changed to be version specific in PostgreSQL 18 and above" -> PGDATA `/var/lib/postgresql/18/docker`, and volumes should be mounted at **`/var/lib/postgresql`** (not `/var/lib/postgresql/data`) for 18+; 17 and earlier keep `/var/lib/postgresql/data`. `latest` = 18.6; Debian (trixie/bookworm) and Alpine variants for 14-18. Alpine 15+ supports ICU locales. https://hub.docker.com/_/postgres
- Dokploy hit exactly this: issue #3017 "Postgres 18 needs new pgdata path" (opened 2025-11-15 on v0.25.6); fixed by PR #3048 (merged 2025-11-26 to `canary`), which parses the image tag and picks the versioned mount path for 18+. https://github.com/Dokploy/dokploy/issues/3017 , https://github.com/Dokploy/dokploy/pull/3048
- Memory guidance: `shared_buffers` default 128 MB, "25% of system RAM" for >=1 GB systems, closer to 15% on small systems; `work_mem` default 4 MB, multiplied by `hash_mem_multiplier` (2.0) and by concurrent sorts; `maintenance_work_mem` default 64 MB; `effective_cache_size` 1/2 to 3/4 of memory; `io_workers` default 3 (PG18). https://www.postgresql.org/docs/18/runtime-config-resource.html , https://wiki.postgresql.org/wiki/Tuning_Your_PostgreSQL_Server

### TLS delivery

- **`ldez/traefik-certs-dumper`**: releases v2.11.4 and v2.11.3 (2026-06-15, "fix: missing GHCR Docker image", "fix: update lego"), v2.11.2 (2026-04-16), v2.11.0 (2026-01-21, "feat: retry dump when using watch mode"). `file` subcommand: `--version` accepts `v2` or `v3`; `--watch`; `--post-hook` ("Execute a command only if changes occurs on the data source. (works only with the watch mode)"); `--domain-subdir`; `--clean` (default true); `--crt-name` default `certificate`, `--key-name` default `privatekey`, `--crt-ext` `.crt`, `--key-ext` `.key`; `--source` default `./acme.json`; `--dest` default `./dump`. Images on Docker Hub and GHCR. README's compose example for v3 is still "TODO". https://github.com/ldez/traefik-certs-dumper/releases , https://github.com/ldez/traefik-certs-dumper/blob/master/docs/traefik-certs-dumper_file.md , https://raw.githubusercontent.com/ldez/traefik-certs-dumper/master/readme.md
- **Traefik Postgres STARTTLS**: supported since **v3.0** (PR #9377): Traefik reads the first bytes, recognises the Postgres `SSLRequest`, answers it, does the TLS handshake and forwards plaintext to the service (termination) or forwards the encrypted stream (passthrough). TCP routers support `tls.certResolver`. Docs recommend `sslmode=require` on clients. https://github.com/traefik/traefik/pull/9377 , https://doc.traefik.io/traefik/reference/routing-configuration/tcp/tls/
- **CVE-2026-25949** (GHSA-89p3-4642-cr2w, CVSS 7.5): Postgres STARTTLS prelude then stall bypasses `readTimeout` and exhausts FDs; affects v3.0.0-v3.6.7 on *any* TCP entrypoint, fixed **v3.6.8**. https://github.com/traefik/traefik/security/advisories/GHSA-89p3-4642-cr2w
- Regression: Postgres STARTTLS passthrough with `HostSNI` broke in **v3.6.11** (forwards 1 byte then closes), tracked as duplicate of #12842. https://github.com/traefik/traefik/issues/12866
- Field reports: doodba maintainers found "several other PostgreSQL drivers fail to connect properly through Traefik's TCP+SNI routing" and needed a custom `tls.options` with `alpnProtocols: [postgresql, ...]`; a Traefik forum thread needed `alpnProtocols: []` to clear "tlsv1 alert no application protocol". https://github.com/Tecnativa/doodba/discussions/684 , https://community.traefik.io/t/expose-postgres-using-traefik-v3/20486
- Dokploy pins Traefik **v3.6.25 since v0.30.x** (v0.29.13 pinned 3.6.7, which is vulnerable to CVE-2026-25949), but issue #5221 (2026-08-29) shows upgrading Dokploy does **not** recreate the `dokploy-traefik` container; the workaround is re-saving Traefik settings, which recreates the container (and would drop any DB connections routed through it). https://github.com/Dokploy/dokploy/issues/5221
- Dokploy exposes "Web Server > Traefik > Additional Port Mappings" to publish extra ports and lets you edit `/etc/dokploy/traefik/traefik.yml` and `dynamic/*.yml`; issues #1987 and #5509 report bugs in that feature. https://dokploy-dokploy.mintlify.app/infrastructure/traefik , https://github.com/Dokploy/dokploy/issues/1987 , https://github.com/Dokploy/dokploy/issues/5509

### Client side

- npm registry (queried 2026-09-30): `postgres` **3.4.9** (2026-04-05); `drizzle-orm` **0.45.3** (2026-09-21) with `1.0.0-rc.5` prereleases; `drizzle-kit` **0.31.11** (2026-09-21); `@vercel/functions` 3.9.9 (2026-09-22); `pg` 8.23.1 (2026-09-30). https://registry.npmjs.org/postgres , https://registry.npmjs.org/drizzle-orm , https://registry.npmjs.org/drizzle-kit
- postgres.js `ssl` option: `false | true | 'prefer' | 'require' | 'verify-full' | tls.ConnectionOptions`. Source (`src/connection.js`): `if (ssl === 'require' || ssl === 'allow' || ssl === 'prefer') options.rejectUnauthorized = false; else if (typeof ssl === 'object') Object.assign(options, ssl)`; `servername: net.isIP(socket.host) ? undefined : socket.host`. So **`'require'` disables all certificate verification**, while `'verify-full'` falls through with Node defaults (`rejectUnauthorized: true` + hostname check via `servername`). https://raw.githubusercontent.com/porsager/postgres/master/src/connection.js , https://github.com/porsager/postgres
- URL parsing (`src/index.js`): `query.sslmode && (query.ssl = query.sslmode, ...)` so `?sslmode=verify-full` == `ssl: 'verify-full'`; `sslrootcert=system` forces `verify-full`; there is no handling of `sslrootcert=<file>` (a private CA must be passed as `ssl: { ca }`). Defaults: `max: 10`, `idle_timeout: null`, `connect_timeout: 30`, `prepare: true`, `max_lifetime` random 30-60 min. Startup params sent: `user`, `database`, `client_encoding: 'UTF8'` plus `options.connection`. Same sources.
- README: `prepare: false` is "useful when using PgBouncer in transaction mode", with the note that PgBouncer >= 1.21.0 supports protocol-level prepared statements when configured. https://github.com/porsager/postgres
- Drizzle's Supabase guide: with the transaction pooler set `prepare: false` ("Disable prefetch as it is not supported for 'Transaction' pool mode"); pooler for serverless, direct for long-running. Supabase's own docs: transaction mode "does not support prepared statements", disable per driver (`prepare: false` for Postgres.js/Drizzle), and use the **direct connection for migrations** because they are "single sessions and Postgres native commands". https://orm.drizzle.team/docs/connect-supabase , https://supabase.com/docs/guides/database/connecting-to-postgres
- drizzle-kit "does not come with a pre-bundled database driver, it will automatically pick an available database driver from your current project based on the dialect"; `dbCredentials.url` or discrete fields. No pooler guidance on the push page. https://orm.drizzle.team/docs/drizzle-kit-push
- Vercel Fluid guidance: create the pool in module scope; call `attachDatabasePool(pool)` from `@vercel/functions` so idle clients are released before suspension; "Use a relatively short idle timeout (e.g., 5 seconds)"; "Avoid max pool size of 1: This does not reduce total connections and harms concurrency"; Fluid does not change steady-state connection count (1,000 concurrent requests still need 1,000 pool clients). `attachDatabasePool` lists pg, mysql2, mariadb, mongodb, ioredis, cassandra "and other compatible pool types" (postgres.js not listed). https://vercel.com/kb/guide/connection-pooling-with-functions , https://vercel.com/blog/the-real-serverless-compute-to-database-connection-problem-solved , https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package

### Security posture comparison

- Supabase exposes Postgres direct/session (5432) and the transaction pooler (6543) on the public internet with password auth; SSL is **not enforced by default** ("Set SSL to `require` so the driver refuses to connect without encryption"; enforcement is an opt-in setting). Our design (TLS mandatory at PgBouncer, `verify-full`, SCRAM, `NOSUPERUSER` roles) is stricter than Supabase's default. https://supabase.com/docs/guides/database/connecting-to-postgres , https://supabase.com/features/ssl-enforcement

## Recommended pgbouncer.ini

Rendered by `core/pgbouncer.ts`. Comments explain choices; strip them if the renderer prefers.

```ini
;; Generated by dbm. Do not edit by hand; run `dbm sync-pgbouncer`.
;; Target: PgBouncer 1.26.x (edoburu/pgbouncer:v1.26.0-p0)

[databases]
; One line per project. No user=/password= here: with auth_type=scram-sha-256
; and identical SCRAM verifiers in userlist.txt and pg_authid, PgBouncer does
; SCRAM pass-through to the backend (config.html, "Authentication file format").
projecta         = host=<pg-projecta appName> port=5432 dbname=projecta
; Session-mode alias for migrations / drizzle-kit push / psql. Same TLS
; endpoint, same credentials, tiny pool. Not printed in DATABASE_URL.
projecta_session = host=<pg-projecta appName> port=5432 dbname=projecta pool_mode=session pool_size=3 reserve_pool_size=0

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
unix_socket_dir =                       ; no unix socket in the container

;; Pooling
pool_mode = transaction
max_client_conn = 1000                  ; headroom for many Vercel instances; each client is cheap
default_pool_size = 10                  ; per (db,user) pair; Postgres max_connections=50 leaves room for admin
min_pool_size = 0
reserve_pool_size = 5
reserve_pool_timeout = 3
server_idle_timeout = 300               ; free backend conns 5 min after burst
server_lifetime = 3600
pool_idle_timeout = 3600                ; 1.26+: drop whole pools for idle projects
client_idle_timeout = 0                 ; let the driver's idle_timeout decide
query_wait_timeout = 30                 ; fail fast instead of piling up behind a saturated pool (Vercel functions time out anyway)
client_login_timeout = 15               ; limit half-open public connections
max_prepared_statements = 200           ; protocol-level prepared statements in transaction mode (>= 1.21)
ignore_startup_parameters = extra_float_digits   ; JDBC/psql tooling; postgres.js sends only user/database/client_encoding
; 1.26 tracks all GUC_REPORT params (search_path, default_transaction_read_only, ...) by default; nothing to add.

;; Authentication
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
; admin_users / stats_users intentionally empty: operate via `docker kill -s HUP`.

;; TLS to clients (public side)
client_tls_sslmode = require            ; plaintext clients are rejected
client_tls_cert_file = /certs/db.example.com/certificate.crt
client_tls_key_file  = /certs/db.example.com/privatekey.key
client_tls_protocols = tlsv1.2,tlsv1.3  ; same as the 'secure' default, spelled out
client_tls_ciphers = default

;; TLS to servers (docker network on one host)
server_tls_sslmode = disable

;; Ops
so_reuseport = 1                        ; enables rolling restart if ever needed (1.26 removed -R)
tcp_keepalive = 1
log_connections = 1                     ; keep: source IPs for a future fail2ban jail
log_disconnections = 1
log_pooler_errors = 1
stats_period = 60
verbose = 0
```

`userlist.txt` (mode 0640, owner uid 70 `postgres` inside the container):

```
"projecta_app" "SCRAM-SHA-256$4096:<salt>$<storedkey>:<serverkey>"
```

`dbm` obtains the second field with `SELECT rolpassword FROM pg_authid WHERE rolname = '<slug>_app'` as the project superuser immediately after `CREATE ROLE ... PASSWORD '...'`. Postgres 14+ defaults `password_encryption = scram-sha-256`, so the value already has the required prefix; `dbm` should assert it starts with `SCRAM-SHA-256$` and abort otherwise.

Reload after every change: `docker kill -s HUP <pgbouncer container>` (re-reads ini, `auth_file`, and cert/key contents).

## Recommended postgres.js config

`templates/nextjs/lib/db.ts`:

```ts
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

// DATABASE_URL=postgresql://<slug>_app:<pw>@db.example.com:6432/<slug>?sslmode=verify-full
// Public CA (Let's Encrypt): the URL alone is enough; 'verify-full' leaves Node's
// rejectUnauthorized=true and sets servername for hostname verification.
// Private-CA fallback: also set DATABASE_SSL_CA to the CA PEM and pass ssl: { ca }.
const ssl = process.env.DATABASE_SSL_CA
  ? { ca: process.env.DATABASE_SSL_CA }          // verify chain + hostname against our CA
  : ("verify-full" as const);                     // never 'require': that disables verification in postgres.js

const sql = postgres(process.env.DATABASE_URL!, {
  ssl,
  max: 10,            // Vercel: do not use 1; Fluid shares this pool across concurrent invocations
  idle_timeout: 5,    // seconds; Vercel recommends ~5 s so suspended instances do not hold PgBouncer slots
  connect_timeout: 10,
  max_lifetime: 60 * 30,
  prepare: true,      // PgBouncer >= 1.21 with max_prepared_statements handles protocol-level prepares
  connection: { application_name: process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "nextjs" },
});

export const db = drizzle(sql, { schema });
```

`drizzle.config.ts` (migrations go through the **session-mode alias**, never the transaction-mode URL):

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // DATABASE_URL_SESSION=postgresql://<slug>_app:<pw>@db.example.com:6432/<slug>_session?sslmode=verify-full
    url: process.env.DATABASE_URL_SESSION ?? process.env.DATABASE_URL!,
  },
});
```

If `drizzle-kit` picks `pg` as its driver, `sslmode=verify-full` is honoured by `pg-connection-string`; if it picks `postgres`, the same URL works as shown above.

## Unverified / uncertain

- **Whether `drizzle-kit push` works through PgBouncer *transaction* mode.** No official statement either way; Supabase and PlanetScale docs both say "direct/session connection for migrations". The session-mode alias sidesteps the question; confirm in the integration test.
- **Whether postgres.js ever emits SQL `DEALLOCATE`** (which PgBouncer does not track). Source search found no `DEALLOCATE`/`DISCARD` in `connection.js`; it appears to use protocol-level Close only. Confirm with the integration test that runs Drizzle queries through PgBouncer with `prepare: true`, including a reconnect.
- **`attachDatabasePool` with postgres.js.** Vercel lists pg/mysql2/mariadb/mongodb/ioredis/cassandra and "other compatible pool types"; postgres.js's `sql` object is not a `pg.Pool`. Rely on `idle_timeout: 5` instead until verified.
- **File ownership/permissions of dumper output.** The dumper runs as root; PgBouncer in the edoburu image runs as uid 70 and needs to read `privatekey.key`. Not verified what mode the dumper writes. Mitigation: `--post-hook 'chown -R 70:70 /certs && chmod 600 /certs/*/privatekey.key'` (runs inside the dumper container as root) and a `dbm init` smoke test.
- **Location of Dokploy's `acme.json`.** Assumed under `/etc/dokploy/traefik/`; `dbm init` should read `certificatesResolvers.<name>.acme.storage` from `/etc/dokploy/traefik/traefik.yml` instead of hardcoding.
- **Exact Dokploy release containing PR #3048** (PG18 mount path). Merged to `canary` 2025-11-26; every current release should include it, but `dbm init` should assert a minimum Dokploy version (at least v0.30.x, which also pins Traefik 3.6.25).
- **Traefik termination mode and the 3.6.11 passthrough regression.** The regression was reported against passthrough only; termination was not tested in that issue.
- **Postgres memory numbers for 512 MB** are derived from documented defaults and percentages, not from a benchmark of this workload.
- `pgbouncer/pgbouncer` (Canary9) GitLab README could not be fetched (403); env-var-only configuration is from the Docker Hub page.

## Recommended spec deviations

1. **5.3 image tag:** use `edoburu/pgbouncer:v1.26.0-p0` (pinned, not `latest`). Reason: 1.26.0 closes an unauthenticated remote crash (CVE-2026-19888); edoburu tracks upstream within days-to-weeks, is Alpine, runs as `postgres`, and honours a mounted `pgbouncer.ini`. Keep a `compose/pgbouncer/Dockerfile` that builds from the upstream tarball as an escape hatch if edoburu lags a security release. Record that `pgbouncer/pgbouncer` on Docker Hub is third-party (Canary9), not official.
2. **5.3 pgbouncer.ini:** adopt the file above. Notable deltas from the spec draft: `default_pool_size 10` (50 backend `max_connections` minus admin/psql/backups headroom, and two pools per project once the session alias exists), `pool_idle_timeout 3600`, `query_wait_timeout 30`, `client_login_timeout 15`, `ignore_startup_parameters = extra_float_digits`, `so_reuseport 1`, explicit `client_tls_protocols`.
3. **New: session-mode alias `<slug>_session`** in `[databases]` (`pool_mode=session pool_size=3`). Printed by `dbm env --with-session` / `--json` as `DATABASE_URL_SESSION`; `drizzle.config.ts` template uses it. This gives the Supabase-style "port 5432 session pooler" experience without a tunnel and keeps 5432 unexposed. `dbm psql` stays as the docker-exec path.
4. **5.3 / 17 TLS delivery:** keep Let's Encrypt via `traefik-certs-dumper` (`file --version v3 --watch --domain-subdir --source <acme.json> --dest /certs`). **Do not mount the Docker socket into the dumper** to SIGHUP PgBouncer; instead `dbm init` installs a host cron (`docker kill -s HUP <pgbouncer>` daily at 04:10; RELOAD is non-disruptive) and `dbm doctor` compares the served certificate's `notAfter` with the file on disk. Use `--post-hook` only for `chown/chmod` of the dumped key. Fallback order: (a) **private CA generated by `dbm init`, 10-year server cert for `db.example.com`, CA PEM distributed as `DATABASE_SSL_CA`** and `ssl: { ca }` in the template (still full chain + hostname verification); (b) only as last resort `sslmode=require`, and document that with postgres.js this means **no certificate verification at all**. Reject Traefik STARTTLS termination: PgBouncer would lose client IPs (no PROXY protocol), DB traffic would ride Dokploy's Traefik container which is recreated when Traefik settings are saved (#5221), STARTTLS has had one CVE and one regression in 2026, and driver compatibility reports are mixed.
5. **5.2 Postgres version:** default to **`postgres:18`** (Debian). PG 18.6 is the sixth minor, has the same security cadence as 17.11, and `uuidv7()` is useful for better-auth/Drizzle IDs. Make the major version a `dbm create --pg 17|18` flag with 18 default; do not offer 19 until 19.1. Because of the PG18 volume layout change, `dbm` must (a) assert Dokploy >= v0.30 and (b) in `dbm doctor`, verify the container's `PGDATA` is under the mounted volume (`docker inspect` mounts vs `SHOW data_directory`), since a wrong mount silently loses data on recreate. For `dbm import`'s temporary container use `postgres:18` too (client tools must be >= the source major).
6. **5.2 container settings for 512 MB:** `max_connections=50`, `shared_buffers=128MB`, `effective_cache_size=384MB`, `work_mem=4MB` (default; 25 pooled backends x 4 MB x 2 hash multiplier worst case ~200 MB), `maintenance_work_mem=64MB`, `wal_buffers=-1` (auto 4 MB), `random_page_cost=1.1` (SSD), `io_workers=3` (default), `huge_pages=off` (avoid failed `try` noise in containers). Apply with `ALTER SYSTEM` from `PostgresAdmin` after first healthy start, then restart the service via Dokploy (`shared_buffers` needs a restart). This keeps settings inside the volume and independent of how Dokploy passes `command` args. Bump proportionally when `--memory` is larger (`shared_buffers` 25%, `effective_cache_size` 75%).
7. **11 Vercel template:** `max: 10`, `idle_timeout: 5`, `connect_timeout: 10`, `prepare: true`, `ssl: 'verify-full'` (or `{ ca }`); drop `idle_timeout: 20`. Note that `max_client_conn = 1000` still comfortably covers ~100 concurrent Fluid instances at `max: 10`.
8. **9 / 18 security:** state that `dbm doctor` fails if PgBouncer < 1.26.0 or Postgres < 18.6/17.11; keep `scram_iterations` at default 4096 on both sides (CVE-2026-14672 concerns non-default values); document that Supabase exposes its pooler publicly with SSL optional by default, so this design is stricter, not looser.

## Sources

- https://www.pgbouncer.org/changelog.html
- https://github.com/pgbouncer/pgbouncer/releases
- https://github.com/pgbouncer/pgbouncer/releases/tag/pgbouncer_1_26_0
- https://www.pgbouncer.org/config.html
- https://www.pgbouncer.org/usage.html
- https://www.pgbouncer.org/faq.html
- https://www.pgbouncer.org/install.html
- https://github.com/pgbouncer/pgbouncer/issues/241
- https://www.cvedetails.com/vulnerability-list/vendor_id-21373/product_id-64659/Pgbouncer-Pgbouncer.html
- https://hub.docker.com/r/edoburu/pgbouncer
- https://github.com/edoburu/docker-pgbouncer
- https://github.com/edoburu/docker-pgbouncer/tags
- https://github.com/edoburu/docker-pgbouncer/commits/master
- https://raw.githubusercontent.com/edoburu/docker-pgbouncer/master/Dockerfile
- https://raw.githubusercontent.com/edoburu/docker-pgbouncer/master/entrypoint.sh
- https://hub.docker.com/r/pgbouncer/pgbouncer
- https://github.com/cloudnative-pg/pgbouncer-containers
- https://github.com/cloudnative-pg/cloudnative-pg/pull/11571
- https://github.com/bitnami/containers/issues/83267
- https://www.docker.com/blog/broadcoms-new-bitnami-restrictions-migrate-easily-with-docker/
- https://www.postgresql.org/about/news/postgresql-18-released-3142/
- https://www.postgresql.org/docs/release/
- https://www.postgresql.org/docs/release/18.6/
- https://www.postgresql.org/docs/release/17.11/
- https://www.postgresql.org/support/security/
- https://www.postgresql.org/docs/18/runtime-config-resource.html
- https://wiki.postgresql.org/wiki/Tuning_Your_PostgreSQL_Server
- https://hub.docker.com/_/postgres
- https://github.com/Dokploy/dokploy/issues/3017
- https://github.com/Dokploy/dokploy/pull/3048
- https://github.com/Dokploy/dokploy/issues/5221
- https://dokploy-dokploy.mintlify.app/infrastructure/traefik
- https://github.com/Dokploy/dokploy/issues/1987
- https://github.com/Dokploy/dokploy/issues/5509
- https://github.com/ldez/traefik-certs-dumper
- https://github.com/ldez/traefik-certs-dumper/releases
- https://github.com/ldez/traefik-certs-dumper/blob/master/docs/traefik-certs-dumper_file.md
- https://raw.githubusercontent.com/ldez/traefik-certs-dumper/master/readme.md
- https://doc.traefik.io/traefik/reference/routing-configuration/tcp/tls/
- https://github.com/traefik/traefik/pull/9377
- https://github.com/traefik/traefik/security/advisories/GHSA-89p3-4642-cr2w
- https://github.com/traefik/traefik/issues/12866
- https://github.com/Tecnativa/doodba/discussions/684
- https://community.traefik.io/t/expose-postgres-using-traefik-v3/20486
- https://blog.hoaraujerome.com/why-you-cant-terminate-tls-at-traefik-for-postgresql-and-what-to-do-instead (title/summary via search only; page returned 404 on fetch)
- https://github.com/porsager/postgres
- https://raw.githubusercontent.com/porsager/postgres/master/src/connection.js
- https://raw.githubusercontent.com/porsager/postgres/master/src/index.js
- https://registry.npmjs.org/postgres
- https://registry.npmjs.org/drizzle-orm
- https://registry.npmjs.org/drizzle-kit
- https://registry.npmjs.org/@vercel/functions
- https://orm.drizzle.team/docs/drizzle-kit-push
- https://orm.drizzle.team/docs/connect-supabase
- https://supabase.com/docs/guides/database/connecting-to-postgres
- https://supabase.com/features/ssl-enforcement
- https://vercel.com/kb/guide/connection-pooling-with-functions
- https://vercel.com/blog/the-real-serverless-compute-to-database-connection-problem-solved
- https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package
- https://github.com/orgs/supabase/discussions/40671
