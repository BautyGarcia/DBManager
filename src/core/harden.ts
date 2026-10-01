export interface HardenOptions {
  sshPort: number;
  publicTcpPorts: number[];
  publicUdpPorts: number[];
  timezone: string;
  rebootTime: string;
}

export const DEFAULT_HARDEN: HardenOptions = {
  sshPort: 22,
  publicTcpPorts: [80, 443, 6432],
  publicUdpPorts: [443],
  timezone: 'America/Argentina/Buenos_Aires',
  rebootTime: '04:30',
};

export function renderHardenScript(o: HardenOptions): string {
  const allowTcp = o.publicTcpPorts
    .map((p) => `-A DOCKER-USER -p tcp -m conntrack --ctstate NEW --ctorigdstport ${p} -j RETURN`)
    .join('\n');
  const allowUdp = o.publicUdpPorts
    .map((p) => `-A DOCKER-USER -p udp -m conntrack --ctstate NEW --ctorigdstport ${p} -j RETURN`)
    .join('\n');
  const ufwTcp = o.publicTcpPorts.map((p) => `ufw allow ${p}/tcp >/dev/null`).join('\n  ');
  const ufwUdp = o.publicUdpPorts.map((p) => `ufw allow ${p}/udp >/dev/null`).join('\n  ');
  return `#!/usr/bin/env bash
# dbm init: host hardening for Ubuntu 24.04 (Docker/Dokploy host). Idempotent. Run as root.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

log(){ printf '[dbm] %s\\n' "$*"; }
write_if_changed(){ # write_if_changed <path> <mode>  (content on stdin) -> 0 if changed
  local path="$1" mode="$2" tmp; tmp="$(mktemp)"; cat >"$tmp"
  if [[ -f "$path" ]] && cmp -s "$tmp" "$path"; then rm -f "$tmp"; return 1; fi
  install -m "$mode" -D "$tmp" "$path"; rm -f "$tmp"; return 0
}

require_ubuntu(){
  . /etc/os-release
  [[ "$ID" == "ubuntu" ]] || { echo "Ubuntu required, got $ID" >&2; exit 1; }
  [[ "$VERSION_ID" == "24.04" ]] || log "WARN: Ubuntu $VERSION_ID is not the tested release (24.04)"
}

step_packages(){
  log "apt: base packages"
  apt-get update -qq
  apt-get install -y -qq ufw fail2ban unattended-upgrades apt-listchanges ca-certificates curl gnupg jq iptables netcat-openbsd >/dev/null
  timedatectl set-timezone "${o.timezone}" || true
}

step_sshd(){
  log "sshd: key-only, no passwords, root via key only"
  if [[ ! -s /root/.ssh/authorized_keys ]]; then
    echo "refusing: /root/.ssh/authorized_keys is empty; you would be locked out" >&2; exit 1
  fi
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
  sshd -t
  if (( changed )); then systemctl reload ssh 2>/dev/null || systemctl restart ssh; fi
  sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '
}

step_unattended_upgrades(){
  log "unattended-upgrades: security-only + reboot window ${o.rebootTime}"
  write_if_changed /etc/apt/apt.conf.d/52dbm-unattended-upgrades 0644 <<EOT || true
// Managed by dbm init
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "${o.rebootTime}";
Unattended-Upgrade::SyslogEnable "true";
EOT
  write_if_changed /etc/apt/apt.conf.d/20auto-upgrades 0644 <<'EOT' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOT
  systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null
}

step_docker_daemon_json(){
  log "docker: daemon.json log rotation (before Dokploy installs Docker)"
  mkdir -p /etc/docker
  local cur='{}'; [[ -s /etc/docker/daemon.json ]] && cur="$(cat /etc/docker/daemon.json)"
  local new
  new="$(jq -S '. + {"log-driver":"json-file","log-opts":((."log-opts"//{}) + {"max-size":"10m","max-file":"3"})}' <<<"$cur")"
  if printf '%s\\n' "$new" | write_if_changed /etc/docker/daemon.json 0644; then
    if systemctl is-active --quiet docker; then
      log "docker: config changed, restarting dockerd"
      systemctl restart docker
    fi
  fi
}

step_docker_user_rules(){
  # Docker DNATs published ports before ufw's INPUT chain. FORWARD -> DOCKER-USER is ours.
  # Shipped through ufw's after.rules so ufw re-applies it on reload/boot (ufw-docker pattern).
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
-A DOCKER-USER -i tailscale0 -j RETURN
-A DOCKER-USER -i docker0 -j RETURN
-A DOCKER-USER -i docker_gwbridge -j RETURN
-A DOCKER-USER -s 10.0.0.0/8 -j RETURN
-A DOCKER-USER -s 172.16.0.0/12 -j RETURN
-A DOCKER-USER -s 192.168.0.0/16 -j RETURN
${allowTcp}
${allowUdp}
-A DOCKER-USER -m conntrack --ctstate NEW -j dbm-docker-deny
-A DOCKER-USER -j RETURN
-A dbm-docker-deny -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[DBM DOCKER BLOCK] "
-A dbm-docker-deny -j DROP
COMMIT
# END DBM DOCKER-USER
EOT
)"
  local f="${'$'}{DBM_UFW_AFTER_RULES:-/etc/ufw/after.rules}" tmp tmp2; tmp="$(mktemp)"; tmp2="$(mktemp)"
  awk '/^# BEGIN DBM DOCKER-USER/{skip=1} !skip{print} /^# END DBM DOCKER-USER/{skip=0}' "$f" >"$tmp2"
  # drop trailing blank lines so the separator written below does not accumulate across runs
  awk '/^$/{b++; next} {for(;b>0;b--) print ""; print}' "$tmp2" >"$tmp"
  printf '\\n%s\\n' "$block" >>"$tmp"
  if ! cmp -s "$tmp" "$f"; then install -m 0640 "$tmp" "$f"; log "after.rules: DOCKER-USER block updated"; fi
  rm -f "$tmp" "$tmp2"
}

step_ufw(){
  log "ufw: default deny in; allow ${o.sshPort}/tcp, 41641/udp, tailscale0"
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow ${o.sshPort}/tcp >/dev/null
  ufw allow 41641/udp >/dev/null
  ufw allow in on tailscale0 >/dev/null
  ${ufwTcp}
  ${ufwUdp}
  step_docker_user_rules
  ufw --force enable >/dev/null
  ufw reload >/dev/null
}

step_fail2ban(){
  log "fail2ban: sshd jail"
  write_if_changed /etc/fail2ban/jail.d/dbm-sshd.local 0644 <<EOT || true
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 100.64.0.0/10
bantime  = 1h
findtime = 10m
maxretry = 5
bantime.increment = true

[sshd]
enabled = true
port    = ${o.sshPort}
mode    = normal
EOT
  systemctl enable --now fail2ban >/dev/null
  systemctl restart fail2ban
}

require_ubuntu
step_packages
step_sshd
step_unattended_upgrades
step_docker_daemon_json
step_ufw
step_fail2ban
log "host hardening converged"
`;
}
