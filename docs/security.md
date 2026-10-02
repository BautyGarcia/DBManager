# Security model

## Threat model

In scope: internet attackers scanning public ports; leaked credentials for one project; a compromised operator laptop; a dead or compromised VPS. Out of scope: hostile co-tenants (every project belongs to the operator).

None of this has been exercised on a real VPS yet; controls marked "verified in integration tests" were checked against real containers, the rest are to be verified by `scripts/e2e.sh` and the first real `dbm init`.

## Controls by surface

| Surface | Control |
|---|---|
| Browser | Never holds database credentials. All data access is server-side, which removes the RLS-misconfiguration class of bugs. |
| PgBouncer :6432 (public) | TLS required, Let's Encrypt certificate, clients use `sslmode=verify-full`; SCRAM-SHA-256 on both sides; 32-character random passwords; app roles are `NOSUPERUSER NOCREATEDB NOCREATEROLE`; `client_login_timeout 15`; PgBouncer pinned to 1.26.0 (fixes an unauthenticated remote crash via SCRAM). Supabase exposes its pooler publicly with SSL optional by default; this is stricter. |
| Garage :443 via Traefik (public) | Signed requests only; per-project key scoped to one bucket with read and write, no owner; buckets private unless `dbm storage public`; admin API on host loopback only (`127.0.0.1:3903`); the CLI uses a scoped admin token, the master token stays in the compose env on the VPS. |
| Garage web endpoint (public per bucket) | Only for buckets explicitly made public; no directory listing. |
| Postgres :5432 | Not published. Reachable only on the Docker overlay network. |
| Dokploy dashboard and API :3000 | Dropped in `DOCKER-USER` for internet-originated traffic; reachable on the tailnet only (`tailscale serve` HTTPS). 2FA enabled on the account. The API key is organization-wide: stored 0600, never in argv, never in the repo. |
| SSH :22 (public) | Key-only, `PermitRootLogin prohibit-password`, sshd's default `MaxAuthTries` (6; use `IdentitiesOnly yes` if your agent holds many keys), `fail2ban` (1 hour ban, incremental). Kept public rather than tailnet-only to avoid lockout if Tailscale fails. |
| OS | Ubuntu 24.04, `unattended-upgrades` security-only with a 04:30 reboot window, ufw default deny, Docker log rotation. |
| Secrets at rest (VPS) | The Dokploy database holds service env; PgBouncer `userlist.txt` holds SCRAM verifiers, not plaintext; the Garage master token only lives in the compose env; Traefik dynamic files contain no secrets. |
| Secrets at rest (laptop) | `~/.dbm/` is 0700/0600, the same model as `~/.aws/credentials`. State is not encrypted so that agents can use it. |
| Secrets in transit to the VPS | Secrets, SQL and file contents travel on stdin, never in remote argv. |
| Backups | TLS in transit; SSE-B2 at rest; a different provider from the VPS; bucket-scoped keys; 30-day provider-enforced retention. |
| Supply chain | Images pinned to explicit tags; npm dependencies pinned exactly; npm publish through OIDC trusted publishing with provenance, no long-lived token. |

Connection strings use `sslmode=verify-full`. `sslmode=require` is never used in app-facing strings: postgres.js maps it to `rejectUnauthorized: false`, i.e. no verification.

Verified in integration tests: SCRAM login through PgBouncer with a locally computed verifier, session and transaction alias routing, prepared statements through transaction mode, `drizzle-kit push` through the `_session` alias, Garage bucket, key and CORS management, presigned PUT and GET. Not yet verified on a real host: the `DOCKER-USER` rule dropping port 3000, certificate hand-off to PgBouncer, hardening script behavior.

## Residual risks

- Containers share one kernel and one Docker daemon. Acceptable because all tenants are the operator; not acceptable for hosting untrusted third parties.
- A single VPS is a single point of failure. Mitigation is backups and provider snapshots, not high availability. The nightly reboot window causes about a minute of PgBouncer outage.
- Backups are encrypted by the provider, not client-side. Client-side encryption is future work.
- No brute-force protection on 6432 beyond SCRAM and long random passwords. Shipping PgBouncer logs to a fail2ban jail is future work.
- The operator laptop holds every credential (`~/.dbm`).
- The Dokploy API key is organization-wide; there is no per-project scoping.

## If a project's connection string leaks

`dbm rotate` is future work, so rotation is manual. Do this for the affected `<slug>` (database name `<slug_db>` is the slug with `-` replaced by `_`, app role `<slug_db>_app`):

1. Set a new app password as the superuser:
   ```bash
   dbm psql <slug> --admin
   ```
   ```sql
   ALTER ROLE <slug_db>_app PASSWORD 'a-new-long-random-password';
   SELECT rolpassword FROM pg_authid WHERE rolname = '<slug_db>_app';   -- the SCRAM verifier
   ```
   Use an alphanumeric password to keep URL encoding trivial. Terminate existing sessions if you need them gone immediately: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '<slug_db>_app';`
2. Edit `~/.dbm/state.json` (a backup copy `state.json.bak.<ts>` is not made for manual edits; copy it first): in `projects.<slug>.postgres` set `appPassword` to the new password and `appScramVerifier` to the `rolpassword` value from step 1.
3. Re-render PgBouncer from state and reload it:
   ```bash
   dbm sync-pgbouncer
   ```
   Until this runs, PgBouncer still holds the old verifier and rejects the new password (and still accepts the old one).
4. `dbm env <slug>` now prints the new `DATABASE_URL` and `DATABASE_URL_SESSION`. Update them everywhere (`.env.local`, Vercel) and redeploy.
5. If the leaked material also included S3 keys, rotate those too: create a new key in Garage, `AllowBucketKey` it on the bucket, update state `storage.keyId` and `storage.keySecret`, then delete the old key through the Garage admin API on the VPS. There is no CLI command for this yet.
6. Check `dbm psql <slug> --admin` with `SELECT * FROM pg_stat_activity` and the PgBouncer logs (`docker logs dbm-pgbouncer`) for connections you do not recognize.

## If `~/.dbm` leaks (or the laptop is lost)

`~/.dbm` contains the Dokploy API key, every project's database passwords and S3 keys, and the Garage scoped admin token.

1. Revoke the Dokploy API keys in the Dokploy dashboard (Settings, Profile, API/CLI). Both the `dbm` key and the one you pasted during `dbm init`.
2. Delete the Garage scoped admin token on the VPS. The Garage CLI is available inside the container, for example `docker exec dbm-garage /garage admin-token list` then `docker exec dbm-garage /garage admin-token delete <id>` (check `/garage admin-token --help` on your version).
3. Rotate every project's app password as in the section above, and every project's S3 key.
4. Replace the SSH key: add a new key to `/root/.ssh/authorized_keys` through the provider console and remove the old one.
5. If the Tailscale auth key or machine was exposed, remove the node from the Tailscale admin console and re-run `tailscale up` on the VPS with a new single-use key.
6. Keep the rotated `~/.dbm` in an encrypted backup. No command regenerates `state.json`; losing it means resetting each project's passwords by hand.
7. If the laptop was compromised rather than just lost, also rotate the B2 application keys and the Vercel environment variables.
