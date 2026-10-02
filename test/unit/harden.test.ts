import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HARDEN, renderHardenScript } from '../../src/core/harden.js';

describe('renderHardenScript', () => {
  const script = renderHardenScript(DEFAULT_HARDEN);
  it('is syntactically valid bash', async () => {
    const r = await execa('bash', ['-n'], { input: script, reject: false });
    expect(r.exitCode, r.stderr).toBe(0);
  });
  it('contains the controls the spec requires', () => {
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('rm -f /etc/ssh/sshd_config.d/50-cloud-init.conf');
    expect(script).toContain('/etc/ssh/sshd_config.d/00-dbm.conf');
    expect(script).toContain('PasswordAuthentication no');
    expect(script).toContain('KbdInteractiveAuthentication no');
    expect(script).toContain('PermitRootLogin prohibit-password');
    expect(script).toContain('authorized_keys is empty');
    expect(script).toContain('Unattended-Upgrade::Automatic-Reboot "true"');
    expect(script).toContain('Automatic-Reboot-Time "04:30"');
    expect(script).toContain('/etc/docker/daemon.json');
    expect(script).toContain('ufw default deny incoming');
    expect(script).toContain('ufw allow 22/tcp');
    expect(script).toContain('ufw allow in on tailscale0');
    expect(script).toContain(':DOCKER-USER - [0:0]');
    expect(script).toContain('--ctorigdstport 6432 -j RETURN');
    expect(script).toContain('--ctorigdstport 443 -j RETURN');
    expect(script).toContain('-p udp -m conntrack --ctstate NEW --ctorigdstport 443 -j RETURN');
    expect(script).toContain('-i tailscale0 -j RETURN');
    expect(script).toContain('/etc/fail2ban/jail.d/dbm-sshd.local');
    expect(script).toContain('100.64.0.0/10');
    expect(script).toContain('timedatectl set-timezone "America/Argentina/Buenos_Aires"');
    expect(script).not.toContain('--ctorigdstport 3000');
    // sshd's default (6) leaves room for operators whose agent offers several keys.
    expect(script).not.toContain('MaxAuthTries');
  });
  it('parameterises ports', () => {
    const s = renderHardenScript({ ...DEFAULT_HARDEN, sshPort: 2222, publicTcpPorts: [443] });
    expect(s).toContain('ufw allow 2222/tcp');
    expect(s).not.toContain('--ctorigdstport 6432');
  });
  it('after.rules update is idempotent', async () => {
    const m = script.match(/^step_docker_user_rules\(\)\{\n[\s\S]*?^\}\n/m);
    expect(m).not.toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'dbm-harden-'));
    try {
      const f = join(dir, 'after.rules');
      writeFileSync(f, '*filter\n:ufw-user-forward - [0:0]\nCOMMIT\n');
      const harness = `log(){ :; }\n${m?.[0]}\nstep_docker_user_rules\n`;
      const run = () =>
        execa('bash', ['-c', harness], { env: { DBM_UFW_AFTER_RULES: f }, reject: false });
      const r1 = await run();
      expect(r1.exitCode, r1.stderr).toBe(0);
      const first = readFileSync(f, 'utf8');
      const r2 = await run();
      expect(r2.exitCode, r2.stderr).toBe(0);
      expect(readFileSync(f, 'utf8')).toBe(first);
      expect(first.split('# BEGIN DBM DOCKER-USER').length - 1).toBe(1);
      expect(first.startsWith('*filter\n')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
