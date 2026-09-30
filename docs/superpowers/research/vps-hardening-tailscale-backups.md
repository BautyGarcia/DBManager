# VPS hardening, Tailscale, off-site backups, providers — research for `dbm init`

Date checked: 2026-09-30. Scope: spec sections 3, 5.5, 7 (init), 9, 10, 12 of `docs/superpowers/specs/2026-09-30-db-manager-design.md`.

## Summary

- Use **Ubuntu 24.04 LTS**, not 26.04: 26.04.1 exists (Aug 2026) and Docker/Tailscale publish `resolute` repos, but Dokploy's install script has an **open regression on 26.04** (Docker 28.5.0 pin, issue #5471, opened 2026-09-16) and 26.04 is not on Dokploy's tested-OS list.
- Docker bypasses ufw (nat DNAT before ufw's INPUT). The correct fix is filtering in the **`DOCKER-USER`** chain, persisted through `/etc/ufw/after.rules` (the `ufw-docker` pattern). Dokploy publishes 3000 as a Swarm **host-mode** port and Traefik as plain `docker run -p 80/443`; Swarm cannot bind a published port to 127.0.0.1, so 3000 must be blocked in `DOCKER-USER` (or unpublished entirely).
- `tailscale serve --bg --https=443 http://127.0.0.1:3000` persists across reboots and gives `https://<host>.<tailnet>.ts.net`; it requires HTTPS certificates enabled in the admin console (MagicDNS on by default). Host-originated proxy traffic never traverses `DOCKER-USER`, so blocking 3000 publicly does not break `serve`.
- Ubuntu 24.04 cloud images ship `/etc/ssh/sshd_config.d/50-cloud-init.conf` with `PasswordAuthentication yes`; because sshd uses first-value-wins and `Include` runs first, the hardening drop-in must sort before it (`00-…`) and that file should be removed.
- Backblaze B2: endpoint `https://s3.<region>.backblazeb2.com`, $6.95/TB-month since 2026-05-01, API calls free, egress free up to 3x stored, first 10 GB free. Lifecycle for "delete after 30 days" = `daysFromUploadingToHiding: 30, daysFromHidingToDeleting: 1` (via S3 API, `Expiration` only **hides**; pair with `NoncurrentVersionExpiration`). SSE-B2 must be enabled per bucket at creation.
- Dokploy backups run `pg_dump -Fc --no-acl --no-owner … | gzip` and upload with `rclone rcat` (S3 backend, `--s3-force-path-style --s3-no-check-bucket`), which works with a bucket-restricted B2 key.
- Providers: DonWeb (Argentina, ARS, Ubuntu 22.04/24.04/26.04 images, 2 free snapshots) 4 vCPU/8 GB compute ≈ ARS 28,267/mo list + storage/transfer; Vultr São Paulo 4 vCPU/8 GB/160 GB = USD 40/mo (API-verified); Hostinger São Paulo KVM 2 (2 vCPU/8 GB) USD 8.99 promo. DigitalOcean and Hetzner have no South America region. Buenos Aires↔São Paulo ≈ 30 ms; a São Paulo VPS is closer to Vercel `gru1` than any Argentine DC.
- Monitoring: HetrixTools free (15 monitors, 1-min, port checks) or UptimeRobot free (50 monitors, 5-min, port checks); Uptime Kuma only if you already have a second machine.

## Verified facts

Each bullet: claim — source — checked 2026-09-30.

**Ubuntu / Dokploy OS support**
- Ubuntu 26.04.1 LTS server ISO (`ubuntu-26.04.1-live-server-amd64.iso`) published 2026-08-26 — https://releases.ubuntu.com/26.04/
- 26.04 LTS release "Apr 2026", standard support to May 2031; 24.04 to May 2029 — https://ubuntu.com/about/release-cycle
- Docker apt repo has a `resolute` dist — https://download.docker.com/linux/ubuntu/dists/
- Tailscale packages list Ubuntu 26.04 (resolute) — https://pkgs.tailscale.com/stable/
- Dokploy tested OS list: Ubuntu 24.04/23.10/22.04/20.04/18.04, Debian 10–12, Fedora 40, CentOS 8/9 (no 26.04); needs ports 80, 443, 3000 free — https://docs.dokploy.com/docs/core/installation
- Dokploy issue #4501 (2026-05-28): install fails on 26.04 because `install.sh` pins Docker 28.5.0 and the 26.04 repo only has ≥29.3; closed via PR #4660 — https://github.com/Dokploy/dokploy/issues/4501
- Dokploy issue #5471 (2026-09-16, v0.30.6): regression, 26.04 installer again requests Docker 28.5.0; **open** — https://github.com/Dokploy/dokploy/issues/5471
- `install.sh`: requires root and Linux; checks 80/443/3000 with `ss -tulnp`; installs Docker via `get.docker.com` pinned `DOCKER_VERSION="28.5.0"` if absent; `docker swarm init --advertise-addr`; Dokploy `docker service create … --publish published=3000,target=3000,mode=host`; Traefik via `docker run -p 80:80/tcp -p 443:443/tcp -p 443:443/udp` on `dokploy-network`; **no daemon.json, log-opts or firewall changes** — https://dokploy.com/install.sh

**sshd**
- `PermitRootLogin` values `yes|prohibit-password|forced-commands-only|no`, default `prohibit-password`; `KbdInteractiveAuthentication` (alias of deprecated `ChallengeResponseAuthentication`) default yes; "for each keyword, the first obtained value will be used" — https://man.openbsd.org/sshd_config
- Ubuntu 24.04: cloud-init writes `/etc/ssh/sshd_config.d/50-cloud-init.conf` containing `PasswordAuthentication yes`, which overrides `sshd_config`; openssh 1:9.9p1-3ubuntu2 only improved comments — https://bugs.launchpad.net/bugs/2088207

**unattended-upgrades**
- Files `/etc/apt/apt.conf.d/50unattended-upgrades` and `20auto-upgrades`; options `Automatic-Reboot`, `Automatic-Reboot-Time "hh:mm"`, `Automatic-Reboot-WithUsers`; run by `apt-daily.timer`/`apt-daily-upgrade.timer`; test with `unattended-upgrade -v --dry-run` — https://ubuntu.com/server/docs/how-to/software/automatic-updates/
- Ubuntu template default `Allowed-Origins`: `${distro_id}:${distro_codename}`, `-security`, `ESMApps:…-apps-security`, `ESM:…-infra-security`; `-updates` commented out (i.e. default is security-only); defaults `Remove-Unused-Kernel-Packages "true"`, `Remove-Unused-Dependencies "false"`, `Automatic-Reboot "false"`, `Automatic-Reboot-Time "02:00"` (commented) — https://git.launchpad.net/ubuntu/+source/unattended-upgrades/plain/data/50unattended-upgrades.Ubuntu

**Docker + ufw / DOCKER-USER**
- "Docker and ufw use firewall rules in ways that make them incompatible… traffic to and from that container gets diverted before it goes through the ufw firewall settings" — https://docs.docker.com/engine/network/packet-filtering-firewalls/
- `DOCKER-USER` is "a placeholder for user-defined rules that will be processed before rules in the DOCKER-FORWARD and DOCKER chains"; FORWARD jumps unconditionally to `DOCKER-USER`, `DOCKER-FORWARD`, `DOCKER-INGRESS`; packets in `DOCKER-USER` are already DNAT'ed so match originals with `-m conntrack --ctorigdstport`; restrict with `iptables -I DOCKER-USER -i ext_if ! -s 192.0.2.0/24 -j DROP` — https://docs.docker.com/engine/network/firewall-iptables/
- `ufw-docker`: `/etc/ufw/after.rules` block declaring `:DOCKER-USER - [0:0]` and `:ufw-user-forward`, `ufw route allow proto tcp from any to any port 80`, swarm support via `ufw-docker service allow` — https://github.com/chaifeng/ufw-docker
- dockerd `--ip` / daemon.json `"ip"`: "Host IP for port publishing from the **default bridge network** (default 0.0.0.0)" — not applicable to Swarm host-mode or overlay — https://docs.docker.com/reference/cli/dockerd/
- Swarm published ports cannot be bound to a specific IP (community/forum consensus; see Unverified) — https://forums.docker.com/t/bind-port-address-to-single-ip/43173
- Dokploy discussion #879: maintainer method to remove public 3000 is `docker service update dokploy --publish-rm published=3000,target=3000,mode=host`; persists across updates; binding to 127.0.0.1 not supported — https://github.com/Dokploy/dokploy/discussions/879
- Dokploy Tailscale guide: access `http://<tailscale-ip>:3000` or `http://<name>.<tailnet>.ts.net:3000`; `ufw allow in on tailscale0`; warns Docker bypasses ufw for 3000/80/443 and suggests provider firewall — https://docs.dokploy.com/docs/core/guides/tailscale

**fail2ban**
- Upstream defaults `bantime = 10m`, `findtime = 10m`, `maxretry = 5`, `backend = auto`; `[sshd]` modes `normal|ddos|extra|aggressive`; customise in `jail.local` or `jail.d/*.local` — https://raw.githubusercontent.com/fail2ban/fail2ban/master/config/jail.conf
- Ubuntu 24.04 fail2ban 1.0.2 broke on Python 3.12 (`No module named 'asynchat'`); fixed in `1.0.2-3ubuntu0.1` (noble-updates) — https://bugs.launchpad.net/ubuntu/+source/fail2ban/+bug/2055114

**Tailscale**
- Install: `curl -fsSL https://tailscale.com/install.sh | sh`; then `tailscale up` — https://tailscale.com/kb/1031/install-linux
- Manual apt (noble): keyring to `/usr/share/keyrings/tailscale-archive-keyring.gpg`, list `deb https://pkgs.tailscale.com/stable/ubuntu noble main` — https://pkgs.tailscale.com/stable/ ; https://pkgs.tailscale.com/stable/ubuntu/noble.list
- Auth keys: Settings → Keys → Generate auth key; options reusable, ephemeral (device removed when offline), pre-approved, tags; expiry 1–90 days; `tailscale up --auth-key=tskey-…` — https://tailscale.com/kb/1085/auth-keys
- OAuth client secret usable directly: `tailscale up --auth-key='${OAUTH_CLIENT_SECRET}?ephemeral=false&preauthorized=true' --advertise-tags=tag:…` — https://tailscale.com/kb/1215/oauth-clients
- Serve: `tailscale serve --bg --https=443 localhost:3000` → `https://<node>.<tailnet>.ts.net/`; "If you use the tailscale serve command with the --bg flag, it runs persistently in the background"; resumes after reboot; `tailscale serve status`, `tailscale serve reset` — https://tailscale.com/kb/1242/tailscale-serve ; https://tailscale.com/docs/reference/tailscale-cli/serve
- "Tailscale Serve requires you to enable HTTPS certificates in your tailnet" — https://tailscale.com/kb/1312/serve
- Enable HTTPS: DNS page → HTTPS Certificates → Enable HTTPS (MagicDNS prerequisite; machine names go into public CT logs) — https://tailscale.com/kb/1153/enabling-https
- MagicDNS on by default for tailnets created after 2022-10-20; FQDN `machine.tailnet.ts.net` — https://tailscale.com/kb/1081/magicdns
- Firewall: UDP 41641 inbound is optional (helps direct connections; otherwise DERP relay) — https://tailscale.com/kb/1082/firewall-ports
- Tailscale SSH: `tailscale set --ssh`; needs an ACL `ssh` rule; Linux server only — https://tailscale.com/kb/1193/tailscale-ssh

**Backblaze B2**
- Endpoint `https://s3.<region>.backblazeb2.com`, regions like `us-west-004`, `eu-central-003`, `us-east-005`; path-style and virtual-hosted both supported; HTTPS only; SigV4 only — https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api
- Pricing: $6.95/TB-month, egress free up to 3x average monthly storage then $0.01/GB, Class A/B/C API calls free, first 10 GB free, no minimum duration — https://www.backblaze.com/cloud-storage/pricing ; increase from $6 effective 2026-05-01 — https://forum.rclone.org/t/backblaze-b2-is-raising-prices/41857
- Lifecycle native fields `fileNamePrefix`, `daysFromUploadingToHiding`, `daysFromHidingToDeleting`, `daysFromStartingToCancelingUnfinishedLargeFiles`; UI presets "Keep only the last version" = `{daysFromHidingToDeleting:1, daysFromUploadingToHiding:null}` — https://www.backblaze.com/docs/cloud-storage-lifecycle-rules
- S3 lifecycle API: `Expiration/Days` **hides** current version; `NoncurrentVersionExpiration/NoncurrentDays` **deletes**; `Date`, `Transition`, tag filters unsupported — https://www.backblaze.com/apidocs/s3-put-lifecycle-configuration ; https://www.backblaze.com/blog/a-deeper-look-at-s3-compatible-lifecycle-rules-in-backblaze-b2/
- SSE-B2 (AES-256, Backblaze-managed) vs SSE-C (customer key, per-object, no bucket default); no extra cost; existing objects not retro-encrypted — https://www.backblaze.com/docs/cloud-storage-server-side-encryption ; https://www.backblaze.com/docs/cloud-storage-enable-encryption-on-a-bucket
- S3 `PutBucketEncryption` supported with `SSEAlgorithm AES256`, needs `writeBucketEncryption` — https://www.backblaze.com/apidocs/s3-put-bucket-encryption
- App key: B2 Cloud Storage → Application Keys → Add a New Application Key → name, "Allow access to Bucket(s)", Read and Write / Read Only / Write Only, optional prefix, optional expiry (max 1000 days); `applicationKey` shown once — https://www.backblaze.com/docs/cloud-storage-create-and-manage-app-keys
- Bucket-restricted keys: `b2_list_buckets` must include the bucket id/name — https://www.backblaze.com/docs/cloud-storage-application-keys
- Dokploy B2 destination: endpoint `https://s3.<region>.backblazeb2.com`, region code, bucket name, Access Key/Secret Key from a Read & Write app key — https://docs.dokploy.com/docs/core/backblaze-b2
- Dokploy backup command: `pg_dump -Fc --no-acl --no-owner -h localhost -U "$DB_USER" --no-password "$DB_NAME" | gzip`, uploaded via `rclone rcat` with `--s3-access-key-id --s3-secret-access-key --s3-region --s3-endpoint --s3-provider --s3-no-check-bucket --s3-force-path-style` — https://raw.githubusercontent.com/Dokploy/dokploy/canary/packages/server/src/utils/backups/utils.ts
- rclone native `b2` backend: `account` = keyID, `key` = applicationKey; deletes hide unless `--b2-hard-delete`; SHA1 verified — https://rclone.org/b2/

**Alternatives**
- Cloudflare R2: $0.015/GB-month standard, Class A $4.50/M, Class B $0.36/M, free egress, free tier 10 GB + 1M A + 10M B; lifecycle and bucket encryption ops listed — https://developers.cloudflare.com/r2/pricing/
- Hetzner Object Storage: €6.49/mo (USD 7.99) base incl. 1 TB storage + 1 TB egress; extra €6.26/TB storage, €1/TB egress; FSN1/NBG1/HEL1 only — https://www.hetzner.com/storage/object-storage/ (values read from the page's embedded price JSON)
- Wasabi: from $7.99/TB-month, no egress/API fees; 1 TB minimum and 90-day minimum retention (third-party summaries; see Unverified) — https://wasabi.com/pricing

**Providers / latency**
- Vultr API: `vc2-4c-8gb` 4 vCPU/8 GB/160 GB/4 TB = **$40/mo**, `vhp-4c-8gb-amd|intel` 4 vCPU/8 GB/180 GB/6 TB = **$48/mo**, both available in `sao` (São Paulo) and `scl` (Santiago) — https://api.vultr.com/v2/plans ; https://api.vultr.com/v2/regions
- Vultr snapshots $0.05/GB-month; automatic backups +20% of instance price — https://docs.vultr.com/support/platform/billing/does-vultr-charge-for-stored-snapshots
- Hostinger KVM 1/2/4/8: 1/4 GB $6.49→$11.99; **2 vCPU/8 GB/100 GB $8.99→$14.99**; 4 vCPU/16 GB/200 GB $12.99→$28.99; weekly backups + manual snapshots; public API — https://www.hostinger.com/vps-hosting ; São Paulo DC — https://www.hostinger.com/blog/brazilian-vps-data-center/
- DigitalOcean: no South America region — https://docs.digitalocean.com/platform/regional-availability/ ; Hetzner: EU, US, Singapore only — https://www.hetzner.com/ (per search summary)
- DonWeb (ex-Dattatec, Rosario): `dattatec.com` 301-redirects to `donweb.com`; Cloud Server components priced in ARS (embedded JSON on https://donweb.com/es-ar/hosting-cloud-servers-vps): `vcpu_4_ram_8` = **ARS 28,267.00/mo list** (promo discount shown ARS 8,480.10; IVA listed separately), `vcpu_4_ram_16` = ARS 39,260, SSD storage ARS 103.74/GB-mo, 1 TB transfer ARS 2,588; images include Ubuntu 22.04, 24.04 UEFI, **26.04 UEFI**; full root; up to 2 free snapshots (kept 90 days); Argentina datacenters — https://donweb.com/es-ar/hosting-cloud-servers-vps ; snapshots — https://soporte.donweb.com/hc/es/articles/22966127419028
- WNPower "VPS 8GB": 4 cores/8 GB/75 GB NVMe + 100 GB secondary, ARS 149,500 list / 104,650 promo, cPanel bundled, root available, **datacenter "North America"**, IVA 21% extra — https://www.wnpower.com/hosting-cloud-vps/
- Latency from Buenos Aires: São Paulo ≈ 30.7 ms, Santiago ≈ 22.5 ms, Miami ≈ 134.7 ms, Washington ≈ 141.6 ms — https://wondernetwork.com/pings/Buenos%20Aires
- Vercel `gru1` = `sa-east-1`, São Paulo; default function region `iad1` — https://vercel.com/docs/regions

**Docker hygiene**
- Default `json-file` driver performs **no rotation** by default; daemon.json `log-driver`/`log-opts` (`max-size`, `max-file`); changes affect only new containers; `local` driver rotates by default — https://docs.docker.com/engine/logging/configure/
- `local` driver defaults: `max-size 20m`, `max-file 5`, compression on — https://docs.docker.com/engine/logging/drivers/local/
- `live-restore` "only pertains to standalone containers, and not to Swarm services" — https://docs.docker.com/engine/daemon/live-restore/
- Dokploy has a built-in "Docker Cleanup" server setting (image/container/builder prune) — https://docs.dokploy.com/docs/core/schedule-jobs and issues https://github.com/Dokploy/dokploy/issues/3973 (removes unused compose images)

**Monitoring**
- Better Stack free: 10 monitors, 30 s checks, 1 status page, HTTP keyword + TCP/UDP port + ping, email/Slack — https://betterstack.com/pricing
- UptimeRobot free: 50 monitors, 5-min interval, HTTP/keyword/ping/port, 1 status page, limited integrations — https://uptimerobot.com/pricing/
- HetrixTools free: 15 uptime monitors, 1-min checks, unlimited status pages, all alert channels; log in every 90 days — https://hetrixtools.com/pricing/uptime-monitor/
- Uptime Kuma: self-hosted; HTTP(s), TCP, keyword, JSON, ping, DNS, Docker, push; 90+ notifiers; `docker run -d --restart=always -p 3001:3001 -v uptime-kuma:/app/data louislam/uptime-kuma:2` — https://github.com/louislam/uptime-kuma

## Hardening script

Design notes before the code:

- Runs as root over SSH (`ssh root@host 'bash -s' < harden.sh`), Ubuntu 24.04. Every step is a function that converges to the desired state and is safe to re-run.
- **Order matters for Docker**: `daemon.json` is written *before* Dokploy installs Docker, so the first `dockerd` start already has log rotation. If Docker is already running, the script restarts it only when the file content changed (Swarm services restart; `live-restore` does not help Swarm).
- **Public port policy is enforced twice**: ufw for host sockets (22, 41641/udp) and `DOCKER-USER` for container-published ports (80/443 TCP+UDP, 6432). Port 3000 is reachable only via `tailscale0` (direct) or via `tailscale serve` (host-originated, never enters FORWARD).
- The sshd drop-in is `00-dbm.conf` so it sorts before `50-cloud-init.conf` and wins under first-value-wins; the cloud-init file is also removed. The script refuses to disable password auth if root has no `authorized_keys`.
- Reboot window `04:30` server-local time (after the 03:00 backup window). Set `TZ` explicitly; Dokploy's cron may run in UTC (see Unverified).

```bash
#!/usr/bin/env bash
# dbm init — host hardening for Ubuntu 24.04 (Docker/Dokploy host)
# Idempotent: re-running converges without side effects. Run as root.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

# ---- tunables (dbm passes these as env) -------------------------------------
: "${DBM_SSH_PORT:=22}"
: "${DBM_PUBLIC_TCP_PORTS:=80 443 6432}"     # container-published, allowed from internet
: "${DBM_PUBLIC_UDP_PORTS:=443}"             # Traefik publishes 443/udp (HTTP/3)
: "${DBM_TAILSCALE_UDP:=41641}"              # optional, helps direct WireGuard paths
: "${DBM_REBOOT_TIME:=04:30}"                # server-local time; after 03:00 backups
: "${DBM_TIMEZONE:=America/Argentina/Buenos_Aires}"
: "${DBM_F2B_IGNORE:=127.0.0.1/8 ::1 100.64.0.0/10}"   # loopback + Tailscale CGNAT range
: "${DBM_DOCKER_LOG_MAX_SIZE:=10m}"
: "${DBM_DOCKER_LOG_MAX_FILE:=3}"

log(){ printf '\033[1;34m[dbm]\033[0m %s\n' "$*"; }
write_if_changed(){ # write_if_changed <path> <mode>  (content on stdin) -> returns 0 if changed
  local path="$1" mode="$2" tmp; tmp="$(mktemp)"; cat >"$tmp"
  if [[ -f "$path" ]] && cmp -s "$tmp" "$path"; then rm -f "$tmp"; return 1; fi
  install -m "$mode" -D "$tmp" "$path"; rm -f "$tmp"; return 0
}

require_ubuntu(){
  . /etc/os-release
  [[ "$ID" == "ubuntu" ]] || { echo "Ubuntu required, got $ID" >&2; exit 1; }
  case "$VERSION_ID" in 24.04) ;; 26.04) log "WARN: 26.04 not on Dokploy tested list (issue #5471)";; *) log "WARN: untested Ubuntu $VERSION_ID";; esac
}

step_packages(){
  log "apt: base packages"
  apt-get update -qq
  apt-get install -y -qq ufw fail2ban unattended-upgrades apt-listchanges \
      ca-certificates curl gnupg jq python3 iptables >/dev/null
  timedatectl set-timezone "$DBM_TIMEZONE" || true
}

step_sshd(){
  log "sshd: key-only, no passwords, root via key only"
  if [[ ! -s /root/.ssh/authorized_keys ]]; then
    echo "refusing: /root/.ssh/authorized_keys is empty; you would be locked out" >&2; exit 1
  fi
  # cloud-init drop-in re-enables passwords and would override sshd_config (LP#2088207)
  rm -f /etc/ssh/sshd_config.d/50-cloud-init.conf
  local changed=0
  write_if_changed /etc/ssh/sshd_config.d/00-dbm.conf 0644 <<EOT && changed=1
# Managed by dbm init. Sorts first => wins (sshd uses the first value seen).
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PermitEmptyPasswords no
X11Forwarding no
MaxAuthTries 4
LoginGraceTime 30
EOT
  sshd -t                                  # validate before reloading
  if (( changed )); then systemctl reload ssh 2>/dev/null || systemctl restart ssh; fi
  # prove the effective config
  sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) ' 
}

step_unattended_upgrades(){
  log "unattended-upgrades: security-only + reboot window $DBM_REBOOT_TIME"
  # Default Allowed-Origins in 50unattended-upgrades is already security(+ESM) only;
  # we only add reboot/cleanup behaviour in a later-sorting file (later scalars win).
  write_if_changed /etc/apt/apt.conf.d/52dbm-unattended-upgrades 0644 <<EOT || true
// Managed by dbm init
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "${DBM_REBOOT_TIME}";
Unattended-Upgrade::SyslogEnable "true";
EOT
  write_if_changed /etc/apt/apt.conf.d/20auto-upgrades 0644 <<'EOT' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOT
  systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null
  unattended-upgrade -v --dry-run >/dev/null && log "unattended-upgrades dry-run OK"
}

step_docker_daemon_json(){
  log "docker: daemon.json log rotation (written before Dokploy installs Docker)"
  mkdir -p /etc/docker
  local cur='{}'; [[ -s /etc/docker/daemon.json ]] && cur="$(cat /etc/docker/daemon.json)"
  local new
  new="$(jq -S --arg s "$DBM_DOCKER_LOG_MAX_SIZE" --arg f "$DBM_DOCKER_LOG_MAX_FILE" \
        '. + {"log-driver":"json-file","log-opts":((."log-opts"//{}) + {"max-size":$s,"max-file":$f})}' <<<"$cur")"
  if printf '%s\n' "$new" | write_if_changed /etc/docker/daemon.json 0644; then
    if systemctl is-active --quiet docker; then
      log "docker: config changed, restarting dockerd (Swarm services will restart)"
      systemctl restart docker
    fi
  fi
}

step_ufw(){
  log "ufw: default deny in, allow $DBM_SSH_PORT/tcp, $DBM_TAILSCALE_UDP/udp, tailscale0"
  ufw default deny incoming  >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow "${DBM_SSH_PORT}/tcp"        >/dev/null
  ufw allow "${DBM_TAILSCALE_UDP}/udp"   >/dev/null
  ufw allow in on tailscale0             >/dev/null
  # host-level allow for the container ports too (harmless; DOCKER-USER is what actually gates them)
  for p in $DBM_PUBLIC_TCP_PORTS; do ufw allow "${p}/tcp" >/dev/null; done
  for p in $DBM_PUBLIC_UDP_PORTS; do ufw allow "${p}/udp" >/dev/null; done
  step_docker_user_rules
  ufw --force enable >/dev/null
  ufw reload >/dev/null
  ufw status verbose
}

step_docker_user_rules(){
  # Docker DNATs published ports in nat/PREROUTING, bypassing ufw INPUT. Forwarded
  # packets do hit FORWARD -> DOCKER-USER, which Docker leaves for the admin. We ship
  # the rules through ufw's after.rules so ufw re-applies them on reload/boot
  # (same mechanism as github.com/chaifeng/ufw-docker).
  local allow_tcp="" allow_udp="" p
  for p in $DBM_PUBLIC_TCP_PORTS; do allow_tcp+="-A DOCKER-USER -p tcp -m conntrack --ctstate NEW --ctorigdstport ${p} -j RETURN"$'\n'; done
  for p in $DBM_PUBLIC_UDP_PORTS; do allow_udp+="-A DOCKER-USER -p udp -m conntrack --ctstate NEW --ctorigdstport ${p} -j RETURN"$'\n'; done
  local block
  block="$(cat <<EOT
# BEGIN DBM DOCKER-USER
*filter
:ufw-user-forward - [0:0]
:DOCKER-USER - [0:0]
:dbm-docker-deny - [0:0]
-A DOCKER-USER -j ufw-user-forward
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -m conntrack --ctstate INVALID -j DROP
# tailnet may reach anything published (e.g. Dokploy :3000)
-A DOCKER-USER -i tailscale0 -j RETURN
# container-originated / inter-container traffic (bridge, gwbridge, overlay ranges)
-A DOCKER-USER -i docker0 -j RETURN
-A DOCKER-USER -i docker_gwbridge -j RETURN
-A DOCKER-USER -s 10.0.0.0/8 -j RETURN
-A DOCKER-USER -s 172.16.0.0/12 -j RETURN
-A DOCKER-USER -s 192.168.0.0/16 -j RETURN
# internet -> container: allow-list by ORIGINAL destination port (pre-DNAT)
${allow_tcp}${allow_udp}
# everything else that was DNAT'ed to a container (incl. Dokploy :3000) is dropped
-A DOCKER-USER -m conntrack --ctstate NEW -j dbm-docker-deny
-A DOCKER-USER -j RETURN
-A dbm-docker-deny -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[DBM DOCKER BLOCK] "
-A dbm-docker-deny -j DROP
COMMIT
# END DBM DOCKER-USER
EOT
)"
  local f=/etc/ufw/after.rules tmp; tmp="$(mktemp)"
  # replace existing block or append
  awk '/^# BEGIN DBM DOCKER-USER/{skip=1} !skip{print} /^# END DBM DOCKER-USER/{skip=0}' "$f" >"$tmp"
  printf '\n%s\n' "$block" >>"$tmp"
  if ! cmp -s "$tmp" "$f"; then install -m 0640 "$tmp" "$f"; log "after.rules: DOCKER-USER block updated"; fi
  rm -f "$tmp"
}

step_fail2ban(){
  log "fail2ban: sshd jail"
  write_if_changed /etc/fail2ban/jail.d/dbm-sshd.local 0644 <<EOT || true
# Managed by dbm init. Ubuntu's jail.d/defaults-debian.conf already sets backend=systemd + nftables.
[DEFAULT]
ignoreip = ${DBM_F2B_IGNORE}
bantime  = 1h
findtime = 10m
maxretry = 5
bantime.increment = true

[sshd]
enabled = true
port    = ${DBM_SSH_PORT}
mode    = normal
EOT
  systemctl enable --now fail2ban >/dev/null
  systemctl restart fail2ban
  fail2ban-client status sshd | sed -n '1,6p'
}

step_verify(){
  log "verify"
  local ext_if; ext_if="$(ip route show default | awk '{print $5; exit}')"
  echo "external interface: $ext_if"
  iptables -S DOCKER-USER 2>/dev/null | head -20 || echo "(DOCKER-USER chain appears once Docker starts)"
  echo "Post-install check from a NON-tailnet host: nc -zv -w3 <public-ip> 3000  => must FAIL"
  echo "                                            nc -zv -w3 <public-ip> 6432  => must succeed"
}

require_ubuntu
step_packages
step_sshd
step_unattended_upgrades
step_docker_daemon_json
step_ufw
step_fail2ban
step_verify
log "host hardening converged"
```

Notes on the script:
- `iptables` on Ubuntu 24.04 is the nft-backed `iptables-nft`; both ufw and Docker use it, so the chains interoperate.
- If Dokploy's `docker network` subnets are ever outside RFC1918 (custom `DOCKER_SWARM_INIT_ARGS`), add them to the `-s … -j RETURN` list.
- IPv6: Docker's IPv6 is off by default; ufw handles host IPv6 sockets. If IPv6 publishing is later enabled in Docker, mirror the block into `after6.rules`.
- `dbm doctor` should include the external `nc -zv <ip> 3000` negative test; the host cannot test its own public path.

## Tailscale steps

1. One-time, in the admin console: **DNS → MagicDNS on** (default for tailnets created after 2022-10-20) and **HTTPS Certificates → Enable HTTPS** (machine names become public in CT logs; keep the hostname non-sensitive, e.g. `dbm-vps`). Source: https://tailscale.com/kb/1153/enabling-https
2. Auth key for `dbm init`: **Settings → Keys → Generate auth key**. Recommended: *one-off* (not reusable), **not ephemeral** (an ephemeral node is deleted when it goes offline — wrong for a server), *pre-approved* if device approval is on, expiry ≤ 90 days. Alternative for automation: an OAuth client with `auth_keys` scope, used as `--auth-key='${SECRET}?ephemeral=false&preauthorized=true' --advertise-tags=tag:dbm`. Sources: https://tailscale.com/kb/1085/auth-keys , https://tailscale.com/kb/1215/oauth-clients
3. Install (idempotent, pinned repo rather than `curl | sh`):
   ```bash
   . /etc/os-release   # noble on 24.04, resolute on 26.04
   curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${VERSION_CODENAME}.noarmor.gpg" \
     | tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
   curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${VERSION_CODENAME}.tailscale-keyring.list" \
     | tee /etc/apt/sources.list.d/tailscale.list >/dev/null
   apt-get update -qq && apt-get install -y -qq tailscale
   systemctl enable --now tailscaled
   ```
   (Or the official one-liner `curl -fsSL https://tailscale.com/install.sh | sh`.) Source: https://pkgs.tailscale.com/stable/
4. Bring up non-interactively, idempotently:
   ```bash
   if [[ "$(tailscale status --json 2>/dev/null | jq -r .BackendState)" != "Running" ]]; then
     tailscale up --auth-key="$TS_AUTHKEY" --hostname=dbm-vps ${DBM_TS_SSH:+--ssh}
   fi
   tailscale ip -4
   ```
   Without a key, `tailscale up` prints a login URL; `dbm init` should surface it and wait.
5. Expose the dashboard on the tailnet over HTTPS (persists across reboots because of `--bg`):
   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:3000
   tailscale serve status        # Available within your tailnet: https://dbm-vps.<tailnet>.ts.net
   ```
   Idempotent: re-running with the same target is a no-op; `tailscale serve reset` clears it. Sources: https://tailscale.com/kb/1242/tailscale-serve , https://tailscale.com/kb/1312/serve
6. From the laptop (also on the tailnet): Dokploy UI/API at `https://dbm-vps.<tailnet>.ts.net` (port 443, trusted Let's Encrypt cert, no `-k` needed). `http://dbm-vps:3000` also works via MagicDNS short name because ufw allows `in on tailscale0` and `DOCKER-USER` RETURNs `-i tailscale0`. `dbm` should store the `https://…ts.net` URL as the API base.
7. Optional Tailscale SSH: `tailscale set --ssh` on the VPS plus an ACL `ssh` grant (`users: ["root"]`). Keep port-22 key auth as the fallback per spec. Source: https://tailscale.com/kb/1193/tailscale-ssh
8. Optional: open `41641/udp` (already in the script) to favour direct WireGuard paths over DERP relays. Source: https://tailscale.com/kb/1082/firewall-ports

**Blocking 3000 publicly (spec §5.1, §9):** Dokploy publishes 3000 as `mode=host` on a Swarm service; Swarm cannot bind a published port to 127.0.0.1, so "bind to loopback" is not available. Two workable options:
- **A (recommended, in the script):** leave the port published and drop internet-originated NEW connections to original port 3000 in `DOCKER-USER`. `tailscale serve` keeps working because host-originated traffic to `127.0.0.1:3000` goes through OUTPUT, not FORWARD.
- **B:** `docker service update dokploy --publish-rm published=3000,target=3000,mode=host` (maintainer-endorsed, persists across Dokploy updates), then reach Dokploy through Traefik by assigning it the tailnet hostname in Dokploy's Web Server settings and pointing `tailscale serve` at `http://127.0.0.1:80`. More moving parts; Traefik must route on Host `dbm-vps.<tailnet>.ts.net` over plain HTTP. Source: https://github.com/Dokploy/dokploy/discussions/879

## Backblaze B2 setup

1. **Bucket:** B2 Cloud Storage → Buckets → Create a Bucket → name e.g. `dbm-offsite-<random>`, **Private**, **Default Encryption: Enable** (SSE-B2, AES-256; cannot be applied retroactively), Object Lock off. Region is chosen by Backblaze per account; the bucket card shows the endpoint, e.g. `s3.us-west-004.backblazeb2.com` → region `us-west-004`. Sources: https://www.backblaze.com/docs/cloud-storage-enable-encryption-on-a-bucket , https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api
2. **Lifecycle (30-day retention, provider-enforced):** Bucket Settings → Lifecycle Settings → *Use custom lifecycle rules*:
   - `fileNamePrefix`: `` (empty = whole bucket) or one rule each for `db/` and `storage/`
   - `daysFromUploadingToHiding`: **30**
   - `daysFromHidingToDeleting`: **1**
   Result: every object is hidden 30 days after upload and physically deleted the next day, regardless of whether the VPS still exists. Do **not** pick "Keep only the last version" — that rule (`daysFromHidingToDeleting:1`, `daysFromUploadingToHiding:null`) never expires the current version of a uniquely-named dump. If set via S3 API instead: `Expiration/Days=30` **only hides**; add `NoncurrentVersionExpiration/NoncurrentDays=1` so hidden versions are deleted. Sources: https://www.backblaze.com/docs/cloud-storage-lifecycle-rules , https://www.backblaze.com/apidocs/s3-put-lifecycle-configuration
   - Caveat for the `storage/<slug>/` rclone sync: because `rclone sync` re-uploads only changed files, unchanged objects will hit the 30-day hide rule and vanish from the off-site copy. For the storage mirror either use a separate bucket without the 30-day rule (use "Keep prior versions for 30 days" there instead), or use `rclone copy` with dated prefixes. This is a real interaction the spec does not address — see Recommended spec deviations.
3. **Application key (bucket-scoped):** Application Keys → Add a New Application Key → name `dbm-offsite`, **Allow access to Bucket(s): <bucket>**, **Read and Write**, no prefix, optional expiry. Save `keyID` (→ S3 access key id) and `applicationKey` (→ S3 secret; shown once). Bucket-restricted keys work with S3 tools as long as the bucket name is always supplied (no `ListBuckets`). Dokploy's uploader uses `--s3-no-check-bucket`, so it never needs `listBuckets`. Sources: https://www.backblaze.com/docs/cloud-storage-create-and-manage-app-keys , https://www.backblaze.com/docs/cloud-storage-application-keys
4. **Dokploy destination:** Endpoint `https://s3.<region>.backblazeb2.com`, Region `<region>`, Bucket `<bucket>`, Access Key = keyID, Secret = applicationKey; click *Test*. Dokploy streams `pg_dump -Fc … | gzip` to `rclone rcat` with `--s3-force-path-style`. Sources: https://docs.dokploy.com/docs/core/backblaze-b2 , Dokploy `utils.ts`
5. **rclone (storage sync container):** either the S3 backend (`type = s3`, `provider = Other`, `endpoint = https://s3.<region>.backblazeb2.com`, `region = <region>`, `force_path_style = true`) or the native `b2` backend (`account = <keyID>`, `key = <applicationKey>`, `hard_delete = true` if you don't want hidden versions billed). Sources: https://rclone.org/b2/ , https://rclone.org/s3/
6. **Cost estimate:** 23 projects × ~50 MB compressed dumps × 30 days ≈ 35 GB → ~$0.25/month at $6.95/TB (first 10 GB free; API calls free; restore egress free within 3x storage). Source: https://www.backblaze.com/cloud-storage/pricing
7. **Alternative target (one line each):**
   - **Cloudflare R2** — $15/TB-month (2x B2) but zero egress, 10 GB free, lifecycle + SSE supported, global; good if you also want zero-egress restores. https://developers.cloudflare.com/r2/pricing/
   - **Hetzner Object Storage** — flat €6.49/mo for 1 TB + 1 TB egress, EU-only; overkill for ~35 GB but predictable. https://www.hetzner.com/storage/object-storage/
   - **Wasabi** — $7.99/TB, 1 TB minimum and 90-day minimum retention: a poor fit for a 30-day lifecycle. https://wasabi.com/pricing

## Provider comparison

Target: 4 vCPU / 8 GB / ≥80 GB SSD, Ubuntu with root. Prices as displayed 2026-09-30; ARS figures exclude IVA unless stated; exchange rate deliberately not applied.

| Provider / region | Closest 4 vCPU / 8 GB offer | Price | Snapshots / backups | API | Pay in ARS | Latency to Vercel gru1 (São Paulo) | Verification |
|---|---|---|---|---|---|---|---|
| **DonWeb Cloud Server** (Rosario/Argentina; ex-Dattatec) | `vcpu_4_ram_8` + 80 GB SSD + 1 TB transfer | ARS 28,267 + 80×103.74 (≈8,299) + 2,588 ≈ **ARS 39,154/mo list**; site shows ~30% promo; IVA extra | 2 free on-demand snapshots (kept 90 days); weekly backups included | Status page lists "HTTP API"; no public developer docs found | Yes (native) | ≈ 30 ms (BA↔SP measured 30.7 ms) | Prices from page-embedded JSON; images Ubuntu 22.04/24.04/26.04 verified; API **unverified** |
| **WNPower VPS 8GB** (Argentine company; DC "North America") | 4 cores / 8 GB / 75 GB NVMe + 100 GB | ARS 149,500 list / 104,650 promo + 21% IVA; cPanel bundled | Secondary disk backups | Not stated | Yes | ~135–140 ms (US East) — **disqualifying** | Page verified |
| **Neolo** (Argentina) | Snippet: 2 vCPU / 8 GB / 60 GB | "from ARS 22,225/mo" (search snippet) | Backups "included" | Not stated | Yes | unknown DC | **Unverified** (store page rendered empty) |
| **Vultr São Paulo (`sao`)** | `vc2-4c-8gb` 4 vCPU / 8 GB / 160 GB / 4 TB | **USD 40/mo**; `vhp-4c-8gb` USD 48 | Snapshots $0.05/GB-mo; auto-backups +20% | Yes (v2 REST) | No (USD card) | Same metro as `gru1`; expect low single-digit ms (not measured) | API-verified |
| **Hostinger São Paulo** | KVM 2: 2 vCPU / 8 GB / 100 GB; KVM 4: 4 vCPU / 16 GB / 200 GB | KVM 2 USD 8.99 promo → 14.99 renewal; KVM 4 USD 12.99 → 28.99 | Weekly backups + manual snapshots | Yes (public API) | No | Same metro as `gru1` | Page + blog verified |
| **Latitude.sh** (Brazilian) | `vm.small` 4 vCPU / 16 GB / 160 GB | USD 69/mo | Not stated | Yes | No | Locations not confirmed on pricing page | Partially verified |
| **DigitalOcean / Hetzner** | — | — | — | — | — | No South America regions; NYC/ASH ≈ 140 ms from BA | Verified (absence) |

Read: for **query latency** to Vercel `gru1`, a São Paulo VPS (Vultr/Hostinger) beats any Argentine DC by ~30 ms per round-trip; an Argentine DC wins only on ARS billing and data residency. Buenos Aires ↔ São Paulo 30.7 ms, ↔ Santiago 22.5 ms, ↔ Miami 134.7 ms (https://wondernetwork.com/pings/Buenos%20Aires).

## Unverified / uncertain

- **Dokploy backup schedule timezone.** Cron runs inside the Dokploy container; whether "03:00" is UTC or host-local was not verified. Treat as UTC until confirmed and set the reboot window accordingly.
- **Docker never flushes `DOCKER-USER`.** Docker's docs describe the chain as user-owned but do not state persistence guarantees; the `ufw-docker` project relies on this behaviour in production. Persistence in our design comes from ufw's `after.rules`, not from Docker.
- **Swarm host-mode traffic traverses `DOCKER-USER`.** Follows from Docker's port-mapping model (DNAT then FORWARD) and `ufw-docker`'s Swarm support, but I did not find an official sentence saying so. The script's external `nc -zv <ip> 3000` check is the confirmation.
- **Swarm cannot publish to a specific host IP.** Confirmed only by forum/community sources; Docker's official CLI reference does not offer an IP field for `--publish` in Swarm.
- **DonWeb API.** The status page lists API components, but no developer documentation for creating servers/snapshots programmatically was found. DonWeb ARS prices come from JSON embedded in the pricing page; the IVA fields in that JSON did not compute to a clean 21%, so treat totals as ±20%.
- **Neolo** pricing/specs (store page returned "no visible products").
- **Vultr São Paulo latency to `gru1`** not measured; inferred from shared metro.
- **Wasabi** 1 TB minimum / 90-day minimum retention: read from third-party summaries, not the official FAQ (pricing page fetch did not include it).
- **Hetzner Object Storage** supported S3 features (lifecycle, SSE) pulled from the marketing page; the "List of supported actions" page was not fetched.
- **Tailscale node key expiry.** Tailscale expires node keys periodically unless "Disable key expiry" is set per machine; not re-verified today — add a `dbm doctor` check for `tailscale status` key expiry.
- **Dokploy via Tailscale login/logout quirk.** Issue #3156 ("Logout fails with 403 when accessing Dokploy via Tailscale") surfaced in search; not examined. Using the HTTPS `ts.net` URL (proper origin) may avoid it.
- **Dokploy "Docker Cleanup" schedule** (23:50 daily, prune of images/containers/builder cache): from a third-party code summary (DeepWiki) and issue #3973; official docs only mention the setting exists.
- **Backblaze master key not usable with the S3 API** — widely documented by Backblaze historically; the page fetched today did not include the sentence.

## Recommended spec deviations

1. **§3 VPS OS:** change "Ubuntu 22.04 or 24.04" to "Ubuntu 24.04 LTS (26.04 once Dokploy lists it as tested and issue #5471 is closed)". Drop 22.04 (Dokploy's pinned Docker and fail2ban/nft defaults are tested on 24.04).
2. **§7 step 1 ufw rules:** replace "allow 22/80/443/6432/41641" with two layers: ufw (22/tcp, 41641/udp, `in on tailscale0`) **plus** a `DOCKER-USER` allow-list of original destination ports 80/tcp, 443/tcp, 443/udp, 6432/tcp with default DROP for everything else DNAT'ed to containers. Add `443/udp` (Traefik publishes HTTP/3).
3. **§7 step order:** write `/etc/docker/daemon.json` (log rotation) *before* installing Dokploy, so Docker starts with it and no Swarm restart is needed.
4. **§5.1 "Block port 3000 on the public interface":** specify the mechanism: `DOCKER-USER` drop (option A) and note that Swarm cannot bind 127.0.0.1; keep `--publish-rm` as the documented fallback.
5. **§7 step 2 Tailscale auth key:** require a **non-ephemeral**, single-use, pre-approved key (or OAuth client with `ephemeral=false`). Add "enable HTTPS certificates in the Tailscale admin console" as a documented prerequisite, since `tailscale serve` refuses without it.
6. **§5.5 lifecycle wording:** specify the exact B2 rule (`daysFromUploadingToHiding=30`, `daysFromHidingToDeleting=1`) and warn that S3-API `Expiration` only hides on B2.
7. **§5.5 storage sync vs 30-day rule:** `rclone sync` of Garage buckets into the same 30-day bucket will lose unchanged objects after 30 days. Use a second bucket (or prefix-scoped rule that only covers `db/`) with "keep prior versions 30 days" semantics for `storage/`.
8. **§5.5 Dokploy dump format:** Dokploy produces `pg_dump -Fc … | gzip` (custom format), so `dbm restore` must use `pg_restore`, not `psql`. Update §7 `restore` accordingly.
9. **§3 provider preference:** for the stated goal (low latency from Vercel `gru1`), make Vultr or Hostinger São Paulo the primary recommendation and DonWeb the "pay in ARS / data in Argentina" alternative. Set expectations: ~30 ms extra per query round-trip from an Argentine DC.
10. **§9 / §7:** set the server timezone explicitly and schedule the unattended-upgrades reboot at 04:30 local (after backups); document the ~1-minute PgBouncer outage on reboot nights.
11. **§12 / `dbm doctor`:** add checks for (a) public port 3000 closed from a non-tailnet vantage point, (b) Tailscale node key expiry, (c) B2 lifecycle rule present, (d) `daemon.json` log rotation in effect (`docker info --format '{{.LoggingDriver}}'`).
12. **Monitoring (new):** add a hosted free checker (HetrixTools free: 15 monitors, 1-min, TCP port 6432 + HTTPS `s3.example.com` + HTTPS `db` cert expiry; or UptimeRobot free) rather than self-hosting Uptime Kuma on the same VPS.

## Sources

- https://releases.ubuntu.com/26.04/
- https://ubuntu.com/about/release-cycle
- https://download.docker.com/linux/ubuntu/dists/
- https://docs.dokploy.com/docs/core/installation
- https://dokploy.com/install.sh
- https://github.com/Dokploy/dokploy/issues/4501
- https://github.com/Dokploy/dokploy/issues/5471
- https://github.com/Dokploy/dokploy/discussions/879
- https://docs.dokploy.com/docs/core/guides/tailscale
- https://docs.dokploy.com/docs/core/backblaze-b2
- https://docs.dokploy.com/docs/core/databases/backups
- https://raw.githubusercontent.com/Dokploy/dokploy/canary/packages/server/src/utils/backups/utils.ts
- https://github.com/Dokploy/dokploy/issues/3973
- https://man.openbsd.org/sshd_config
- https://bugs.launchpad.net/bugs/2088207
- https://ubuntu.com/server/docs/how-to/software/automatic-updates/
- https://git.launchpad.net/ubuntu/+source/unattended-upgrades/plain/data/50unattended-upgrades.Ubuntu
- https://docs.docker.com/engine/network/packet-filtering-firewalls/
- https://docs.docker.com/engine/network/firewall-iptables/
- https://docs.docker.com/reference/cli/dockerd/
- https://docs.docker.com/engine/logging/configure/
- https://docs.docker.com/engine/logging/drivers/local/
- https://docs.docker.com/engine/daemon/live-restore/
- https://github.com/chaifeng/ufw-docker
- https://forums.docker.com/t/bind-port-address-to-single-ip/43173
- https://raw.githubusercontent.com/fail2ban/fail2ban/master/config/jail.conf
- https://bugs.launchpad.net/ubuntu/+source/fail2ban/+bug/2055114
- https://tailscale.com/kb/1031/install-linux
- https://pkgs.tailscale.com/stable/
- https://pkgs.tailscale.com/stable/ubuntu/noble.list
- https://tailscale.com/kb/1085/auth-keys
- https://tailscale.com/kb/1215/oauth-clients
- https://tailscale.com/kb/1242/tailscale-serve
- https://tailscale.com/kb/1312/serve
- https://tailscale.com/docs/reference/tailscale-cli/serve
- https://tailscale.com/kb/1153/enabling-https
- https://tailscale.com/kb/1081/magicdns
- https://tailscale.com/kb/1082/firewall-ports
- https://tailscale.com/kb/1193/tailscale-ssh
- https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api
- https://www.backblaze.com/cloud-storage/pricing
- https://forum.rclone.org/t/backblaze-b2-is-raising-prices/41857
- https://www.backblaze.com/docs/cloud-storage-lifecycle-rules
- https://www.backblaze.com/apidocs/s3-put-lifecycle-configuration
- https://www.backblaze.com/blog/a-deeper-look-at-s3-compatible-lifecycle-rules-in-backblaze-b2/
- https://www.backblaze.com/docs/cloud-storage-server-side-encryption
- https://www.backblaze.com/docs/cloud-storage-enable-encryption-on-a-bucket
- https://www.backblaze.com/apidocs/s3-put-bucket-encryption
- https://www.backblaze.com/docs/cloud-storage-create-and-manage-app-keys
- https://www.backblaze.com/docs/cloud-storage-application-keys
- https://rclone.org/b2/
- https://rclone.org/s3/
- https://developers.cloudflare.com/r2/pricing/
- https://www.hetzner.com/storage/object-storage/
- https://docs.hetzner.com/storage/object-storage/overview
- https://wasabi.com/pricing
- https://api.vultr.com/v2/plans
- https://api.vultr.com/v2/regions
- https://docs.vultr.com/support/platform/billing/does-vultr-charge-for-stored-snapshots
- https://www.hostinger.com/vps-hosting
- https://www.hostinger.com/blog/brazilian-vps-data-center/
- https://www.latitude.sh/pricing
- https://docs.digitalocean.com/platform/regional-availability/
- https://donweb.com/es-ar/hosting-cloud-servers-vps
- https://soporte.donweb.com/hc/es/articles/22966127419028
- https://www.wnpower.com/hosting-cloud-vps/
- https://wondernetwork.com/pings/Buenos%20Aires
- https://vercel.com/docs/regions
- https://betterstack.com/pricing
- https://uptimerobot.com/pricing/
- https://hetrixtools.com/pricing/uptime-monitor/
- https://github.com/louislam/uptime-kuma
