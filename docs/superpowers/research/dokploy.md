# Dokploy research for `dbm`

Date checked: 2026-09-30. Scope: Dokploy as the platform layer for the design in
`docs/superpowers/specs/2026-09-30-db-manager-design.md` (sections 5.1, 5.2, 5.5, 7, 17).
Source code references are to the `canary` branch of https://github.com/Dokploy/dokploy
as of 2026-09-30; the shipped `openapi.json` in the repo root was used for the REST surface.

## Summary

- Latest stable is **v0.30.8 (2026-09-29)**; patch releases land every 1-2 weeks, minors every ~4 months (v0.29.0 Apr 17, v0.30.0 Aug 14).
- REST API is tRPC-over-OpenAPI: `http(s)://host:3000/api/<router>.<procedure>`, header `x-api-key`, 554 paths; live spec at `GET /api/settings.getOpenApiDocument`, UI at `/swagger` (admin login required).
- Every operation `dbm` needs exists: `project.create`, `postgres.create/deploy/start/stop/remove/update`, `compose.create/update/deploy/stop/start/delete`, `domain.create`, `destination.create/testConnection`, `backup.create/update/remove/manualBackupPostgres/listBackupFiles`.
- `postgres.deploy` is **synchronous** (pulls image, creates Swarm service, waits up to 45 s for convergence) and `postgres.remove` **does not delete the data volume** `<appName>-data`.
- Postgres runs as a Docker **Swarm service** named `appName` on `dokploy-network`, DNS-reachable as `appName:5432`; default image is now `postgres:18`, no published port unless `externalPort` is set.
- Backups are `pg_dump -Fc --no-acl --no-owner | gzip` streamed via `rclone rcat` to `s3://bucket/<appName>/<prefix>/<ISO-timestamp>.sql.gz`; retention via `keepLatestCount`; cron via node-schedule in the container's TZ (UTC); no per-schedule timezone.
- Three spec-breaking gotchas: `memoryLimit` must be a **byte count string**, `databasePassword` **forbids** `$ ! ' " \ /` and spaces, and API keys created through the API inherit better-auth's **10 requests / 24 h** rate limit unless `rateLimitEnabled:false`.
- Dashboard port 3000 is published in Swarm `mode=host` on all interfaces; Docker bypasses ufw, so the spec's "firewall 3000 with ufw" is not sufficient by itself.
- 44 security advisories published in 2026 (most fixed by v0.29.13); the API is not scoped per project — a key is a full-organization credential.
- Coolify's API covers the same operations with a richer Postgres create body but uses a very different resource model; Dokploy remains a reasonable choice, with the deviations below.

## Verified facts

### Release, install, host

- Latest release v0.30.8 published 2026-09-29; preceding tags v0.30.7 (09-18), v0.30.6 (09-08), v0.30.5 (09-02), v0.30.4 (09-01), v0.30.3 (08-30), v0.30.2/0.30.1 (08-18), v0.30.0 (08-14), v0.29.14 (08-06), v0.29.13 (07-21), v0.29.12 (07-13). No prerelease flags on these tags. https://api.github.com/repos/Dokploy/dokploy/releases (checked 2026-09-30)
- Install command: `curl -sSL https://dokploy.com/install.sh | sh`; update: `curl -sSL https://dokploy.com/install.sh | sh -s update`. Minimum "at least 2GB of RAM" and "30GB of disk space"; Ubuntu 18.04-24.04 supported. Ports 80/443 (Traefik) and 3000 (UI). Env knobs: `DOKPLOY_VERSION`, `ADVERTISE_ADDR`, `DOCKER_SWARM_INIT_ARGS`, `ENDPOINT_MODE`. https://docs.dokploy.com/docs/core/installation (2026-09-30)
- install.sh installs Docker 28.5.0, runs `docker swarm init`, creates `docker network create --driver overlay --attachable dokploy-network`, starts `dokploy-postgres` (postgres:16, password via Docker secret), starts the `dokploy` Swarm service with `--publish published=3000,target=3000,mode=host`, and runs Traefik with `docker run ... -v /etc/dokploy/traefik/traefik.yml:/etc/traefik/traefik.yml -v /etc/dokploy/traefik/dynamic:/etc/dokploy/traefik/dynamic ... traefik:v3.6.25`. The script refuses to run if 80, 443 or 3000 is already bound. https://dokploy.com/install.sh (2026-09-30)
- The dashboard publish is Swarm host-mode with no bind IP, i.e. all interfaces. There is no install-time option to bind 3000 to a specific interface. https://dokploy.com/install.sh (2026-09-30)
- Docker's own docs: "When you publish a container's ports using Docker, traffic to and from that container gets diverted before it goes through the ufw firewall settings." https://docs.docker.com/engine/network/packet-filtering-firewalls/ (2026-09-30)
- Dokploy's Tailscale guide recommends reaching the UI at `http://<tailscale-ip>:3000`, allowing `tailscale0` in ufw, and warns "Docker directly manipulates iptables, which can bypass UFW rules"; it recommends the VPS provider's firewall to block public access. It does not mention `tailscale serve`. https://docs.dokploy.com/docs/core/guides/tailscale (2026-09-30)
- Traefik version constant in code: `TRAEFIK_VERSION = process.env.TRAEFIK_VERSION || "3.6.25"`. https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/setup/traefik-setup.ts (2026-09-30)
- ACME storage path written into traefik.yml: `certificatesResolvers.letsencrypt.acme.storage: /etc/dokploy/traefik/dynamic/acme.json`, `httpChallenge.entryPoint: web`, hard-coded email `test@localhost.com`. Because `/etc/dokploy/traefik/dynamic` is bind-mounted from the host at the same path, **acme.json lives at `/etc/dokploy/traefik/dynamic/acme.json` on the host**. https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/setup/traefik-setup.ts and https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/constants/index.ts (2026-09-30)
- Traefik static config: `providers.docker.exposedByDefault=false, network: dokploy-network`, `providers.swarm.exposedByDefault=false`, `providers.file.directory=/etc/dokploy/traefik/dynamic`, `websecure` entrypoint defaults `tls.certResolver=letsencrypt`. Same file (2026-09-30)
- Docs troubleshooting: "point the domain to your server's IP before adding it in Dokploy. If the domain is added first, the certificate won't be generated". https://docs.dokploy.com/docs/core/troubleshooting/domains (2026-09-30)

