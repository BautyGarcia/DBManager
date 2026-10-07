/**
 * Timestamps of dump files in the off-site bucket. Dokploy's `backup.listBackupFiles` returns an
 * empty `ModTime` (it lists without per-object HEAD requests, which Backblaze bills as Class B),
 * so the time is taken from the file name Dokploy writes: `<ISO date with - instead of :>.sql.gz`.
 */
export interface BackupFileLike {
  Path: string;
  ModTime: string;
}

const NAME_TIME = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/;

/** Epoch milliseconds of a dump, or undefined when neither ModTime nor the name carries one. */
export function backupFileTime(f: BackupFileLike): number | undefined {
  const fromMod = f.ModTime ? Date.parse(f.ModTime) : Number.NaN;
  if (!Number.isNaN(fromMod)) return fromMod;
  const m = NAME_TIME.exec(f.Path);
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(t) ? undefined : t;
}

/** The dump with the newest timestamp; files without a timestamp lose to any file with one. */
export function newestBackupFile<T extends BackupFileLike>(files: T[]): T | undefined {
  let best: T | undefined;
  let bestT = -1;
  for (const f of files) {
    const t = backupFileTime(f) ?? -1;
    if (t > bestT || (best === undefined && t === -1)) {
      best = f;
      bestT = t;
    }
  }
  return best;
}
