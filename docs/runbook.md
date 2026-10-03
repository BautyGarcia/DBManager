# Runbook

Step-by-step procedures. None of them has been exercised on a real VPS yet; `scripts/e2e.sh` covers create, pause, resume, backup, restore and destroy, but not the disaster scenarios below. Treat the manual steps as untested and read them through before you need them.

Conventions: `<slug>` is the project name, `<slug_db>` is the slug with `-` replaced by `_`, `<appName>` is the Dokploy service name (`pg-<slug>-<suffix>`, shown in the Dokploy dashboard and in `~/.dbm/state.json` under `projects.<slug>.dokploy.appName`). `--json` and `--yes` are global options and can go anywhere on the command line.

## Quick reference

| Scenario | Section |
|---|---|
| Bad migration corrupted data | [Restore a dump in place](#restore-a-dump-in-place) |
| Cutover went wrong | [Roll back a cutover](#roll-back-a-cutover) |
| Take a safety dump before risky work | `dbm backup <slug>` |
| Accidental `destroy` | [Recover a destroyed project](#recover-a-destroyed-project) |
| VPS disk dies | [VPS lost](#vps-lost) |
| Garage LMDB corruption | [Garage metadata recovery](#garage-metadata-recovery) |
| Laptop lost | [Laptop lost](#laptop-lost) |
| Let's Encrypt renewal fails | [Certificate renewal](#certificate-renewal-fails) |
| Tailscale node key expired | [Tailscale key expired](#tailscale-node-key-expired) |
| `dbm init` stopped midway | [Resume init](#when-dbm-init-stops-midway) |

RPO is 24 hours by default (one dump per night, scheduled by Dokploy, whose cron runs in UTC: a minute between 06:00 and 06:24 UTC chosen per project, which is 03:00-03:24 in Buenos Aires). The host crons (`/etc/cron.d/dbm-*`) run in the host timezone instead (America/Argentina/Buenos_Aires unless `dbm init --timezone` said otherwise): the storage mirror at 06:30 and the PgBouncer certificate reload at 04:10 host-local time.

## Restore a dump in place

Use when a migration or a bug damaged data and you want yesterday's database back.

1. List the dumps (this also takes a fresh on-demand backup, which is useful as a safety copy of the damaged state):
   ```bash
   dbm backup <slug>
   ```
   Each line is `<ModTime>  <Name>`. The newest line is the safety copy you just took, i.e. the **damaged** data. Pick the Name of the last dump taken before the damage happened (for a bad migration at 14:00, the nightly dump from that morning), for example `2026-09-29T06-03-00-000Z.sql.gz`.
2. Restore that specific dump by its Name. Do **not** use `latest` here: after step 1, `latest` is the damaged safety copy. In-place restore overwrites the database, so it asks you to retype the slug (non-interactively: `--yes --confirm <slug>`):
   ```bash
   dbm restore <slug> <Name-from-step-1>
   dbm restore <slug> <Name-from-step-1> --yes --confirm <slug>      # non-interactive
   ```
   It streams the dump (`rclone cat | gunzip`) into a scratch file inside the project container, removes the extension entries from its table of contents (the app role does not own the extensions, `dbm create` installed them as the superuser), and runs `pg_restore -O --clean --if-exists --no-comments -L <list>` as the app role. The dump is a gzipped custom-format archive despite the `.sql.gz` name.
3. If `pg_restore` leaves objects behind (errors about objects that cannot be dropped), recreate the database and restore again:
   ```bash
   dbm psql <slug> --admin
   ```
   ```sql
   \c postgres
   DROP DATABASE <slug_db> WITH (FORCE);
   CREATE DATABASE <slug_db> OWNER <slug_db>_app;
   \c <slug_db>
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   ```
   (plus any extension listed under `projects.<slug>.postgres.extensions` in `~/.dbm/state.json`), then re-run step 2. The restore skips extension entries, so the extensions must exist before it runs.
4. Clone instead of overwrite when you only want to inspect old data: `dbm restore <slug> <Name> --as <staging-slug>`, then `dbm destroy <staging-slug>` when done.

## Roll back a cutover

`/dbmanager cutover` runs `dbm backup <slug>` first, so every cutover has a rollback point. Run it yourself before a manual `dbm import --replace` too. Writes made to Supabase after the snapshot are not copied, so freeze them first; a count mismatch usually means the source was still taking writes (freeze and re-run).

1. The cutover's own `dbm backup <slug>`, its first command, is the rollback point. List the dumps the way [Restore a dump in place](#restore-a-dump-in-place) does and choose the newest dump created before the `--replace` import, by its Name. Never use `latest`: running `dbm backup` again adds a fresh dump of the post-cutover state.
2. Restore it as in that section: `dbm restore <slug> <Name>`. Non-interactively: `dbm restore <slug> <Name> --yes --confirm <slug>`.
3. If the cutover stopped before Vercel (failed import or count mismatch), Vercel is untouched and only the database needs restoring. After a successful cutover, Vercel holds both sets of variables: the cutover added the dbm ones, and the Supabase ones stay until closing step 3. To roll the app back, revert the code to the pre-migration commit (it still reads the Supabase variables) and redeploy. If the old app read `DATABASE_URL` from Vercel, the cutover's `vercel env add DATABASE_URL --force` replaced it; set it back before redeploying the old code. Do not remove the Supabase variables until the dbm app is verified. The Supabase project stays unchanged throughout, so nothing there needs undoing unless you already paused it or deleted its S3 key.

## Recover a destroyed project

`dbm destroy` keeps a tombstone in `~/.dbm/state.json` and leaves the off-site dumps in the dumps bucket for 30 days. If `--purge-storage` was not used, the bucket and its objects still exist; otherwise objects are in the storage mirror under `storage/<slug>/` for 30 days after deletion.

```bash
dbm restore <slug> latest --as <slug>
```

This recreates the project (new Postgres container, new passwords, new S3 key) and loads the newest dump of the destroyed project (the final backup `destroy` took). If the bucket was kept, the new project reuses it and its objects (a new key is granted on it; the bucket was made private by `destroy`, so run `dbm storage public <slug>` again if it was public). Run `dbm env <slug>` and update Vercel, since the credentials changed. For storage, if the bucket was purged, run [the storage recovery](#recover-storage-objects) for `<slug>`.

If the restore fails after the project was recreated, fix the cause and re-run the same command: it restores into the recreated project from the destroyed project's dumps without creating anything again.

Do **not** run `dbm create <slug>` before recovering: creating the slug again discards the tombstone, and from then on `dbm restore <slug> ...` uses the new project's dumps. (The old dumps stay in the dumps bucket under the old appName for 30 days; restoring them then means re-adding the tombstone by hand, as in [VPS lost](#vps-lost) step 4.)

If `destroy` failed halfway, the project is still in state and nothing was tombstoned: fix the cause named in the error and re-run `dbm destroy <slug>`. Steps that already completed are reported as `already gone` and skipped; if the backup schedule was already removed, the final backup is skipped with a warning. PgBouncer routing for it is already removed.

## VPS lost

A single-command `dbm recover` does not exist yet (future work). The documented path is manual. You need: your `~/.dbm` backup, the B2 buckets, and the DNS/Tailscale prerequisites from the README. Expect roughly an hour.

1. Copy `~/.dbm/state.json` somewhere safe. Provision a new Ubuntu 24.04 VPS, point `db.`, `s3.` and `*.web.` DNS at its new IP, and generate a new Tailscale auth key (remove the old node from the Tailscale admin console first so the hostname is free).
2. Run `dbm init <new-ip> --domain <domain>` with the same B2 buckets. `init` records the host it bootstrapped in `~/.dbm/init-progress.json`; because the host differs it prints `host changed: starting init from scratch` and runs every step again. (If the new VPS reuses the old IP or hostname, delete `~/.dbm/init-progress.json` first, otherwise every step is skipped as done.) This overwrites `~/.dbm/config.json` and creates a fresh Dokploy, PgBouncer and Garage.
3. **Right after init, disable the storage mirror** until storage is re-hydrated, so the nightly `rclone sync` of the new, empty Garage does not start deleting the off-site mirror (it deletes at most 50 objects per run, but none is the goal):
   ```bash
   ssh root@<host> mv /etc/cron.d/dbm-storage-sync /root/dbm-storage-sync.disabled
   ```
4. The old projects still appear in `state.json` with Dokploy ids that no longer exist, so `dbm restore` would refuse to create them. Convert each project into a tombstone by editing `state.json`: remove `projects.<slug>` and add, under a top-level `destroyed` object, an entry `"<slug>": { "slug": "<slug>", "appName": "<old appName>", "pgMajor": <17|18>, "extensions": [...], "memoryBytes": <n>, "destroyedAt": "<ISO timestamp>" }`, copying the values from the project entry you removed. `appName` must be the **old** value: the dumps live under it. Remove any entry created by the smoke test.
5. For each project:
   ```bash
   dbm restore <slug> latest --as <slug>
   ```
6. Re-hydrate storage with `scripts/recover-storage.sh` ([below](#recover-storage-objects)), then re-enable the mirror:
   ```bash
   ssh root@<host> mv /root/dbm-storage-sync.disabled /etc/cron.d/dbm-storage-sync
   ```
7. `dbm env <slug>` for every project, update Vercel (passwords and S3 keys are new), redeploy, run `dbm doctor`.

Garage metadata does not need restoring in this scenario: buckets and keys are recreated by `create`, and the objects come back from the storage mirror.

## Recover storage objects

The nightly mirror (`/etc/cron.d/dbm-storage-sync`) copies every Garage bucket the read-only `dbm-backup` key can see to `b2:<storage-bucket>/storage/<slug>/`, and Garage metadata snapshots to `garage-meta/`. It is an `rclone sync` capped at 50 deletions per run (`--max-delete 50`): objects missing from Garage are deleted from the mirror (B2 keeps deleted versions 30 days). To copy objects back into a freshly created bucket:

0. Disable the mirror for the duration of the recovery, so a nightly run cannot delete mirror objects that are not back in Garage yet:
   ```bash
   ssh root@<host> mv /etc/cron.d/dbm-storage-sync /root/dbm-storage-sync.disabled
   ```
1. The `garage:` remote in `/etc/dokploy/dbm/rclone/rclone.conf` uses the read-only `dbm-backup` key. Grant it write on the bucket temporarily (Garage CLI syntax; check `--help` for your version):
   ```bash
   ssh root@<host> docker exec dbm-garage /garage bucket allow --read --write <slug> --key dbm-backup
   ```
   Alternatively, edit the conf to use the project's own key from `dbm env <slug>`.
2. Run the script on the VPS (copy it there first, or pipe it through ssh):
   ```bash
   ssh root@<host> 'B2_STORAGE_BUCKET=<storage-bucket> bash -s -- <slug> <slug2>' < scripts/recover-storage.sh
   ```
3. Revoke the write grant:
   ```bash
   ssh root@<host> docker exec dbm-garage /garage bucket deny --write <slug> --key dbm-backup
   ```
4. Re-enable the mirror once every bucket is back:
   ```bash
   ssh root@<host> mv /root/dbm-storage-sync.disabled /etc/cron.d/dbm-storage-sync
   ```

## Garage metadata recovery

Symptom: `dbm-garage` crashes at start or `dbm doctor` reports Garage unhealthy, with LMDB errors in `docker logs dbm-garage`. Garage on a single node uses LMDB, which can corrupt after an unclean shutdown; `metadata_fsync = true` and a snapshot every 6 hours are the mitigations (Garage keeps the two most recent snapshots in the `dbm-garage-snapshots` volume, and the nightly cron copies them off-site to `garage-meta/`).

Follow Garage's "Replacement scenario 3: corrupted metadata" (https://garagehq.deuxfleurs.fr/documentation/operations/recovering/) and check the exact paths for your Garage version first. In outline:

1. Disable the storage mirror (`mv /etc/cron.d/dbm-storage-sync /root/dbm-storage-sync.disabled`) so it cannot sync a half-recovered Garage over the off-site copy; re-enable it (`mv` back) after step 6. Then stop the container: `docker stop dbm-garage` (it is a Dokploy compose service; if Dokploy restarts it, stop it from the dashboard instead).
2. Find the volume paths: `docker volume inspect dbm-garage-meta dbm-garage-snapshots`.
3. Move the corrupted metadata database aside (do not delete it) and copy the newest snapshot from the snapshots volume into the metadata volume as Garage's doc describes. If the local snapshots are also bad, fetch `garage-meta/` from the storage bucket with rclone into the snapshots volume first.
4. Start the container and check `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3903/health` on the VPS returns 200.
5. Run the repair steps from Garage's doc (a table repair, and a block repair if objects are missing), then `dbm doctor`.
6. Anything written since the snapshot (up to 6 hours of bucket and key changes) is lost from metadata. Compare `dbm list` storage counts and, if keys or buckets are missing, recreate them or restore objects from the mirror.

## Laptop lost

1. Restore `~/.dbm/` from your backup. If you have it, you are done; run `dbm doctor`.
2. If not, rotate everything: get SSH access with a new key through the provider console, create a new Dokploy API key in the dashboard (Settings, Profile, API/CLI, rate limit off), mint a new Garage scoped admin token on the VPS, and reset every project's app password with `dbm psql <slug> --admin` (a `dbm rotate` command is future work). There is no command that rebuilds `state.json`; you must reconstruct it by hand from Dokploy, Postgres and Garage, which is painful. Keep backups of `~/.dbm/`.
3. Revoke the old credentials, as in [docs/security.md](security.md#if-dbm-leaks-or-the-laptop-is-lost).

## Certificate renewal fails

Traefik renews the `db.<domain>` certificate; `dbm-certs-dumper` republishes it into `/etc/dokploy/dbm/certs`; the 04:10 host-local cron (`/etc/cron.d/dbm-pgbouncer-reload`) fixes ownership and reloads PgBouncer. `dbm doctor` warns below 14 days of validity. PgBouncer keeps serving the old certificate until it expires, and `verify-full` clients only fail after that.

1. `dbm doctor` to see the certificate state and whether the served certificate matches the dumped file.
2. Check Traefik can still solve HTTP-01: DNS for `db.<domain>` must resolve to the VPS and port 80 must be reachable. Look at Traefik's logs in the Dokploy dashboard.
3. Check the dumper: `docker logs dbm-certs-dumper` and `ls -l /etc/dokploy/dbm/certs/db.<domain>/`.
4. Force a reload now: [manual PgBouncer reload](#manual-pgbouncer-reload).

## Tailscale node key expired

The Dokploy dashboard and API become unreachable (every `dbm` command that needs Dokploy will fail); SSH on the public IP still works, as do running databases. `dbm doctor` warns 14 days ahead.

```bash
ssh root@<host> tailscale up        # prints a login URL, or add --auth-key=<new single-use key>
```

Then disable key expiry for the VPS in the Tailscale admin console so it does not recur.

## When `dbm init` stops midway

Progress is checkpointed after each step in `~/.dbm/init-progress.json`; the file holds the target host, the completed steps and the intermediate values (including secrets, which are cleared when init completes; only the host is kept). Running `init` against a different host discards the file's progress and starts from scratch. Steps: harden, tailscale, dokploy, apikey, project, garage, pgbouncer, destination, config, smoke.

- Re-run the exact same command: completed steps print `skip <name> (done)` and it resumes at the first incomplete one. Every step is idempotent.
- Flags you do not pass again are prompted for if the step needs them.
- If it says `init state is missing <key>`, delete `~/.dbm/init-progress.json` to start over; steps are idempotent, so re-running on the same VPS converges.
- If `smoke` fails, it destroys `dbm-smoke` and reports the original error; fix the cause (DNS, certificate not issued yet, B2 credentials) and re-run.
- `init` finishes by printing two checks the host cannot run itself. From a machine outside the tailnet:
  ```bash
  nc -zv -w3 <vps-ip> 3000       # must FAIL (dashboard hidden)
  nc -zv -w3 db.<domain> 6432    # must succeed
  ```
  `dbm doctor` prints the same two lines. If port 3000 answers, the `DOCKER-USER` rule is not effective: stop and fix it before storing anything (see the `BEGIN DBM DOCKER-USER` block in `/etc/ufw/after.rules` and `sudo iptables -S DOCKER-USER`).

## Manual PgBouncer reload

PgBouncer config is rendered only from state; never edit it by hand. To re-render, upload and reload:

```bash
dbm sync-pgbouncer
```

To only reload (re-reads the ini, the userlist, and the certificate files):

```bash
ssh root@<host> docker kill -s HUP dbm-pgbouncer
```

A reload does not drop client connections. `dbm doctor` reports drift between the rendered files and the files on the VPS.

## Reading Dokploy backup logs

- Dokploy dashboard: open the project's Postgres service, Backups tab, for the schedule, last run and logs. `dbm backup <slug>` runs a manual backup and prints the resulting dump list.
- Dumps land at `<appName>/db/<slug>/<timestamp>.sql.gz` in the dumps bucket. `dbm doctor` fails a project whose newest dump is older than 36 hours (projects created less than 36 hours ago are reported ok: no backup is expected yet).
- Dokploy's cron runs in UTC; `dbm` schedules each project at `<minute> 6 * * *` with the minute in 0-24 chosen per slug (06:00-06:24 UTC, 03:00-03:24 in Buenos Aires).
- If a destination test fails during `init` or a backup fails with a B2 error, the rclone error is shown by Dokploy; check the bucket name, region/endpoint (`https://s3.<region>.backblazeb2.com`) and that the application key covers the bucket with Read and Write. Dokploy's `additionalFlags` field can add rclone flags if needed.

## Upgrading component versions

Images are pinned in `src/core/compose.ts` (`IMAGES`): PgBouncer `edoburu/pgbouncer:v1.26.0-p0`, Garage `dxflrs/garage:v2.4.1`, certs-dumper, rclone. Postgres versions are chosen per project (`--pg 17|18`).

1. Read the upstream release notes; for PgBouncer and Garage, check for CVEs and config changes. `dbm doctor` fails below PgBouncer 1.26 and Postgres 18.6 / 17.11, and below Dokploy 0.30.0.
2. Bump the pinned tag in `src/core/compose.ts`, run `npm run test:unit` and `npm run test:integration` (which runs the pinned PgBouncer and Garage images; update `test/compose/compose.yaml` to match).
3. Release or run the new `dbm` locally, then redeploy the compose service from the Dokploy dashboard (the compose file stored in Dokploy is the one rendered at `dbm init` time; update it there to the new tag, or recreate it). Redeploying PgBouncer causes a brief connection drop; do it in a quiet window and run `dbm sync-pgbouncer` afterwards.
4. For Garage, take a metadata snapshot first (`docker exec dbm-garage /garage meta snapshot`) and read the migration notes for the minor/major.
5. For Postgres minor updates, change the image tag of the project's service in the Dokploy dashboard and redeploy; take `dbm backup <slug>` first.
6. Run `dbm doctor`.