### API access

- Tokens are generated in the UI at `/settings/profile`, "API/CLI Section"; header is `x-api-key: YOUR-GENERATED-API-KEY`; base URL `http://localhost:3000/api`; Swagger UI at `your-vps-ip:3000/swagger`, "By default, access to the Swagger UI is restricted, and only authenticated administrators can access". https://docs.dokploy.com/docs/api (2026-09-30)
- openapi.json: OpenAPI 3.1.0, 554 paths, single security scheme `apiKey` in header `x-api-key`, description "Generate an API key from your Dokploy dashboard under Settings > API Keys". https://github.com/Dokploy/dokploy/blob/canary/openapi.json (2026-09-30)
- The Swagger page loads the spec from the tRPC query `settings.getOpenApiDocument`; the same procedure is exposed on REST as `GET /api/settings.getOpenApiDocument`. https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/pages/swagger.tsx and openapi.json (2026-09-30)
- REST is served by `apps/dokploy/pages/api/[...trpc].ts` using `createOpenApiNextHandler` (trpc-to-openapi); it calls `validateRequest`, returns 401 `{message:"Unauthorized"}` when the key is invalid, 413 when over `OPENAPI_MAX_JSON_BODY_SIZE`. https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/pages/api/%5B...trpc%5D.ts (2026-09-30)
- `validateRequest` reads `x-api-key`, calls better-auth `verifyApiKey`, then requires `metadata.organizationId` on the key record; without it the request is treated as unauthenticated. https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/lib/auth.ts (2026-09-30)
- API keys can also be created over REST: `POST /api/user.createApiKey` with `{name (<=32 chars), prefix?, expiresIn?, metadata:{organizationId}, rateLimitEnabled?, rateLimitTimeWindow?, rateLimitMax?, remaining?, refillAmount?, refillInterval?}`; returns the key object (`id`, `key`, ...). It requires an already-authenticated caller, so the first key must come from the UI. https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/server/api/routers/user.ts and https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/lib/api-keys.ts (2026-09-30)
- Dokploy configures better-auth `apiKey({ enableMetadata: true, references: "user" })` with no rate-limit override. better-auth's plugin defaults are `rateLimit.enabled = true`, `timeWindow = 1000*60*60*24`, `maxRequests = 10`, `keyExpiration.defaultExpiresIn = null`. https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/lib/auth.ts and https://github.com/better-auth/better-auth/blob/main/packages/api-key/src/index.ts (2026-09-30)
- The dashboard's "Add API key" form defaults to `rateLimitEnabled: false`, `expiresIn: null`, so UI-created keys are unlimited and non-expiring; keys created via `user.createApiKey` without `rateLimitEnabled:false` get 10 req/day. https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/components/dashboard/settings/api/add-api-key.tsx (2026-09-30)
- Third-party confirmation of the rate-limit trap: "better-auth API keys can carry a rate limit (10 requests a day by default); a deploy makes more calls than that and gets 401 Unauthorized halfway through." https://github.com/actionplatform/apx-dokploy/issues/29 (2026-09-30)
- The `apikey` table has `permissions` and `metadata` columns but Dokploy only uses `metadata.organizationId`; there is no per-project or per-endpoint scoping in `validateRequest`. https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/db/schema/account.ts (2026-09-30)
- 2FA (TOTP via better-auth `twoFactor()` plugin, plus `passkey()`) is available; enabled from the Profile page. https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/lib/auth.ts and https://docs.dokploy.com/docs/cli/authentication (2026-09-30)
- Official CLI (`@dokploy/cli`, "449 commands auto-generated from the Dokploy OpenAPI spec") authenticates with `DOKPLOY_URL` and `DOKPLOY_API_KEY`. https://github.com/Dokploy/cli (2026-09-30)

### Projects / environments

- `project.create` body `{name, description?, env?}`; service returns `{ project: {projectId, name, organizationId, ...}, environment: {environmentId, name:"production", ...} }` because a production environment is auto-created. https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/services/project.ts and https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/server/api/routers/project.ts (2026-09-30)
- `project.all` (GET, no params) returns projects with environments and nested services; `project.one?projectId=`. `environment.byProjectId?projectId=` and `environment.create {name, projectId}` also exist. https://docs.dokploy.com/docs/api/project and openapi.json (2026-09-30)

### Postgres service

