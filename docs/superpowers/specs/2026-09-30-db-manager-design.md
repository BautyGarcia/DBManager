# db-manager (`dbm`) — Design Spec

**Date:** 2026-09-30
**Status:** Draft for review
**Repo:** public, MIT

## 1. Purpose

`dbm` is a self-hosted replacement for the "one Supabase project per app" workflow. It turns a single VPS into a personal database platform where each app gets its own isolated Postgres database, its own S3 bucket, and a set of credentials that drop straight into a Next.js project on Vercel. Creating, pausing, destroying, backing up, and inspecting projects is one command each, from a laptop or from an AI agent.

The owner today runs many Supabase free-tier accounts (one per project) and is about to cross the free-tier limits on several of them. Consolidating on a paid Supabase org costs 25 USD plus 10 USD per project per month. A single 8GB VPS runs the same workload for a fraction of that, with room to grow by resizing the machine.

### Success criteria

- `dbm create <slug>` returns working Next.js env vars in under two minutes.
- A Next.js app on Vercel (gru1 region) connects through TLS and serves requests with acceptable latency from Argentina.
- Twenty idle projects plus three active ones (2-3k users each) fit on a 4 vCPU / 8GB VPS.
- Every project has an automatic nightly off-site backup; a destroyed project is recoverable for 30 days.
- The Dokploy dashboard shows per-project CPU, memory, and disk.
- A fresh VPS goes from bare Ubuntu to a passing smoke test with `dbm init` and the documented prerequisites.
- The repo is self-explanatory enough that someone else can clone it and run their own instance.

## 2. Non-goals

