import { describe, expect, it } from 'vitest';
import { backupCron, PGBOUNCER_RELOAD_CRON, STORAGE_SYNC_CRON } from '../../src/core/cron.js';

describe('cron', () => {
  it('jitters the minute deterministically within 0-24 at 06:00 UTC', () => {
    const a = backupCron('my-app');
    expect(a).toMatch(/^\d{1,2} 6 \* \* \*$/);
    expect(Number(a.split(' ')[0])).toBeLessThan(25);
    expect(backupCron('my-app')).toBe(a);
    expect(backupCron('other')).not.toBe(a);
  });
  it('fixed schedules', () => {
    expect(STORAGE_SYNC_CRON).toBe('30 6 * * *');
    expect(PGBOUNCER_RELOAD_CRON).toBe('10 4 * * *');
  });
});