- `postgres.create` body: `name` (req), `databaseName` (req), `databaseUser` (req), `databasePassword` (req, regex-limited), `environmentId` (req), `appName?` (1-63 chars, `^[a-zA-Z0-9._-]+$`), `dockerImage?` (default `"postgres:18"`), `description?`, `serverId?`. Returns the inserted row (`postgresId`, `appName`, `databasePassword`, `applicationStatus:"idle"`, ...). https://docs.dokploy.com/docs/api/reference-postgres and https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/db/schema/postgres.ts (2026-09-30)
- Password rule: `DATABASE_PASSWORD_REGEX = /^[a-zA-Z0-9@#%^&*()_+\-=[\]{}|;:,.<>?~`]*$/`, message "avoid: $ ! ' \" \\ / and space characters". https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/db/schema/utils.ts (2026-09-30)
- appName: if you pass `appName`, Dokploy stores `<lowercased, spaces->hyphens>-<6 random chars>`; if omitted, `postgres-<verb>-<adjective>-<noun>-<nanoid>`. It must be unique server-wide (409 CONFLICT otherwise). https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/db/schema/utils.ts (`buildAppName`, `generateAppName`) and https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/services/postgres.ts (2026-09-30)
- On create, a volume mount is registered: `volumeName: "<appName>-data"`, mountPath `/var/lib/postgresql/data` for images `< postgres:18`, `/var/lib/postgresql/<N>/docker` for 18+. https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/server/api/routers/postgres.ts and `getMountPath` in services/postgres.ts (2026-09-30)
- `postgres.deploy {postgresId}` is a synchronous mutation: sets `applicationStatus:"running"`, `docker pull <image>`, creates/updates a Swarm service via `docker.createService`, then `waitForSwarmServiceConvergence` (default 45 000 ms, poll 2 000 ms) and sets `applicationStatus:"done"` or `"error"` (throws INTERNAL_SERVER_ERROR). The HTTP response body is the postgres row **fetched before deployment**, so read status with `postgres.one`. https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/services/postgres.ts and https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/docker/utils.ts (2026-09-30)
- Swarm service spec built by `buildPostgres`: `Name: appName`, `Image: dockerImage`, env `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` plus custom `env`, `Networks` = `dokploy-network` unless `detachDokployNetwork`, `EndpointSpec.Mode: "dnsrr"`, `Ports: []` unless `externalPort` (then `PublishedPort: externalPort, TargetPort: 5432, PublishMode: host`), `Command: command.split(" ")`, `Args`, `StopGracePeriod` 30 s default, `UpdateConfig: stop-first, rollback on failure`. https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/databases/postgres.ts and https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/services/network.ts (2026-09-30)
- Resource limits: `MemoryBytes: Number.parseInt(memoryLimit)`, `NanoCPUs: Number.parseInt(cpuLimit)`. Values are raw byte / nano-CPU strings; `"512m"` parses to 512 bytes. https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/docker/utils.ts (`calculateResources`) (2026-09-30)
- `postgres.update` accepts `dockerImage`, `command`, `args[]`, `env`, `memoryLimit`, `memoryReservation`, `cpuLimit`, `cpuReservation`, `externalPort`, `networkIds[]`, `detachDokployNetwork`, plus Swarm knobs; returns `true`. Changes apply on the next `postgres.deploy`. https://docs.dokploy.com/docs/api/reference-postgres (2026-09-30)
- `postgres.one?postgresId=` returns the full row including `databasePassword`, `applicationStatus`, `mounts`, `backups` (destination keys stripped). https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/server/api/routers/postgres.ts (2026-09-30)
- `postgres.remove {postgresId}` runs, in order and ignoring errors: `docker service rm <appName>`, cancel backup jobs, delete the DB row. `removeService` ignores its `_deleteVolumes` argument, so the Docker volume `<appName>-data` remains on disk. https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/server/api/routers/postgres.ts and https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/docker/utils.ts (2026-09-30)
- Internal hostname shown in the UI: "Internal Host" = `appName`, "Internal Connection URL" = `postgresql://<user>:<pass>@<appName>:5432/<db>`. https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/components/dashboard/postgres/general/show-internal-postgres-credentials.tsx (2026-09-30)
- Maintainer guidance: compose services reach a Dokploy DB by "container name or service name as host" once the compose service joins `dokploy-network` (`external: true`). https://github.com/Dokploy/dokploy/discussions/3192 (2026-09-30)
- Docs confirm the Docker image field is editable and CPU/memory are configurable under Advanced. https://docs.dokploy.com/docs/core/databases (2026-09-30)
- Logs: `postgres.readLogs` (tail/since/search) exists. https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/server/api/routers/postgres.ts (2026-09-30)

### Compose services and domains