- **Browser-side database access.** No anon key, no PostgREST, no RLS-as-security-boundary. All queries run in server code. This is deliberate (Section 9).
- **Hosting an auth server.** Auth is [better-auth](https://www.better-auth.com) running inside each Next.js app, storing users in that project's database.
- **Multi-tenant SaaS.** All projects belong to the operator. No user accounts, teams, or billing in `dbm`.
- **Multi-VPS orchestration.** Version 1 targets one machine. Dokploy can manage additional servers later; `dbm` does not need to know about it yet.
- **Realtime, edge functions, vector search as managed services.** Postgres extensions (`pgvector` etc.) can be enabled per project; managed realtime is out of scope.
- **Automated migration of Supabase Auth users.** Documented as a manual procedure (Section 13), not a command, in version 1.
- **A custom web dashboard.** Dokploy's dashboard is the UI. `dbm list` covers the CLI view.

## 3. Constraints and assumptions

| Item | Assumption |
|---|---|
| App hosting | Vercel, Next.js App Router, functions pinned to `gru1` (São Paulo) |
| VPS | Ubuntu 22.04 or 24.04, root SSH with key, public IPv4, 4 vCPU / 8GB / 80GB+ SSD to start; local Argentine provider preferred, Vultr São Paulo as fallback |
| Domain | One domain the operator controls with the ability to add A records |
| Off-site backups | Any S3-compatible bucket at a different provider; Backblaze B2 is the documented default |
| Private access | Tailscale account (free tier) for the dashboard and admin access |
| Operator machine | macOS or Linux with Node 22+, `ssh`, and the Vercel CLI |
| Scale ceiling | Vertical. If one box is not enough, resize it. Beyond that is a future spec |

## 4. Architecture overview

```
                           PUBLIC INTERNET
                                 │
 Vercel functions (gru1) ──TLS──►│ db.example.com:6432 ─► PgBouncer ─┬─► pg-projecta:5432
                                 │                                  ├─► pg-projectb:5432
 Vercel / browsers ─────TLS──►   │ s3.example.com:443  ─► Traefik ─► Garage ─┬─ bucket projecta
                                 │                                          └─ bucket projectb
                                 │
                           TAILSCALE ONLY
                                 │
 Operator / agent ──────────►    │ Dokploy dashboard (tailnet HTTPS)
 dbm CLI ───────────────────►    │ Dokploy REST API + SSH
```

All boxes live on one VPS as Docker containers managed by Dokploy. Four layers:

1. **Dokploy** — platform. Owns containers, Traefik reverse proxy with Let's Encrypt, dashboard, per-container metrics, scheduled database backups to an S3 destination.
2. **Per-project Postgres** — one container, one volume, one superuser, one non-superuser app role per project. Created via the Dokploy API. Not exposed publicly.
3. **Shared infrastructure** (deployed once by `dbm init` as Dokploy compose services):
   - **PgBouncer** — the only public database endpoint, TLS-terminating, routing by database name to the right project container.
   - **Garage** — S3-compatible object store; one bucket and one scoped access key per project. Exposed through Traefik with a public TLS certificate.
   - **traefik-certs-dumper** — sidecar that extracts the Let's Encrypt certificate Traefik obtains for `db.example.com` into files PgBouncer can load.
4. **`dbm` CLI** — TypeScript tool on the operator's machine. Orchestrates Dokploy API calls and SSH commands. Prints env vars. Shipped with an agent skill and Next.js templates.

## 5. Components

### 5.1 Dokploy

- Installed with the official one-line script by `dbm init`.
- Dashboard port (3000) is firewalled off the public interface and served on the tailnet with `tailscale serve`, giving an HTTPS URL like `https://vps.<tailnet>.ts.net`. No public DNS record for the dashboard.
- One Dokploy project named `dbm` groups every service. Inside it: `pgbouncer` (compose), `garage` (compose), and one Postgres service per user project.
- API access via a Dokploy API token created during init and stored in `~/.dbm/config.json`. The `dbm` CLI talks to the API over the tailnet URL, so the API is never exposed publicly.
- Dokploy's built-in database backup feature provides scheduled `pg_dump` to an S3 destination. `dbm` registers one schedule per project.

**Chosen over Coolify because:** lighter footprint, first-class Postgres service type with memory limits and backup scheduling, more complete REST API for database operations. Both would work; this is a judgment call, not a hard requirement.

### 5.2 Per-project Postgres

- Image: `postgres:17` (official). Pinned major version; minor bumps are applied by redeploying the service.
- Created with Dokploy's Postgres service type. Dokploy's "database user" field becomes the project **superuser**, named `<slug>_admin`, with a 32-byte random password. `dbm` keeps this credential for admin tasks and never prints it in `dbm env`.
- After the container is healthy, `dbm` runs SQL as the superuser:
  ```sql
  CREATE ROLE <slug>_app LOGIN PASSWORD '<random>' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  CREATE DATABASE <slug> OWNER <slug>_app;
  \c <slug>
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  ```
  Additional extensions (`pgvector`, `pg_trgm`, `postgis` via a different image) can be requested with `--extensions`.
- Default resource limit: 512MB memory (Dokploy service setting), `shared_buffers=128MB`, `max_connections=50` (PgBouncer is the one holding connections). Overridable with `--memory`.
- **No external port.** Reachable only on the Docker network `dokploy-network`, which PgBouncer also joins.
- The container's DNS name is whatever Dokploy assigns as the service `appName`. `dbm` stores it in state and uses it in the PgBouncer config; it never assumes a naming pattern.

### 5.3 PgBouncer

- Image: `edoburu/pgbouncer` (widely used, configurable via mounted files). Config and user list are bind-mounted from `/etc/dokploy/dbm/pgbouncer/` on the host, which `dbm` writes over SSH.
- `pgbouncer.ini` essentials:
  ```ini
  [databases]
  ; one line per project, generated by dbm
  projecta = host=<pg-projecta appName> port=5432 dbname=projecta

  [pgbouncer]
  listen_addr = 0.0.0.0
  listen_port = 6432
  pool_mode = transaction
  max_client_conn = 1000
  default_pool_size = 20
  min_pool_size = 0
  reserve_pool_size = 5
  server_idle_timeout = 300
  max_prepared_statements = 200        ; protocol-level prepared statements (PgBouncer >= 1.21)
  auth_type = scram-sha-256
  auth_file = /etc/pgbouncer/userlist.txt
  client_tls_sslmode = require
  client_tls_cert_file = /certs/db.example.com/certificate.crt
  client_tls_key_file  = /certs/db.example.com/privatekey.key
  server_tls_sslmode = disable         ; internal Docker network on one host
  ```
- `userlist.txt` holds SCRAM-SHA-256 verifiers, one per app role. `dbm` reads the verifier from `pg_authid.rolpassword` right after creating the role, so the plaintext password never has to be re-derived.
- **Reload, not restart**, after every change: `docker kill -s HUP <pgbouncer container>` over SSH. Existing connections to other projects are unaffected.
- **TLS certificate:** Traefik obtains a Let's Encrypt cert for `db.example.com` (via a dummy HTTP router created by `dbm init`). `traefik-certs-dumper` watches Traefik's `acme.json` and writes PEM files to `/etc/dokploy/dbm/certs/`, then SIGHUPs PgBouncer. Connection strings use `sslmode=verify-full`, so clients verify the certificate and hostname.
  - **Fallback if the dumper proves brittle:** `dbm init` generates a self-signed cert and connection strings use `sslmode=require` (encrypted, not host-verified). Equivalent to how most Supabase connection strings are used in practice. Recorded as a decision in Section 17.
- Port 6432 is the only public database port. Postgres 5432 is never exposed.

### 5.4 Garage (S3 storage)

- [Garage](https://garagehq.deuxfleurs.fr) single-node, one container, one data volume, `replication_factor = 1`.
- Ports on the Docker network: 3900 (S3 API), 3902 (web endpoint for public buckets), 3903 (admin API, token-protected, never exposed publicly).
- Traefik routes `s3.example.com` → `garage:3900` with a Let's Encrypt cert. Path-style addressing (`s3.example.com/<bucket>/<key>`) so a single certificate covers every bucket. Templates set `forcePathStyle: true`.
- Per project, `dbm` uses the admin API to: create bucket `<slug>`, create key `<slug>-key`, grant that key `read + write + owner` on that bucket only. Buckets are private by default; `dbm storage public <slug>` toggles the website/public read flag for asset buckets.
- Uploads from the browser go through presigned PUT URLs generated server-side (template provided). Downloads of private objects use presigned GET; public buckets are served directly.

**Chosen over MinIO because** MinIO's community edition has been progressively stripped of features and its long-term availability for self-hosters is uncertain. Garage is small, actively maintained, and designed for this case. **Fallback:** SeaweedFS. Everything speaks S3, so the swap is contained to the `GarageAdmin` adapter and the compose file.

### 5.5 Off-site backups

- Dokploy backup schedules run `pg_dump | gzip` per project and upload to the configured S3 destination, at `03:00` local time with a per-project jitter of a few minutes.
- Destination: a bucket at a **different provider** (default docs: Backblaze B2) with **server-side encryption enabled** and a **30-day lifecycle rule** that deletes old objects. Retention is enforced by the provider, not by `dbm`, so it keeps working even if the VPS is gone.
- Garage bucket contents are synced nightly to the same off-site bucket under `storage/<slug>/` using an `rclone` cron container deployed by `dbm init`.
- `dbm destroy` always takes a final backup before deleting anything.
- Provider-side VPS snapshots are recommended as a second, independent layer. Not managed by `dbm`.

### 5.6 `dbm` CLI

TypeScript, Node 22+, published to npm as `dbm` (or scoped if the name is taken). Runs with `npx dbm` or a global install.

**Dependencies (kept minimal):** `commander`, `pg`, `zod`, `execa` (to drive the system `ssh`/`scp`), `picocolors`. No Docker SDK; all remote work is over SSH or the Dokploy API.

**Layers:**

```
src/
  core/        pure functions, no I/O — the unit-test surface
    naming.ts        slug validation, derived names
    pgbouncer.ts     render pgbouncer.ini + userlist.txt from state
    env.ts           render env vars / JSON output
    state.ts         zod schema + migrations for state.json
    passwords.ts     random secrets
  adapters/    one module per external system, each behind an interface
    dokploy.ts       DokployClient  (REST)
    ssh.ts           SshRunner      (execa → ssh/scp)
    postgres.ts      PostgresAdmin  (pg, via SSH tunnel or docker exec)
    garage.ts        GarageAdmin    (admin REST API)
    store.ts         StateStore     (~/.dbm/*.json, 0600)
  commands/    orchestration, one file per command
  cli.ts       argument parsing → commands
```

**Remote execution model:** `PostgresAdmin` runs SQL via `ssh host docker exec -i <container> psql ...`. This avoids opening any admin port and reuses the operator's SSH key. The Dokploy API is reached over the tailnet.

**Local files (`~/.dbm/`, mode 0700; files 0600):**

- `config.json` — host, SSH user, tailnet URL, Dokploy API token, domain names, Garage admin token, Garage `dbm-backup` read-only key id, off-site destination id.
- `state.json` — projects (Section 8).
- `state.json.bak.<ts>` — written before every mutation; last 10 kept.

Nothing under `~/.dbm/` is ever inside the repo. The repo `.gitignore` also blocks `.dbm/`, `*.local.json`, and `.env*`.

### 5.7 Agent skill and templates

`skills/dbm/SKILL.md` (Claude Code skill format, symlinkable into `~/.claude/skills/`) instructs an agent to:

1. Run `dbm create <slug> --json` and parse the output.
2. Write values to `.env.local`; push to Vercel with `vercel env add` for `production`, `preview`, and `development`.
3. Add `regions: ["gru1"]` to the Vercel config.
4. Copy the templates below into the project, install `drizzle-orm`, `postgres`, `better-auth`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.
5. Run `drizzle-kit push` (or generate a migration) to create better-auth's tables.

`templates/nextjs/`:

| File | Purpose |
|---|---|
| `lib/db.ts` | Drizzle + `postgres` (postgres.js) with `ssl: 'verify-full'`, `prepare: true`, small pool sized for serverless |
| `drizzle.config.ts` | Points at `DATABASE_URL` |
| `lib/auth.ts` | better-auth server config: Drizzle adapter, email+password enabled, session cookie settings |
| `lib/auth-client.ts` | better-auth React client |
| `app/api/auth/[...all]/route.ts` | better-auth handler |
| `lib/s3.ts` | S3 client with `forcePathStyle`, `getPresignedUploadUrl`, `getPresignedDownloadUrl` |
| `vercel.json` | `{"regions": ["gru1"]}` |
| `.env.example` | Variable names with comments |

Templates are plain files copied verbatim; no templating engine.

## 6. Naming conventions

Input slug: `^[a-z][a-z0-9-]{1,30}$`. Hyphens are converted to underscores where Postgres identifiers require it.

| Thing | Name |
|---|---|
| Dokploy Postgres service | `pg-<slug>` (display); actual container/appName stored from API response |
| Database | `<slug_with_underscores>` |
| App role | `<slug_with_underscores>_app` |
| Superuser role | `<slug_with_underscores>_admin` |
| PgBouncer database entry | `<slug>` (this is what appears in `DATABASE_URL`) |
| Garage bucket | `<slug>` |
| Garage key | `<slug>-key` |
| Backup prefix (off-site) | `db/<slug>/` and `storage/<slug>/` |

Reserved slugs: `dbm`, `pgbouncer`, `garage`, `postgres`, `admin`, `template0`, `template1`.

## 7. Command reference

All commands accept `--json` for machine-readable output and `--yes` to skip confirmations (destructive commands still require the slug to be passed explicitly with `--confirm <slug>` when `--yes` is used).

### `dbm init <ssh-host>`

One-time VPS bootstrap. Interactive prompts (or flags) for: domain for PgBouncer, domain for S3, off-site S3 destination credentials, Tailscale auth key (optional; otherwise prints the login URL).

Steps, each idempotent and resumable:

1. **Harden host:** disable SSH password auth, enable `unattended-upgrades`, install and configure `ufw` (allow 22/tcp, 80/tcp, 443/tcp, 6432/tcp, 41641/udp; default deny), install `fail2ban` with the sshd jail.
2. **Install Tailscale**, bring it up, enable `tailscale serve` for port 3000 → tailnet HTTPS.
3. **Install Dokploy** with the official script. Block port 3000 on the public interface.
4. **Create Dokploy API token** (prompted; Dokploy requires this step in the UI in current versions, so `init` prints the tailnet URL and waits for the token to be pasted).
5. **Create the `dbm` Dokploy project.**
6. **Deploy `garage`** compose service with generated `rpc_secret` and admin token; create the shared `dbm-backup` key used by storage sync; configure Traefik domain `s3.example.com`.
7. **Deploy `pgbouncer` + `certs-dumper`** compose service; create a dummy HTTP router for `db.example.com` so Traefik requests its certificate; wait for the dumper to produce files.
8. **Register the off-site S3 destination** in Dokploy; deploy the `rclone` storage-sync cron service.
9. **Smoke test:** `dbm create dbm-smoke`, connect from the operator machine through `db.example.com:6432` with `verify-full`, run `SELECT 1`, upload and download an object via `s3.example.com`, `dbm destroy dbm-smoke --purge-storage`.
10. Write `~/.dbm/config.json`. Print a summary.

### `dbm create <slug> [--memory 512m] [--extensions pgvector,pg_trgm] [--no-storage]`

1. Validate slug, check not present in state or in Dokploy.
2. Dokploy: create Postgres service in project `dbm`, deploy, poll until healthy (timeout 120s).
3. SQL: create app role, database, extensions (Section 5.2).
4. Read SCRAM verifier; append to PgBouncer `userlist.txt` and `[databases]`; upload; SIGHUP.
5. Garage: create bucket and key, grant permissions; also grant the shared `dbm-backup` key read access to the new bucket so nightly storage sync covers it (skipped with `--no-storage`).
6. Dokploy: create nightly backup schedule for this service to the off-site destination.
7. Save state (write `.bak` first).
8. Print env block:

```
DATABASE_URL=postgresql://myapp_app:<pw>@db.example.com:6432/myapp?sslmode=verify-full
S3_ENDPOINT=https://s3.example.com
S3_REGION=garage
S3_BUCKET=myapp
S3_ACCESS_KEY_ID=GK...
S3_SECRET_ACCESS_KEY=...
BETTER_AUTH_SECRET=<32 random bytes, base64>
BETTER_AUTH_URL=https://<to be set to the app URL>
```
followed by: *"Set Vercel function region to gru1 (see templates/nextjs/vercel.json)."*

**Rollback:** if any step fails, previously completed steps are undone in reverse order (delete backup schedule, delete key/bucket, remove PgBouncer entry, remove Dokploy service). The failure message includes the underlying API/SSH error and the rollback result.

### `dbm list`

Table: slug, state (`running` / `paused` / `error`), memory used, disk used (volume size via `docker system df -v` over SSH), storage used (Garage bucket stats), last backup time (Dokploy API), created date. `--json` for agents.

### `dbm env <slug>`

Reprints the env block. Superuser password is never included. `--json` supported.

### `dbm pause <slug>` / `dbm resume <slug>`

Stop / start the Dokploy service and disable / re-enable its backup schedule, so a paused project produces no failed backup runs. Volume, bucket, and PgBouncer entry are untouched. Connections to a paused project fail fast at PgBouncer with a server-unreachable error.

### `dbm destroy <slug> [--purge-storage]`

1. Confirm by retyping the slug (or `--confirm <slug>`).
2. Take a final on-demand backup and wait for it.
3. Remove PgBouncer entry and user, SIGHUP.
4. Delete backup schedule, then the Dokploy service **including its volume**.
5. Delete Garage key. Delete the bucket only with `--purge-storage`; otherwise leave it and print a reminder. Off-site copies remain until the 30-day lifecycle rule removes them.
6. Update state.

### `dbm backup <slug>` / `dbm restore <slug> <backup-id|latest> [--as <newslug>]`

`backup` triggers an on-demand Dokploy backup and waits. `restore` lists available off-site dumps for the slug and restores the chosen one via `psql` in the target container after dropping and recreating the database. With `--as`, it first runs the equivalent of `create <newslug>` and restores there, which is the clone workflow (e.g. `dbm restore prod latest --as staging`).

### `dbm psql <slug> [--admin]`

Interactive `psql` in the project container over SSH as the app role (or superuser with `--admin`).

### `dbm storage public <slug> [--off]`

Toggle public read on the project bucket.

### `dbm import <slug> --from <supabase-db-url> [--storage <supabase-s3-endpoint> --storage-key ... --storage-secret ... --bucket <name>]`

Migration helper, runs entirely on the VPS inside a temporary `postgres:17` container so no local tooling is needed:

1. `pg_dump --schema=public --no-owner --no-privileges --no-comments <supabase-url>` (plus any `--schemas` the user adds).
2. Restore into `<slug>` with `psql -v ON_ERROR_STOP=0`, collecting errors.
3. Print a report. Expected errors: foreign keys to `auth.users`, references to `auth.uid()` in defaults or policies, `storage.objects` references. The report lists each with the object name and a pointer to the migration guide.
4. With storage flags: `rclone sync` from Supabase Storage's S3-compatible endpoint into the Garage bucket.

`import` never modifies the source database.

### `dbm doctor`

Checks: SSH reachable, Dokploy API reachable over tailnet, PgBouncer config matches state (drift detection), certificate expiry, Garage healthy, off-site destination writable, last backup age per project, disk free on VPS. Exit code non-zero on any failure. Intended to run from a cron or a CI schedule.

## 8. State model

`~/.dbm/state.json`, validated with zod, versioned for migrations:

```ts
type State = {
  version: 1;
  projects: Record<string, {
    slug: string;
    createdAt: string;               // ISO
    status: "running" | "paused";
    dokploy: { postgresId: string; appName: string; backupScheduleId?: string };
    postgres: {
      database: string;
      appRole: string; appPassword: string;
      adminRole: string; adminPassword: string;
      extensions: string[];
      memoryLimit: string;
    };
    storage?: { bucket: string; keyId: string; keySecret: string; public: boolean };
    betterAuthSecret: string;
  }>;
};
```

State is the source of truth for PgBouncer config: `core/pgbouncer.ts` renders both files purely from `State`, so drift is detectable (`dbm doctor`) and recoverable (`dbm sync-pgbouncer`, a hidden maintenance command).

**Losing `state.json` is recoverable but painful:** Dokploy still has the services, Postgres still has the roles, Garage still has the keys; only passwords would need rotation. `dbm` therefore keeps timestamped backups locally and the README recommends keeping `~/.dbm/` in a password manager or encrypted backup.

## 9. Security model

**Threat model:** internet attackers scanning public ports; leaked credentials for one project; a compromised operator laptop; a dead or compromised VPS. Not in scope: hostile co-tenants (all projects belong to the operator).

**Controls:**

| Surface | Control |
|---|---|
| Browser | Never holds database credentials. All data access is server-side. Removes the RLS-misconfiguration class of bugs entirely. |
| PgBouncer :6432 (public) | TLS required with a publicly trusted cert (`verify-full`); SCRAM-SHA-256; one long random password per project; app roles are `NOSUPERUSER`. |
| Garage :443 (public, via Traefik) | Per-project key scoped to one bucket; buckets private unless explicitly made public; admin API not routed publicly. |
| Postgres :5432 | Not exposed. Docker network only. |
| Dokploy dashboard + API | Tailscale only. Firewalled from the public interface. Dokploy 2FA enabled for the operator account (documented step). |
| SSH :22 | Key-only, `fail2ban`. Kept public (not tailnet-only) to avoid lockout if Tailscale misbehaves. |
| OS | `unattended-upgrades` for security patches; `ufw` default deny. |
| Secrets at rest (VPS) | Dokploy stores service env in its own DB; PgBouncer `userlist.txt` holds SCRAM verifiers, not plaintext. |
| Secrets at rest (laptop) | `~/.dbm/` mode 0600. Same trust model as `~/.aws/credentials`. |
| Backups | TLS in transit, provider server-side encryption at rest, different provider than the VPS. |
| Blast radius | Per-project superuser and app role; leaked project A credentials cannot reach project B. |

**Residual risks, stated plainly:**

- Containers share one kernel and one Docker daemon. Not VM isolation. Acceptable because all tenants are the operator; not acceptable for hosting untrusted third parties.
- A single VPS is a single point of failure. Downtime affects every project simultaneously. Mitigation is backups plus provider snapshots, not high availability.
- Backups are encrypted by the provider, not client-side. A compromised B2 account exposes dumps. Client-side encryption is listed as future work.
- The operator laptop holds every credential. Standard laptop hygiene applies.

## 10. Networking, DNS, TLS

Public DNS A records required: `db.example.com`, `s3.example.com` → VPS IPv4. Dashboard uses the Tailscale MagicDNS name; no public record.

Ports (public): 22, 80 (ACME challenges only; Traefik redirects to 443), 443, 6432. Port 41641/udp for Tailscale.

Certificates: Traefik/Let's Encrypt for both hostnames, auto-renewed. `certs-dumper` republishes the `db.` cert to PgBouncer on renewal. `dbm doctor` warns at <14 days to expiry as a safety net.

## 11. Vercel integration

- `DATABASE_URL` uses port 6432 with `sslmode=verify-full`. The template driver config (postgres.js) sets `max: 5`, `idle_timeout: 20`, `prepare: true` (PgBouncer ≥1.21 handles protocol-level prepared statements in transaction mode).
- `vercel.json` sets `regions: ["gru1"]`. Buenos Aires ↔ São Paulo is ~30ms; the default `iad1` would add ~150ms per query. The skill enforces this; `dbm create` prints a reminder.
- Env vars are pushed with `vercel env add` from the `--json` output. `BETTER_AUTH_URL` is set per environment to the deployment URL.
- Fluid Compute is on by default on Vercel and reuses instances, which keeps the number of pooled connections modest. `max_client_conn = 1000` on PgBouncer leaves ample headroom.

## 12. Backups and recovery scenarios

| Scenario | Recovery |
|---|---|
| Bad migration corrupted data | `dbm restore <slug> <backup-id>` (point-in-time to last nightly or on-demand dump) |
| Accidental `destroy` | Off-site dump exists ≤30 days; `dbm restore <slug> latest --as <slug>` recreates the project |
| VPS disk dies | New VPS → `dbm init` → for each project `dbm restore <slug> latest --as <slug>` (Postgres) and `rclone` from off-site `storage/<slug>/` into the new bucket (script provided) |
| Laptop lost | Restore `~/.dbm/` from operator backup, or rotate: reconnect via new SSH key, regenerate Dokploy token, reset app role passwords via `dbm psql --admin` (a `dbm rotate` command is future work) |
| Let's Encrypt renewal fails | `dbm doctor` warns; PgBouncer keeps serving with the old cert until expiry; `sslmode=verify-full` clients fail only after expiry |

RPO is 24 hours by default (nightly dumps). Projects that need less can run `dbm backup` from an app cron or switch the schedule to hourly with `--backup-cron` (future flag; Dokploy supports arbitrary cron).

## 13. Migration from Supabase (operator guide, summarized)

1. `dbm create <slug>`.
2. `dbm import <slug> --from <supabase-direct-url> --storage ...`.
3. Read the import report. Typical fixes in the Next.js code and schema:
   - Replace `supabase-js` queries with Drizzle queries in server code. Client components call server actions or route handlers instead.
   - Drop FKs to `auth.users(id)`; add FKs to better-auth's `user(id)`. Column types match (text/uuid as configured).
   - Remove RLS policies and `auth.uid()` defaults; authorization now lives in server code with the session from better-auth.
   - Replace Supabase Storage calls with presigned URLs from `lib/s3.ts`.
4. **Users:** two options, both documented.
   - *Re-register:* simplest; email users about the change.
   - *Preserve accounts:* export `auth.users` (id, email, encrypted_password, created_at). Insert into better-auth `user` and `account` tables. Supabase hashes are bcrypt; configure better-auth's `emailAndPassword.password.verify` to accept bcrypt for legacy rows and rehash on next login. A script for this ships in `scripts/migrate-supabase-users.ts` as a documented, review-before-running tool, not a `dbm` command.
5. Deploy to Vercel with new env vars and `gru1`. Verify. Pause or delete the Supabase project.

## 14. Error handling and idempotency

- Every mutating command writes a `state.json.bak.<ts>` first.
- `create` is transactional-by-rollback (Section 7). Re-running `create` on a slug that exists in state prints the current status and exits 0 with a note; on a slug that exists in Dokploy but not in state, it refuses and points to `dbm adopt <slug>` (future work) to avoid clobbering.
- `init` records a checkpoint after each step in `~/.dbm/init-progress.json`; re-running resumes from the last incomplete step.
- All remote errors surface the underlying message (Dokploy JSON error body, SSH stderr, Garage admin error) prefixed with the step name. No generic "something went wrong".
- Timeouts: Dokploy deploy 120s, SSH command 60s, Garage admin 15s. Configurable via env `DBM_TIMEOUT_MULTIPLIER` for slow VPSes.
- Exit codes: 0 ok, 1 user error (bad slug, missing config), 2 remote failure, 3 rollback also failed (manual attention needed; message lists leftover resources).

## 15. Testing strategy

| Level | Scope | Tooling | When |
|---|---|---|---|
| Unit | `core/*` — naming, PgBouncer rendering, env rendering, state schema and migrations, password generation | Vitest | every commit |
| Adapter contract | Each adapter against an in-memory fake implementing the same interface; commands tested end-to-end against fakes, including rollback paths | Vitest | every commit |
| Integration | Real Postgres 17 + PgBouncer + Garage via `docker compose` in `test/compose/`; exercises `PostgresAdmin`, `GarageAdmin`, PgBouncer render → reload → connect through PgBouncer with SCRAM | Vitest with a `globalSetup` that runs `docker compose up` in `test/compose/` | every commit locally; CI on PRs |
| Dokploy adapter | Recorded HTTP fixtures (request/response JSON) from a real Dokploy; contract test asserts our client matches the fixtures; fixtures refreshed manually when Dokploy version bumps | Vitest + MSW | every commit |
| End to end | `dbm init` on a disposable VPS through the smoke test, then create/pause/resume/backup/restore/destroy | Manual script `scripts/e2e.sh` | before each tagged release |

TDD applies to `core` and `commands`. Adapters are thin and covered by integration tests rather than unit tests.

## 16. Repository layout

```
db-manager/
  README.md                 architecture, quick start, prerequisites
  LICENSE                   MIT
  package.json              bin: dbm
  src/                      (Section 5.6)
  compose/
    pgbouncer/              compose.yaml, pgbouncer.ini.template, certs-dumper config
    garage/                 compose.yaml, garage.toml.template
    storage-sync/           compose.yaml (rclone cron)
  templates/nextjs/         (Section 5.7)
  skills/dbm/SKILL.md
  scripts/
    e2e.sh
    migrate-supabase-users.ts
    recover-storage.sh      re-hydrate Garage from off-site after VPS loss
  test/
    unit/  adapters/  integration/  fixtures/dokploy/
    compose/                local Postgres + PgBouncer + Garage for integration tests
  docs/
    superpowers/specs/      this file
    migration-from-supabase.md
    security.md             Section 9 expanded for readers of the public repo
    runbook.md              recovery scenarios (Section 12) as step-by-step
```

## 17. Decisions log

| Decision | Alternatives | Why |
|---|---|---|
| Server-only DB access, no anon key | Supabase-compatible PostgREST layer | Safer, far less to build, matches Next.js server-first patterns. Operator accepted migrating client code. |
| Dokploy as platform | Coolify; hand-rolled Docker + CLI | Dashboard with per-project metrics was a stated want; Dokploy is lighter with a better DB API. |
| Per-project Postgres containers | One Postgres, many databases | Per-project metrics, pause/delete granularity, independent upgrades. Cost: ~40MB RAM per idle project, accepted. |
| Single shared PgBouncer | Per-project PgBouncer; Supavisor | One public port, one cert, trivial routing by db name. |
| Garage for S3 | MinIO; SeaweedFS | MinIO community edition uncertainty. Garage is small and purpose-built. Swappable. |
| better-auth in-app | Hosting GoTrue/Keycloak/Ory | Nothing to host; users live in the project DB; operator already interested in it. |
| Let's Encrypt via certs-dumper for PgBouncer | Self-signed + `sslmode=require`; Traefik TCP TLS termination | Real host verification. Fallback recorded if dumper is brittle. |
| Dashboard on Tailscale only | Public with password + 2FA | Dashboard is root over every project. Removing it from the internet is the highest-value control. |
| SSH stays public (key-only) | Tailscale-only SSH | Lockout safety if Tailscale fails. fail2ban limits exposure. |
| State file 0600, not encrypted | Passphrase-encrypted state | Passphrase prompt breaks the agent flow. Same model as AWS/kube CLIs. Can add later. |
| Retention via provider lifecycle rule | `dbm` pruning old backups | Works even if the VPS or laptop is gone. |
| Vercel `gru1` region | Default `iad1` | ~30ms vs ~150ms per query from Buenos Aires. |

## 18. Future work (explicitly out of version 1)

- `dbm adopt <slug>` to bring an existing Dokploy Postgres into state.
- `dbm rotate <slug>` to rotate app passwords and S3 keys, with a grace window.
- Hourly backup option and client-side backup encryption.
- Multi-server support via Dokploy's remote servers.
- Optional per-project `pgvector`/PostGIS image variants.
- A read-only web page summarizing `dbm list` for phone glances (only if Dokploy's dashboard proves insufficient).
- Realtime (Postgres `LISTEN/NOTIFY` bridge) if a project needs it.
- Brute-force protection on port 6432 (ship PgBouncer logs to the host and add a `fail2ban` jail). SCRAM with 32-byte random passwords makes this low priority.
