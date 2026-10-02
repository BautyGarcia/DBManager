import { deriveNames } from '../core/naming.js';
import { listProjects } from '../core/state.js';
import { formatBytes } from '../core/units.js';
import type { Deps } from './context.js';

export interface ListRow {
  slug: string;
  status: string;
  pgMajor: number;
  memory: string;
  volume: string;
  storage: string;
  lastBackup: string;
  createdAt: string;
}

export function formatTable(rows: string[][]): string {
  const widths: number[] = [];
  for (const r of rows)
    r.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, c.length);
    });
  return `${rows
    .map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join('  '))
    .join('\n')}\n`;
}

async function dockerStats(deps: Deps): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const r = await deps.ssh.run([
      'docker',
      'stats',
      '--no-stream',
      '--format',
      '{{.Name}}\t{{.MemUsage}}',
    ]);
    for (const line of r.stdout.split('\n')) {
      const [name, mem] = line.split('\t');
      if (name && mem) out.set(name, mem);
    }
  } catch {
    /* unreachable VPS: leave empty */
  }
  return out;
}

async function volumeSizes(deps: Deps): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const r = await deps.ssh.run(['docker', 'system', 'df', '-v', '--format', '{{json .Volumes}}']);
    const vols = JSON.parse(r.stdout || '[]') as Array<{ Name: string; Size: string }>;
    for (const v of vols) out.set(v.Name, v.Size);
  } catch {
    /* ignore */
  }
  return out;
}

export async function listCommand(deps: Deps): Promise<ListRow[]> {
  const state = await deps.store.loadState();
  const [stats, vols] = await Promise.all([dockerStats(deps), volumeSizes(deps)]);
  const rows: ListRow[] = [];
  for (const p of listProjects(state)) {
    const names = deriveNames(p.slug);
    const memKey = [...stats.keys()].find(
      (k) => k.startsWith(`${p.dokploy.appName}.`) || k === p.dokploy.appName,
    );
    let storage = '-';
    if (p.storage) {
      try {
        const b = await deps.garage.getBucket({ id: p.storage.bucketId });
        storage = b ? `${formatBytes(b.bytes)} (${b.objects} objects)` : '?';
      } catch {
        storage = '?';
      }
    }
    let lastBackup = '-';
    try {
      const files = await deps.dokploy.listBackupFiles(
        deps.cfg.dumpsDestinationId,
        `${p.dokploy.appName}/${names.backupPrefix}/`,
      );
      const newest = files
        .map((f) => f.ModTime)
        .sort()
        .at(-1);
      if (newest) lastBackup = newest;
    } catch {
      lastBackup = '?';
    }
    rows.push({
      slug: p.slug,
      status: p.status,
      pgMajor: p.pgMajor,
      memory: memKey ? (stats.get(memKey) ?? '?') : stats.size ? '-' : '?',
      volume: vols.get(`${p.dokploy.appName}-data`) ?? (vols.size ? '-' : '?'),
      storage,
      lastBackup,
      createdAt: p.createdAt,
    });
  }
  return rows;
}