- `compose.create {name, environmentId, composeType?: "docker-compose"|"stack", appName?, composeFile?, sourceType?: "raw"|git..., serverId?, description?}` returns the compose row (`composeId`, `appName`). `compose.update {composeId, composeFile?, env?, sourceType?, composeType?, randomize?, isolatedDeployment?}`. `compose.deploy {composeId, title?, description?, freshVolumes?}`, `compose.redeploy`, `compose.stop`, `compose.start`, `compose.delete {composeId, deleteVolumes (required)}`, `compose.one?composeId=`, `compose.saveEnvironment`. https://docs.dokploy.com/docs/api/reference-compose (2026-09-30)
- Deployment runs `docker compose -p <appName> --env-file .env -f <file> up -d --build --remove-orphans`; the `env` field is written to a `.env` next to the compose file; project/environment env is merged. https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/builders/compose.ts (2026-09-30)
- Since v0.30.0 "Every application and compose service joins the shared `dokploy-network` by default — you can detach it ... This is also why Isolated Deployment is deprecated". https://github.com/Dokploy/dokploy/releases/tag/v0.30.0 (2026-09-30)
- Docs still instruct declaring `networks: dokploy-network: external: true` and adding `dokploy-network` to each service for Traefik routing. https://docs.dokploy.com/docs/core/docker-compose/domains (2026-09-30)
- Domain labels injected into compose at deploy time: `traefik.enable=true`, `traefik.http.routers.<r>.rule=Host(...)`, `.entrypoints`, `traefik.http.services.<r>.loadbalancer.server.port=<port>`, and for `certificateType:"letsencrypt"` `traefik.http.routers.<r>.tls.certresolver=letsencrypt`; `traefik.docker.network=dokploy-network` (or `traefik.swarm.network` for stacks). https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/docker/domain.ts (2026-09-30)
- `domain.create {host (req), composeId, serviceName, port, https, certificateType: "letsencrypt"|"none"|"custom", domainType, path?, internalPath?, stripPath?, customCertResolver?, middlewares?}`; `domain.byComposeId?composeId=`, `domain.update`, `domain.delete {domainId}`, `domain.validateDomain {domain}`. https://docs.dokploy.com/docs/api/reference-domain (2026-09-30)
- Docs: for Docker Compose "you must redeploy your Docker Compose application for domain changes to take effect" (labels), whereas application domains hot-reload via file provider. https://docs.dokploy.com/docs/core/domains (2026-09-30)

### Backups

- `destination.create {name, provider (string|null), accessKey, secretAccessKey, bucket, region, endpoint, additionalFlags (string[]|null), serverId?}` returns the row with `destinationId`; `destination.testConnection` same body; `destination.all`, `destination.one`, `destination.update`, `destination.remove`. https://docs.dokploy.com/docs/api/reference-destination and https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/services/destination.ts (2026-09-30)
- rclone flags built from a destination: `--s3-provider=<provider>` (if set), `--s3-access-key-id`, `--s3-secret-access-key`, `--s3-region`, `--s3-endpoint`, `--s3-no-check-bucket`, `--s3-force-path-style`, plus `additionalFlags`. https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/backups/utils.ts (2026-09-30)
- `backup.create {schedule (cron string), prefix (>=1 char), destinationId, database, databaseType: "postgres", postgresId, enabled?, keepLatestCount?, backupType?: "database", ...}` schedules a node-schedule job and returns the backup row (`backupId`, `appName`). `backup.update` requires every field again. `backup.remove {backupId}`. `backup.one?backupId=`. https://docs.dokploy.com/docs/api/reference-backup and https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/db/schema/backups.ts (2026-09-30)
- Dump command: `pg_dump -Fc --no-acl --no-owner -h localhost -U "$DB_USER" --no-password "$DB_NAME" | gzip` executed with `docker exec` in the first running task of the Swarm service, piped to `rclone rcat ":s3:<bucket>/<appName>/<prefix>/<timestamp>.sql.gz"`. Timestamp is `new Date().toISOString()` with `:` and `.` replaced by `-`. On failure it runs `rclone deletefile` on the partial object. https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/backups/postgres.ts and utils.ts (2026-09-30)
- The object is a **gzip of a pg_dump custom-format archive** despite the `.sql.gz` extension; Dokploy's own restore uses `rclone cat ... | gunzip | pg_restore -U "$DB_USER" -d "$DB_NAME" -O --clean --if-exists`. https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/restore/utils.ts and restore/postgres.ts (2026-09-30)
- Retention: after each successful run `keepLatestNBackups` lists `*.sql.gz` under `<appName>/<prefix>/`, sorts descending, and `rclone delete`s everything past `keepLatestCount`; `0`/null keeps everything. https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/backups/index.ts (2026-09-30)
- Schedule string is passed verbatim to `node-schedule`'s `scheduleJob(backupId, schedule, ...)`; no zod validation and no timezone column in the `backup` table. The Dokploy image sets no `TZ`, so cron fires in UTC. https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/backups/utils.ts, schema/backups.ts, and https://github.com/Dokploy/dokploy/blob/canary/Dockerfile (2026-09-30)
- On-demand: `POST /api/backup.manualBackupPostgres {backupId}` runs the dump synchronously and returns `true` (a `deployment` row of type backup is created for logs). https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/server/api/routers/backup.ts (2026-09-30)
- Listing: `GET /api/backup.listBackupFiles?destinationId=&search=` returns up to 100 rclone file entries matching `search`. Restore (`backup.restoreBackupWithLogs`) is a tRPC **subscription** and is **not** in openapi.json; there is no REST restore endpoint. Same router; openapi.json (2026-09-30)
- Docs backup page describes destination, database name, cron schedule, prefix, enabled toggle and a "Test" button; restore docs say "If you previously used the backups generated by dokploy, it will automatically use the correct commands to restore your database ... Other formats are not guaranteed to work". https://docs.dokploy.com/docs/core/databases/backups and https://docs.dokploy.com/docs/core/databases/restore (2026-09-30)
- Release notes: v0.30.0 "Backups ran the database dump twice per backup and could leave partial uploads behind on failure — now runs once and cleans up after itself"; v0.28.5 "use appname on backups folder" (path layout changed then). https://github.com/Dokploy/dokploy/releases (2026-09-30)
- Backblaze B2: issue #2329 (v0.24.8, "Any other S3 compatible" option, rclone "directory not found") is still open with `needs-triage`; #2161 requested native B2 provider. Credentials-in-logs regression #5519 (v0.30.7) was closed via PR #5527 on 2026-09-24 and is not in v0.30.8's notes as of the check. https://github.com/Dokploy/dokploy/issues/2329, https://github.com/Dokploy/dokploy/issues/2161, https://github.com/Dokploy/dokploy/issues/5519 (2026-09-30)

