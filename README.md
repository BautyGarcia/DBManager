# db-manager (`dbm`)

`dbm` turns one VPS into a personal database platform. Each app gets its own isolated Postgres container, its own S3 bucket, and credentials that drop straight into a Next.js project on Vercel. Creating, pausing, destroying, backing up and inspecting projects is one command each, from a laptop or from an AI agent (a skill ships in `skills/dbm/`). It is a self-hosted replacement for the "one Supabase project per app" workflow: no anon key, no PostgREST, all queries run in server code, auth is better-auth inside each app.

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
 Operator / agent ─────────────►      │ https://<host>.<tailnet>.ts.net:8443  (tailscale serve → 127.0.0.1:3000 Dokploy)
 dbm CLI ──────────────────────►      │ Dokploy REST API (same URL) + SSH :22 (key-only, public, fail2ban)
```

Everything runs as Docker containers managed by [Dokploy](https://dokploy.com): per-project Postgres (17 or 18), one shared PgBouncer (the only public database port), Garage for S3-compatible storage, and Traefik for TLS. The `dbm` CLI orchestrates Dokploy over the tailnet and the VPS over SSH.

## Why

Supabase free tiers are one project per account. Consolidating on a paid Supabase organization costs 25 USD plus 10 USD per project per month. One 4 vCPU / 8 GB VPS runs the same workload for a fraction of that and can be resized when it fills up. Each project keeps its own container, so per-project CPU, memory and disk are visible in the Dokploy dashboard, and pausing or deleting one project does not touch the others.

## Prerequisites

- **VPS**: Ubuntu 24.04 LTS only, 4 vCPU / 8 GB / 80 GB+ SSD to start, public IPv4, root SSH with your key. Ubuntu 22.04 and 26.04 are not supported.
- **DNS**: three A records to the VPS IPv4: `db.<domain>`, `s3.<domain>`, `*.web.<domain>`. They must resolve before `dbm init` reaches the certificate step.
- **Tailscale**: an account with MagicDNS on and HTTPS certificates enabled (admin console, DNS page), plus an auth key that is **non-ephemeral, pre-approved and single-use** (Settings, Keys). Consider disabling node-key expiry for the VPS.
- **Backblaze B2**: two private buckets with server-side encryption enabled at creation, and one Read/Write application key scoped to each bucket (or one key covering both).
  - Dumps bucket: lifecycle rule `daysFromUploadingToHiding = 30`, `daysFromHidingToDeleting = 1`, whole bucket. Not "Keep only the last version".
  - Storage mirror bucket: **no** upload-to-hiding rule, only `daysFromHidingToDeleting = 30` (deleted or overwritten objects stay recoverable for 30 days).
- **Operator machine**: macOS or Linux, Node >= 22.12.0, an OpenSSH client, and the [Vercel CLI](https://vercel.com/docs/cli).
  - If your SSH agent holds more than 5 keys, add a `Host` entry for the VPS in `~/.ssh/config` with `IdentitiesOnly yes` and `IdentityFile <your key>`: sshd allows 6 authentication attempts per connection, and fail2ban bans the address after repeated failures.
- Enable 2FA on the Dokploy account after the first login.

## Install

```bash
npm i -g db-manager     # provides the `dbm` binary
npx db-manager --help   # or run without installing (the package is db-manager, the binary is dbm)
```

## Quick start

```bash
dbm init 1.2.3.4 --domain example.com     # one-time VPS bootstrap; prompts for B2 and Tailscale details
dbm create myapp                          # prints the env block
```

Paste the printed variables into `.env.local` and into Vercel (`vercel env add NAME production,preview --value "$V" --yes --force`, then once more for `development`). Set `BETTER_AUTH_URL` to the production URL for production only. Pin functions to São Paulo by copying `templates/nextjs/vercel.json` (`"regions": ["gru1"]`). The `skills/dbm/SKILL.md` skill automates these steps for an AI agent, and `templates/nextjs/` holds the Drizzle, better-auth and S3 files for the app.

`--json` and `--yes` are global options and can go anywhere on the command line: `dbm list --json`, `dbm destroy myapp --yes --confirm myapp`.

`dbm init` is checkpointed in `~/.dbm/init-progress.json`; re-running resumes. Its steps are harden, tailscale, dokploy, apikey, project, garage, pgbouncer, destination, config, smoke. When it finishes it prints two checks the host cannot run itself: `nc -zv <ip> 3000` from outside the tailnet must fail, and `nc -zv db.<domain> 6432` must succeed.

## Commands

| Command | What it does |
|---|---|
| `dbm init <ssh-host> --domain <domain>` | Bootstrap a fresh VPS (hardening, Tailscale, Dokploy, Garage, PgBouncer, backups, smoke test). Options: `--user`, `--tls letsencrypt\|self-ca`, `--hostname`, `--timezone`, `--tailscale-auth-key`, `--dokploy-api-key`, `--b2-endpoint`, `--b2-region`, `--b2-key-id`, `--b2-key-secret`, `--b2-dumps-bucket`, `--b2-storage-bucket` |
| `dbm create <slug>` | Postgres container, PgBouncer entries, S3 bucket, nightly backup. Options: `--memory 512m`, `--pg 17\|18`, `--extensions a,b`, `--no-storage`, `--cors-origin <origin...>`. Slugs are 3-31 chars of lowercase letters, digits and single hyphens, start with a letter, no leading/trailing hyphen; the `dbm-` prefix is reserved. Idempotent for an existing slug; a half-created (`provisioning`) project is refused until you `dbm destroy` it |
| `dbm list` | Projects with status, memory, disk, storage and last backup |
| `dbm env <slug>` | Reprint the env block (never includes the superuser password) |
| `dbm pause <slug>` / `dbm resume <slug>` | Stop or start the Postgres container and its backup schedule |
| `dbm destroy <slug>` | Final backup, then remove everything; `--purge-storage` also deletes the bucket (a kept bucket is made private); `--confirm <slug>` is required with `--yes`. A failed destroy can be re-run: steps already done are reported as already gone |
| `dbm backup <slug>` | On-demand off-site backup, then list dumps |
| `dbm restore <slug> <backup-id\|latest>` | Restore a dump. `--as <newslug>` restores into a new project (clone workflow, or recreate a destroyed project with `--as <slug>`). In-place restore asks for confirmation (`--yes --confirm <slug>` non-interactively) |
| `dbm psql <slug>` | Interactive psql in the container; `--admin` for the superuser |
| `dbm storage public <slug>` | Serve the bucket on `<slug>.web.<domain>`; `--domain <host>` adds a vanity host, `--off` reverses |
| `dbm storage cors <slug> --origin <origin...>` | Set allowed browser origins |
| `dbm import <slug> --from <url>` | Import a Supabase or other Postgres database, optionally with storage (`--schemas`, `--storage-*`); see [the migration guide](docs/migration-from-supabase.md) |
| `dbm doctor` | Check versions, drift, TLS, backups, disk; exits 2 on failure |

A hidden maintenance command, `dbm sync-pgbouncer`, re-renders the PgBouncer files from state and reloads PgBouncer.

Environment variables printed by `dbm env`: `DATABASE_URL` (transaction pooling, port 6432), `DATABASE_URL_SESSION` (session pooling, used by drizzle-kit), `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (unless `--no-storage`), `BETTER_AUTH_SECRET`, an empty `BETTER_AUTH_URL`, and when applicable `S3_PUBLIC_BASE_URL` and `DATABASE_SSL_CA`.

