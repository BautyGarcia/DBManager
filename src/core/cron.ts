/** Nightly dumps at 06:xx UTC (03:xx in Argentina), minute jittered per slug in 0-24. */
export function backupCron(slug: string): string {
  let h = 0x811c9dc5;
  for (const ch of slug) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h % 25} 6 * * *`;
}

export const STORAGE_SYNC_CRON = '30 6 * * *';
export const PGBOUNCER_RELOAD_CRON = '10 4 * * *';