### Monitoring

- Per-container CPU/memory/network/disk charts exist in the UI (free tier reads Docker stats live; "updates only when actively viewing"). Historical metrics require the separate monitoring agent on port 4500 with a metrics token; the docs page for it says "This is feature only available on Cloud Version of Dokploy". https://docs.dokploy.com/docs/core/databases and https://docs.dokploy.com/docs/core/monitoring (2026-09-30)
- REST endpoints present: `GET /api/user.getContainerMetrics?url=&token=&appName=&dataPoints=` (proxies to the metrics agent), `GET /api/user.getServerMetrics`, `GET /api/swarm.getContainerStats`, `GET /api/docker.getContainersByAppNameMatch?appName=`, `GET /api/docker.getServiceContainersByAppName`. openapi.json (2026-09-30)

### Security

- GitHub lists 44 published advisories; 40 were published 2026-07-21 covering versions `<= 0.29.8` (e.g. CVE-2026-72862 command injection via `dockerImage`, CVE-2026-72878 backup/restore injection, CVE-2026-72737 cross-org IDOR on destinations exposing S3 credentials, CVE-2026-72738 RCE via `backup.listBackupFiles` search, CVE-2026-72901 volume-backup RCE patched v0.29.13). Earlier 2026-05-11 batch: CVE-2026-45631 pre-auth admin takeover via hardcoded auth secret (`>=0.27.0, <=0.28.8`). https://github.com/Dokploy/dokploy/security/advisories and https://api.github.com/repos/Dokploy/dokploy/security-advisories (2026-09-30)
- 2025/early-2026 CVEs: CVE-2025-53376 (authenticated low-priv RCE), CVE-2025-53825 (preview deployment RCE), CVE-2026-24840 (hardcoded DB password in install script, fixed 0.26.6), CVE-2026-24841 (terminal WebSocket injection, fixed 0.26.6). https://github.com/Dokploy/dokploy/security/advisories/GHSA-h67g-mpq5-6ph5, https://www.strix.ai/cve/CVE-2025-53376 (2026-09-30)
- The API is served by the same Next.js process on port 3000 as the dashboard; there is no separate API port. install.sh and `pages/api/[...trpc].ts` (2026-09-30)

### Coolify cross-check

- Coolify: `Authorization: Bearer <token>`, base `/api/v1`; `POST /databases/postgresql` with `server_uuid`, `project_uuid`, `environment_name|environment_uuid`, `postgres_user/password/db`, `postgres_conf`, `image`, `limits_memory`, `limits_cpus`, `is_public`, `public_port`, `instant_deploy`; `POST /databases/{uuid}/start|stop|restart`, `DELETE /databases/{uuid}`; `POST /databases/{uuid}/backups {frequency, save_s3, s3_storage_uuid, databases_to_backup, database_backup_retention_amount_s3, database_backup_retention_days_s3, ...}`, `GET /databases/{uuid}/backups`, `GET /databases/{uuid}/backup-executions`. https://coolify.io/docs/api-reference/api/operations/list-databases, https://coolify.io/docs/api-reference/api/operations/create-database-postgresql, https://coolify.io/docs/api-reference/api/operations/create-database-backup (2026-09-30)

## Endpoint reference

Base: `https://<tailnet-host>/api` (or `http://<ip>:3000/api`). Header: `x-api-key: <key>`. GET procedures take query params; POST take JSON bodies. Every id below is a nanoid string.