## Where things live on the VPS

- `/etc/dokploy/dbm/pgbouncer/` rendered `pgbouncer.ini` and `userlist.txt` (never edit by hand; run `dbm sync-pgbouncer`).
- `/etc/dokploy/dbm/certs/` the `db.<domain>` certificate copied out of Traefik for PgBouncer.
- `/etc/dokploy/dbm/rclone/rclone.conf` rclone remotes (`garage:` read-only key, `b2:` storage bucket) used by the storage mirror.
- `/etc/dokploy/traefik/dynamic/dbm-*.yml` Traefik file-provider routes: `dbm-s3.yml`, `dbm-db-cert.yml`, `dbm-web-<slug>.yml`.
- `/etc/cron.d/dbm-storage-sync` nightly (06:30 host-local time, America/Argentina/Buenos_Aires by default, `--timezone` at init) mirror of Garage buckets and metadata snapshots to the storage bucket, run by a throwaway `rclone/rclone:1` container. The sync deletes at most 50 objects per run (`--max-delete 50`), so a wiped Garage cannot empty the mirror in one night.
- `/etc/cron.d/dbm-pgbouncer-reload` daily (04:10 host-local time) certificate ownership fix and PgBouncer SIGHUP.
- Nightly dumps are scheduled by Dokploy, whose cron runs in UTC: each project at a minute between 06:00 and 06:24 UTC (03:00-03:24 in Buenos Aires), chosen per slug.
- Containers: `dbm-pgbouncer`, `dbm-certs-dumper`, `dbm-garage`, and one `pg-<slug>-<suffix>` per project.

## Local files

