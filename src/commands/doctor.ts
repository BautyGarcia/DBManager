import { quote } from 'shlex';
import { deriveNames } from '../core/naming.js';
import { renderPgbouncerIni, renderUserlist } from '../core/pgbouncer.js';
import { listProjects } from '../core/state.js';
import { adminTarget, type Deps } from './context.js';

export interface Check {
  name: string;
  ok: boolean;
  level: 'fail' | 'warn';
  detail: string;
}

export const MIN_VERSIONS = {
  dokploy: '0.30.0',
  pgbouncer: '1.26.0',
  pg18: '18.6',
  pg17: '17.11',
} as const;
const DAY = 86_400_000;

export function versionAtLeast(actual: string, floor: string): boolean {
  const a =
    actual
      .match(/\d+(\.\d+)*/)?.[0]
      .split('.')
      .map(Number) ?? [];
  const f = floor.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, f.length); i++) {
    const x = a[i] ?? 0;
    const y = f[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function parseNotAfter(out: string): Date | undefined {
  const m = out.match(/notAfter=(.+)/);
  if (!m?.[1]) return undefined;
  const d = new Date(m[1].trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
}

type Level = 'fail' | 'warn';

export async function doctorCommand(deps: Deps): Promise<{ checks: Check[]; ok: boolean }> {
  const checks: Check[] = [];
  const now = deps.now().getTime();
  const add = (name: string, ok: boolean, detail: string, level: Level = 'fail') => {
    checks.push({ name, ok, level, detail });
  };
  const attempt = async (name: string, fn: () => Promise<void>, level: Level = 'fail') => {
    try {
      await fn();
    } catch (e) {
      add(name, false, e instanceof Error ? (e.message.split('\n')[0] ?? '') : String(e), level);
    }
  };
  const { remote } = deps.cfg;
  const state = await deps.store.loadState();
  const projects = listProjects(state);

  await attempt('ssh', async () => {
    await deps.ssh.run(['true']);
    add('ssh', true, `${deps.cfg.sshUser}@${deps.cfg.sshHost}`);
  });
  await attempt('dokploy.version', async () => {
    const v = await deps.dokploy.getVersion();
    add(
      'dokploy.version',
      versionAtLeast(v, MIN_VERSIONS.dokploy),
      `${v} (min ${MIN_VERSIONS.dokploy})`,
    );
  });
  await attempt('pgbouncer.version', async () => {
    const r = await deps.ssh.run([
      'docker',
      'exec',
      remote.pgbouncerContainer,
      'pgbouncer',
      '--version',
    ]);
    const v = r.stdout.match(/PgBouncer\s+(\S+)/)?.[1] ?? '?';
    add(
      'pgbouncer.version',
      versionAtLeast(v, MIN_VERSIONS.pgbouncer),
      `${v} (min ${MIN_VERSIONS.pgbouncer})`,
    );
  });
  await attempt('pgbouncer.drift', async () => {
    const ini = (await deps.ssh.run(['cat', `${remote.pgbouncerConfDir}/pgbouncer.ini`])).stdout;
    const ul = (await deps.ssh.run(['cat', `${remote.pgbouncerConfDir}/userlist.txt`])).stdout;
    const same =
      ini.trim() ===
        renderPgbouncerIni(projects, { certDir: `/certs/${deps.cfg.dbHost}` }).trim() &&
      ul.trim() === renderUserlist(projects).trim();
    add(
      'pgbouncer.drift',
      same,
      same ? 'files match state' : 'files differ from state; run `dbm sync-pgbouncer`',
    );
  });
  await attempt('tls.cert', async () => {
    const host = quote(deps.cfg.dbHost);
    const served = await deps.ssh.run([
      'sh',
      '-c',
      `openssl s_client -connect 127.0.0.1:6432 -starttls postgres -servername ${host} </dev/null 2>/dev/null | openssl x509 -noout -enddate -subject`,
    ]);
    const onDisk = await deps.ssh.run([
      'openssl',
      'x509',
      '-in',
      `${remote.certsDir}/${deps.cfg.dbHost}/certificate.crt`,
      '-noout',
      '-enddate',
    ]);
    const servedExp = parseNotAfter(served.stdout);
    const diskExp = parseNotAfter(onDisk.stdout);
    if (!servedExp) throw new Error(`could not read served certificate: ${served.stdout}`);
    const daysLeft = Math.floor((servedExp.getTime() - now) / DAY);
    const matchesDisk =
      diskExp !== undefined && Math.abs(diskExp.getTime() - servedExp.getTime()) < 1000;
    add(
      'tls.cert',
      daysLeft > 14 && served.stdout.includes(deps.cfg.dbHost) && matchesDisk,
      `${daysLeft} days left; served cert ${matchesDisk ? 'matches' : 'DIFFERS FROM'} file on disk`,
    );
  });
  await attempt('garage.health', async () => {
    add('garage.health', await deps.garage.health(), '/health');
  });
  await attempt('garage.region', async () => {
    const toml = (await deps.ssh.run(['cat', `${remote.garageConfDir}/garage.toml`])).stdout;
    const ok = /^s3_region = "garage"$/m.test(toml);
    add('garage.region', ok, ok ? 's3_region = garage' : 'garage.toml s3_region is not "garage"');
  });
  await attempt('docker.logging', async () => {
    const driver = (
      await deps.ssh.run(['docker', 'info', '--format', '{{.LoggingDriver}}'])
    ).stdout.trim();
    const daemon = (await deps.ssh.run(['cat', '/etc/docker/daemon.json'])).stdout;
    const rotated = daemon.includes('max-size');
    add(
      'docker.logging',
      driver === 'json-file' && rotated,
      `${driver}, rotation ${rotated ? 'on' : 'OFF'}`,
    );
  });
  await attempt('tailscale', async () => {
    const st = JSON.parse((await deps.ssh.run(['tailscale', 'status', '--json'])).stdout) as {
      BackendState: string;
      Self?: { KeyExpiry?: string | null; DNSName?: string };
    };
    const exp = st.Self?.KeyExpiry ? new Date(st.Self.KeyExpiry).getTime() : undefined;
    const days = exp ? Math.floor((exp - now) / DAY) : undefined;
    add(
      'tailscale',
      st.BackendState === 'Running' && (days === undefined || days > 14),
      `${st.BackendState}, key ${days === undefined ? 'never expires' : `expires in ${days}d`}`,
    );
  });
  await attempt('disk', async () => {
    const out = (await deps.ssh.run(['df', '--output=pcent', '/'])).stdout;
    const pct = Number(out.trim().split('\n').at(-1)?.replace('%', '').trim());
    add('disk', pct < 85, `${pct}% used`);
  });

  for (const p of projects) {
    if (p.status !== 'running') {
      add(`${p.slug}.status`, true, p.status, 'warn');
      continue;
    }
    await attempt(`${p.slug}.postgres.version`, async () => {
      const v = (await deps.pg.runSql(adminTarget(p), 'show server_version;')).trim();
      const floor = p.pgMajor === 18 ? MIN_VERSIONS.pg18 : MIN_VERSIONS.pg17;
      add(`${p.slug}.postgres.version`, versionAtLeast(v, floor), `${v} (min ${floor})`);
    });
    await attempt(`${p.slug}.postgres.datadir`, async () => {
      const dataDir = (await deps.pg.runSql(adminTarget(p), 'show data_directory;')).trim();
      const container = await deps.pg.findContainer(p.dokploy.appName);
      const mounts = JSON.parse(
        (await deps.ssh.run(['docker', 'inspect', '--format', '{{json .Mounts}}', container]))
          .stdout,
      ) as Array<{ Destination: string }>;
      const covered = mounts.some(
        (m) => dataDir === m.Destination || dataDir.startsWith(`${m.Destination}/`),
      );
      add(
        `${p.slug}.postgres.datadir`,
        covered,
        covered
          ? `${dataDir} is on a volume`
          : `${dataDir} is NOT under any mount: data would be lost on recreate`,
      );
    });
    await attempt(
      `${p.slug}.backup.age`,
      async () => {
        const files = await deps.dokploy.listBackupFiles(
          deps.cfg.dumpsDestinationId,
          `${p.dokploy.appName}/${deriveNames(p.slug).backupPrefix}/`,
        );
        const newest = files
          .map((f) => new Date(f.ModTime).getTime())
          .sort((a, b) => a - b)
          .at(-1);
        const hours = newest ? Math.floor((now - newest) / 3_600_000) : undefined;
        add(
          `${p.slug}.backup.age`,
          hours !== undefined && hours < 36,
          hours === undefined ? 'no backups yet' : `${hours}h ago`,
          'warn',
        );
      },
      'warn',
    );
    if (p.storage) {
      const bucketId = p.storage.bucketId;
      await attempt(
        `${p.slug}.storage.uploads`,
        async () => {
          const b = await deps.garage.getBucket({ id: bucketId });
          add(
            `${p.slug}.storage.uploads`,
            (b?.unfinishedUploads ?? 0) < 50,
            `${b?.unfinishedUploads ?? '?'} unfinished multipart uploads`,
            'warn',
          );
        },
        'warn',
      );
    }
  }

  const ok = checks.every((c) => c.ok || c.level === 'warn');
  return { checks, ok };
}

export function externalChecks(cfg: Deps['cfg']): string {
  return [
    'Run from a machine outside the tailnet:',
    `  nc -zv -w3 ${cfg.sshHost} 3000   # must FAIL (dashboard hidden)`,
    `  nc -zv -w3 ${cfg.dbHost} 6432    # must succeed`,
    '',
  ].join('\n');
}