| Operation (spec step) | Method + path | Required body / query | Optional | Returns (identifier) |
|---|---|---|---|---|
| Create project (init 5) | `POST /project.create` | `name` | `description`, `env` | `{project:{projectId}, environment:{environmentId}}` |
| List projects | `GET /project.all` | - | - | `[{projectId, name, environments:[{environmentId, postgres:[...], compose:[...]}]}]` |
| Get project | `GET /project.one` | `projectId` | - | project with environments and services |
| List environments | `GET /environment.byProjectId` | `projectId` | - | `[{environmentId, name}]` |
| Create Postgres (create 2) | `POST /postgres.create` | `name`, `databaseName`, `databaseUser`, `databasePassword`, `environmentId` | `appName`, `dockerImage` (default `postgres:18`), `description`, `serverId` | row: `postgresId`, `appName` (suffixed), `applicationStatus:"idle"` |
| Set limits / image / args | `POST /postgres.update` | `postgresId` | `memoryLimit` (bytes as string), `memoryReservation`, `cpuLimit` (nanoCPUs), `command`, `args[]`, `env`, `dockerImage`, `externalPort`, `detachDokployNetwork`, `networkIds[]` | `true` (effective on next deploy) |
| Deploy (create 2) | `POST /postgres.deploy` | `postgresId` | - | postgres row (pre-deploy snapshot); blocks until Swarm converges (45 s) or throws 500 |
| Status / health (create 2, list) | `GET /postgres.one` | `postgresId` | - | row incl. `applicationStatus` (`idle`/`running`/`done`/`error`), `appName`, `databasePassword`, `backups[]` |
| Container list (list) | `GET /docker.getServiceContainersByAppName` / `GET /docker.getContainersByAppNameMatch` | `appName` | `serverId`, `appType` | container list with ids/state |
| Pause / resume (pause) | `POST /postgres.stop` / `POST /postgres.start` | `postgresId` | - | postgres row |
| Remove (destroy 4) | `POST /postgres.remove` | `postgresId` | - | postgres row; runs `docker service rm`, cancels backup jobs; **volume `<appName>-data` is left behind** |
| Logs | `GET /postgres.readLogs` | `postgresId` | `tail`, `since`, `search` | text |
| Create compose (init 6, 7) | `POST /compose.create` | `name`, `environmentId` | `appName`, `composeType` (`docker-compose`), `sourceType:"raw"`, `composeFile`, `description` | row: `composeId`, `appName` |
| Set compose YAML / env | `POST /compose.update` | `composeId` | `composeFile`, `env`, `sourceType`, `composeType`, `randomize`, `isolatedDeployment` | compose row |
| Deploy compose | `POST /compose.deploy` | `composeId` | `title`, `description`, `freshVolumes` | `{message, composeId}`; poll `GET /deployment.allByCompose?composeId=` or `GET /compose.one` |
| Stop / start compose | `POST /compose.stop` / `POST /compose.start` | `composeId` | - | `true` |
| Delete compose | `POST /compose.delete` | `composeId`, `deleteVolumes` | - | compose row |
| Attach domain (init 6, 7) | `POST /domain.create` | `host` | `composeId`, `serviceName`, `port`, `https:true`, `certificateType:"letsencrypt"`, `domainType:"compose"`, `path`, `internalPath`, `stripPath`, `middlewares` | domain row (`domainId`); compose needs redeploy |
| List / delete domains | `GET /domain.byComposeId` / `POST /domain.delete` | `composeId` / `domainId` | - | `[domain]` / domain |
| Create S3 destination (init 8) | `POST /destination.create` | `name`, `provider` (string or null), `accessKey`, `secretAccessKey`, `bucket`, `region`, `endpoint`, `additionalFlags` (array or null) | `serverId` | destination row (`destinationId`) |
| Test destination | `POST /destination.testConnection` | same as create | `serverId` | `{}` on success, 500 with rclone error otherwise |
| Create schedule (create 6) | `POST /backup.create` | `schedule` (cron), `prefix`, `destinationId`, `database`, `databaseType:"postgres"` | `postgresId`, `enabled` (default true), `keepLatestCount`, `backupType:"database"` | backup row (`backupId`, `appName`) |
| Enable / disable schedule (pause) | `POST /backup.update` | `backupId`, `schedule`, `enabled`, `prefix`, `destinationId`, `database`, `keepLatestCount`, `serviceName`, `metadata`, `databaseType` (all required) | `includeEncryptionKey` | backup row |
| Delete schedule (destroy 4) | `POST /backup.remove` | `backupId` | - | backup row |
| On-demand backup (backup, destroy 2) | `POST /backup.manualBackupPostgres` | `backupId` | - | `true` after the dump+upload completes (synchronous) |
| List dumps (restore, list) | `GET /backup.listBackupFiles` | `destinationId`, `search` (e.g. `<appName>/<prefix>/`) | `serverId` | `RcloneFile[]` (max 100) |
| Restore | none on REST (`backup.restoreBackupWithLogs` is a tRPC subscription only) | - | - | use `psql`/`pg_restore` over SSH as the spec already plans |
| Container metrics (list) | `GET /user.getContainerMetrics` | `url`, `token`, `appName`, `dataPoints` | - | metrics agent proxy; only useful if the paid/agent monitoring is set up |
| Live OpenAPI spec | `GET /settings.getOpenApiDocument` | - | - | OpenAPI JSON for the running version |
| Create API key | `POST /user.createApiKey` | `name` (<=32), `metadata.organizationId` | `expiresIn`, `rateLimitEnabled` (set `false`), `prefix` | `{id, key, ...}` |

## Unverified / uncertain