`~/.dbm/` (directory 0700, files 0600) holds `config.json` (including the Dokploy API key, which is organization-wide), `state.json` (every project's passwords, SCRAM verifiers and S3 keys), `state.json.bak.<timestamp>` copies written before each mutation, and `init-progress.json` during `dbm init`. **Back this directory up** in a password manager or an encrypted backup; losing it means resetting every project's passwords.

## Provider note

A São Paulo VPS (for example Vultr `sao` or Hostinger) sits in the same metro as Vercel `gru1`. An Argentine provider (for example DonWeb) bills in ARS and keeps data in Argentina but adds about 30 ms per query round trip. Both work with this design; it is your call. With the default Vercel region (`iad1`) each query would add about 150 ms, which is why the templates pin `gru1`.

## Security

Postgres is never published; PgBouncer on 6432 is the only public database port, with TLS and `verify-full`. The Dokploy dashboard is reachable on the tailnet only. See [docs/security.md](docs/security.md) for the full model, residual risks and leak procedures.

## Recovery

See [docs/runbook.md](docs/runbook.md) for restores, VPS loss, Garage metadata recovery, certificate and Tailscale problems, resuming a stopped `dbm init`, and upgrading component versions.

## Development

```bash
npm ci
npm test                    # unit tests plus integration (needs Docker)
npm run test:unit           # unit tests only
npm run test:integration    # real Postgres, PgBouncer and Garage via docker compose; needs Docker
npm run lint && npm run typecheck && npm run build
scripts/e2e.sh              # end to end against a DISPOSABLE VPS (see the script header); run before a tagged release
```

Conventions: TypeScript with `erasableSyntaxOnly` (no `enum`, runtime `namespace` or constructor parameter properties), relative imports with `.js` specifiers, Biome for lint and format, runtime dependencies pinned exactly.

## Releasing

Releases use [release-please](https://github.com/googleapis/release-please-action) and npm trusted publishing (`.github/workflows/release.yml`). Merge conventional commits to `main`; release-please opens a release PR; merging it tags the release and publishes to npm with provenance and no long-lived token. One-time setup: on npmjs.com configure a trusted publisher for the GitHub repository `<owner>/db-manager`, workflow filename `release.yml`. It is unverified whether trusted publishing works before the package exists on npm, so the first `0.1.0` may need a one-off manual `npm publish --provenance`. To have CI run on the release PR, give release-please a personal access token instead of the default `GITHUB_TOKEN`.

## Status

The code is complete and covered by unit tests and an integration suite (real `postgres:18`, PgBouncer 1.26.0 and Garage 2.4.1 in Docker). **It has not been run against a real VPS.** The integration suite verified two of the design's open assumptions: `drizzle-kit push` works through the `_session` PgBouncer alias, and Garage admin API v2 `corsRules` use the singular PascalCase field names on the wire (`AllowedOrigin`, `AllowedMethod`, `AllowedHeader`, `ExposeHeader`, `MaxAgeSeconds`; checked against 2.4.1, mapped in `toGarageCorsRule`).

Hand-off checklist before relying on it:

- Run `scripts/e2e.sh` against a disposable VPS and record the results in `docs/superpowers/research/e2e-<date>.md`.
- Re-record the Dokploy test fixtures from the live instance (see `test/fixtures/dokploy/README.md`).
- Remove the Garage `corsRules` casing caveat comment in `test/integration/stack.test.ts` (around line 189), now that the integration run has confirmed the casing.
- Decide the provider (São Paulo or Argentina), create the DNS records and B2 buckets, then run `dbm init` for real.

Items from the design spec (section 19) still unverified, to be checked by `scripts/e2e.sh` or the first real `dbm init`:

1. Dokploy response field names for every endpoint used (fixtures need re-recording from a live instance).
2. `postgres.update {memoryLimit}` yields the expected `Resources.Limits.MemoryBytes` (`docker service inspect <appName>`).
3. The `<appName>-data` volume remains after `postgres.remove` (`dbm destroy` removes it explicitly; `e2e.sh` checks for leftovers).
4. Dokploy's backup cron runs in UTC.
5. Backblaze B2 works as a Dokploy destination with `provider: "Other"` (`destination.testConnection` during `dbm init`).
6. certs-dumper output is readable by PgBouncer (uid 70) so `verify-full` connections work (the `dbm init` smoke test).
7. Swarm host-mode traffic on port 3000 is dropped by the `DOCKER-USER` rule (`nc -zv <ip> 3000` from outside must fail).
8. `vercel env add NAME production,preview` in a single call (the skill relies on it; run once to confirm).

## License

MIT. See [LICENSE](LICENSE).
