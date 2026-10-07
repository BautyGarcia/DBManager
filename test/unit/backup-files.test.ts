import { describe, expect, it } from 'vitest';
import { backupFileTime, newestBackupFile } from '../../src/core/backup-files.js';

describe('backupFileTime', () => {
  it('uses ModTime when present', () => {
    expect(backupFileTime({ Path: 'x/a.sql.gz', ModTime: '2026-10-07T13:33:39.462Z' })).toBe(
      Date.parse('2026-10-07T13:33:39.462Z'),
    );
  });
  it('falls back to the timestamp in the file name when Dokploy returns an empty ModTime', () => {
    expect(
      backupFileTime({
        Path: 'pg-tumedia-nxdvuk/db/tumedia/2026-10-07T13-33-39-462Z.sql.gz',
        ModTime: '',
      }),
    ).toBe(Date.parse('2026-10-07T13:33:39.462Z'));
  });
  it('is undefined when neither carries a time', () => {
    expect(backupFileTime({ Path: 'pg-x/db/x', ModTime: '' })).toBeUndefined();
  });
});

describe('newestBackupFile', () => {
  it('picks the newest by name even when every ModTime is empty', () => {
    const files = [
      { Path: 'p/db/x/2026-10-07T13-33-39-462Z.sql.gz', ModTime: '' },
      { Path: 'p/db/x/2026-10-04T06-18-00-189Z.sql.gz', ModTime: '' },
      { Path: 'p/db/x/2026-10-06T06-18-00-360Z.sql.gz', ModTime: '' },
    ];
    expect(newestBackupFile(files)?.Path).toBe('p/db/x/2026-10-07T13-33-39-462Z.sql.gz');
  });
  it('prefers any timestamped file over an untimestamped one', () => {
    const files = [
      { Path: 'p/db/x/latest.sql.gz', ModTime: '' },
      { Path: 'p/db/x/2026-10-04T06-18-00-189Z.sql.gz', ModTime: '' },
    ];
    expect(newestBackupFile(files)?.Path).toBe('p/db/x/2026-10-04T06-18-00-189Z.sql.gz');
    expect(newestBackupFile([])).toBeUndefined();
  });
});