- **Response bodies are not typed in openapi.json** (every 200 is `{type:"object", properties:{}}`). Field names above come from the Drizzle schemas and router code. Before freezing the `DokployClient` types, fetch `GET /api/settings.getOpenApiDocument` on the live instance and record real responses as the MSW fixtures the spec already calls for.
- **`postgres.deploy` result when convergence times out**: the code throws `INTERNAL_SERVER_ERROR` after 45 s and sets `applicationStatus:"error"`. Whether the Swarm service keeps retrying (and later becomes healthy) after that is Docker behaviour; verify on the VPS by deploying an image that is slow to pull.
- **`memoryLimit` unit**: verified as `Number.parseInt` of the string into `MemoryBytes`. Not verified whether the UI writes bytes too (it may pre-convert). Test `postgres.update {memoryLimit:"536870912"}` then `docker service inspect <appName>` and confirm `Resources.Limits.MemoryBytes`.
- **Does `docker service rm` leave the volume on this Docker version?** Verified from Dokploy code that it never calls `docker volume rm`; Docker itself does not remove named volumes on service removal. Confirm with `docker volume ls | grep <appName>-data` after `postgres.remove`, then add `docker volume rm` over SSH to `dbm destroy`.
- **Backup schedule timezone**: no `TZ` in the Dockerfile and no timezone column; UTC is inferred. Verify with `docker exec dokploy.1.<id> date`.
- **Backblaze B2 with the generic provider**: issue #2329 is open. Test `destination.testConnection` with `provider:"Other"` (or `"B2"`? rclone's S3 backend does not list B2 as a provider; `Other` is the usual value), `endpoint: https://s3.<region>.backblazeb2.com`, `region: <region>`. If it fails, `additionalFlags` (e.g. `--s3-upload-cutoff`, `--s3-chunk-size`) is the escape hatch.
- **Whether `postgres:18` volume path handling is stable**: `getMountPath` was added for 18+; if you pin `postgres:17` the mount path is `/var/lib/postgresql/data`. Upgrading a service from 17 to 18 later would need a new mount, not just an image bump; verify before promising "minor bumps by redeploying" only.
- **Deploy polling for compose**: `compose.deploy` is queued; I did not confirm the exact status field/enum for compose deployments. Read `GET /deployment.allByCompose?composeId=` and `compose.one` on the live instance.
- **Monitoring**: not verified whether the free (non-agent) per-container charts are exposed anywhere on REST beyond `swarm.getContainerStats`. Assume `docker stats` over SSH for `dbm list`.
- **Rate limit behaviour**: better-auth returns a 401 when a key is over its limit (per apx-dokploy issue). Not verified against Dokploy directly; test by creating a key via API without `rateLimitEnabled:false` and calling 11 times.
- **CVE fix versions**: many advisories list affected `<= 0.29.8` with no `patched_versions` field populated; v0.29.13 notes include the backup/restore injection fix. Treat anything `< 0.29.13` as vulnerable; verify the running version with `GET /api/settings.getDokployVersion` (exists in the spec paths, not exercised here).

## Recommended spec deviations

1. **Section 5.2 / 6: generate Dokploy-compatible passwords and pass explicit sizes.** Constrain the Dokploy `databasePassword` to `[A-Za-z0-9@#%^&*()_+\-=[\]{}|;:,.<>?~`]` (no `$ ! ' " \ /` or space) or the create call 400s. Pass `memoryLimit` as a byte string (`"536870912"` for 512 MB) and `cpuLimit` in nanoCPUs; translate `--memory 512m` in `core/naming.ts`/a units helper. Send `shared_buffers`/`max_connections` via `args: ["-c","shared_buffers=128MB","-c","max_connections=50"]` on `postgres.update`, then `postgres.deploy`.
2. **Section 5.2: pin `dockerImage: "postgres:17"` explicitly** (the default moved to `postgres:18`) or embrace 18 and drop the "postgres:17" text; either way record the PGDATA path difference (`/var/lib/postgresql/data` vs `/var/lib/postgresql/18/docker`) because `dbm import` and `dbm restore` exec into the container.
3. **Section 7 `destroy`: remove the volume yourself.** `postgres.remove` only runs `docker service rm`. Add an SSH step `docker volume rm <appName>-data` after the API call (and include it in rollback of `create`). Otherwise disk fills with orphaned volumes.
4. **Section 7 `create` step 2: treat `postgres.deploy` as blocking, not fire-and-poll.** It returns after Swarm convergence (up to 45 s) or throws. Wrap it with the 120 s timeout, then confirm via `postgres.one.applicationStatus === "done"` and a `SELECT 1` over `docker exec`. Note the response body is the pre-deploy row.
5. **Section 5.5 / 12: match Dokploy's dump format.** Backups are gzip'd `pg_dump -Fc` archives (custom format) named `<appName>/<prefix>/<ts>.sql.gz`. `dbm restore` must use `gunzip | pg_restore -O --clean --if-exists -d <db>`, not `psql`. Set `prefix` to `db/<slug>` so objects land at `<appName>/db/<slug>/...`; the `appName` segment is forced by Dokploy, so update the "Backup prefix" row in Section 6.
6. **Section 5.5: use `keepLatestCount` as a second retention layer** (e.g. 35) in addition to the B2 lifecycle rule; it is free and works even if the lifecycle rule is misconfigured.
7. **Section 5.5: cron runs in UTC.** Either write `03:00` in UTC-adjusted form (e.g. `0 6 * * *` for 03:00 in Argentina) or document that schedules are UTC. Per-project jitter is fine (`m` field).
8. **Section 5.1 / 7 `init` step 4: keep the "paste a token" step, but tell the operator to leave "Rate limit" off** (dashboard default), and have `dbm init` optionally mint its own long-lived key with `POST /user.createApiKey {name:"dbm", metadata:{organizationId}, rateLimitEnabled:false}` so the human-created key can be revoked. Fetch `organizationId` from `GET /user.get` or `organization.all`.
9. **Section 5.1 / 9 / 10: do not rely on ufw to hide port 3000.** Swarm host-mode publish bypasses ufw. Options, in order of preference: (a) provider firewall (Vultr/Hetzner cloud firewall) blocking 3000; (b) `iptables -I DOCKER-USER -p tcp --dport 3000 ! -i tailscale0 -j DROP` persisted with `iptables-persistent`; (c) Dokploy's own "Web Server domain" via Traefik plus closing 3000. `tailscale serve` still works as the operator-facing URL. Also apply the same reasoning to 6432 (compose-published ports bypass ufw too; that one is intentionally public).
10. **Section 5.1: pin a minimum Dokploy version (>= 0.29.13, ideally track 0.30.x)** and make `dbm doctor` warn when the instance is older, given the 2026-07 advisory batch. Also record that an API key is org-wide (no scoping): protect `~/.dbm/config.json` accordingly.
11. **Section 5.3 (certs-dumper): host path is `/etc/dokploy/traefik/dynamic/acme.json`, resolver name `letsencrypt`.** Bind-mount `/etc/dokploy/traefik/dynamic` read-only into the dumper. Because `certificateType:"letsencrypt"` on a compose domain needs the compose service redeployed for labels to apply, create the dummy `db.example.com` router as a **file-provider** entry in `/etc/dokploy/traefik/dynamic/dbm-db.yml` over SSH (hot-reloaded) instead of a compose domain; less API surface, no redeploy.
12. **Section 7 `dbm list`: last backup time** comes from `GET /backup.listBackupFiles?destinationId=&search=<appName>/db/<slug>/` (rclone `ModTime`), not from a backup-run endpoint; deployments of type backup are also visible via `GET /deployment.allByType?id=<backupId>&type=backup` (verify enum).
13. **Section 5.1 statement "more complete REST API for database operations":** soften. Coolify's create-Postgres body is richer (`postgres_conf`, limits, `instant_deploy`) and its backup API has S3 retention by days/count. Dokploy's advantages that hold up: first-class Swarm service with `appName` DNS on `dokploy-network`, `keepLatestCount`, simpler single-host model. Keep Dokploy, but state the tradeoff honestly in Section 17.

## Sources

- https://github.com/Dokploy/dokploy
- https://api.github.com/repos/Dokploy/dokploy/releases
- https://github.com/Dokploy/dokploy/releases/tag/v0.30.0
- https://dokploy.com/install.sh
- https://docs.dokploy.com/docs/core/installation
- https://docs.dokploy.com/docs/core/guides/tailscale
- https://docs.docker.com/engine/network/packet-filtering-firewalls/
- https://docs.dokploy.com/docs/api
- https://docs.dokploy.com/docs/api/project
- https://docs.dokploy.com/docs/api/reference-postgres
- https://docs.dokploy.com/docs/api/reference-compose
- https://docs.dokploy.com/docs/api/reference-domain
- https://docs.dokploy.com/docs/api/reference-destination
- https://docs.dokploy.com/docs/api/reference-backup
- https://docs.dokploy.com/docs/core/databases
- https://docs.dokploy.com/docs/core/databases/backups
- https://docs.dokploy.com/docs/core/databases/restore
- https://docs.dokploy.com/docs/core/domains
- https://docs.dokploy.com/docs/core/docker-compose/domains
- https://docs.dokploy.com/docs/core/troubleshooting/domains
- https://docs.dokploy.com/docs/core/monitoring
- https://docs.dokploy.com/docs/cli/authentication
- https://github.com/Dokploy/cli
- https://github.com/Dokploy/dokploy/blob/canary/openapi.json
- https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/pages/api/%5B...trpc%5D.ts
- https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/pages/swagger.tsx
- https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/server/api/routers/postgres.ts
- https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/server/api/routers/backup.ts
- https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/server/api/routers/project.ts
- https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/server/api/routers/user.ts
- https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/lib/api-keys.ts
- https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/components/dashboard/settings/api/add-api-key.tsx
- https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/components/dashboard/postgres/general/show-internal-postgres-credentials.tsx
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/db/schema/postgres.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/db/schema/backups.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/db/schema/destination.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/db/schema/account.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/db/schema/utils.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/services/postgres.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/services/project.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/services/destination.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/services/network.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/databases/postgres.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/docker/utils.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/docker/domain.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/builders/compose.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/backups/postgres.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/backups/utils.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/backups/index.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/restore/utils.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/restore/postgres.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/setup/traefik-setup.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/constants/index.ts
- https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/lib/auth.ts
- https://github.com/Dokploy/dokploy/blob/canary/Dockerfile
- https://github.com/better-auth/better-auth/blob/main/packages/api-key/src/index.ts
- https://github.com/actionplatform/apx-dokploy/issues/29
- https://github.com/Dokploy/dokploy/discussions/3192
- https://github.com/Dokploy/dokploy/issues/2329
- https://github.com/Dokploy/dokploy/issues/2161
- https://github.com/Dokploy/dokploy/issues/5519
- https://github.com/Dokploy/dokploy/security/advisories
- https://api.github.com/repos/Dokploy/dokploy/security-advisories
- https://github.com/Dokploy/dokploy/security/advisories/GHSA-h67g-mpq5-6ph5
- https://www.strix.ai/cve/CVE-2025-53376
- https://coolify.io/docs/api-reference/api/operations/list-databases
- https://coolify.io/docs/api-reference/api/operations/create-database-postgresql
- https://coolify.io/docs/api-reference/api/operations/create-database-backup
