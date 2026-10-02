import { describe, expect, it } from 'vitest';
import { DbmError } from '../../src/core/exit.js';
import { deriveNames, validateSlug, webHost } from '../../src/core/naming.js';

describe('validateSlug', () => {
  it('accepts lowercase letters, digits, single inner hyphens, 3-31 chars', () => {
    expect(validateSlug('a12')).toBe('a12');
    expect(validateSlug('abc')).toBe('abc');
    expect(validateSlug('my-app-2')).toBe('my-app-2');
    expect(validateSlug('a-b')).toBe('a-b');
    expect(validateSlug(`a${'b'.repeat(30)}`)).toHaveLength(31);
  });
  it.each([
    'A',
    '1abc',
    'my_app',
    'a',
    'a1',
    'ab',
    'ab-',
    'abc-',
    'a--b',
    '-abc',
    `a${'b'.repeat(31)}`,
    'my app',
    'my.app',
    '',
  ])('rejects %j', (bad) => {
    expect(() => validateSlug(bad)).toThrow(DbmError);
    try {
      validateSlug(bad);
    } catch (e) {
      expect((e as DbmError).exitCode).toBe(1);
    }
  });
  it.each(['dbm', 'pgbouncer', 'garage', 'postgres', 'admin', 'template0', 'template1', 'session'])(
    'rejects reserved %s',
    (r) => {
      expect(() => validateSlug(r)).toThrow(/reserved/);
    },
  );
  it('reserves the dbm- prefix for dbm itself unless internal', () => {
    expect(() => validateSlug('dbm-smoke')).toThrow(/dbm- prefix is reserved/);
    expect(() => validateSlug('dbm-anything')).toThrow(DbmError);
    expect(validateSlug('dbm-smoke', { internal: true })).toBe('dbm-smoke');
    expect(validateSlug('dbmx')).toBe('dbmx');
  });
});

describe('deriveNames', () => {
  it('keeps hyphens for PgBouncer/bucket names and uses underscores for SQL identifiers', () => {
    const n = deriveNames('my-app');
    expect(n).toEqual({
      slug: 'my-app',
      slugDb: 'my_app',
      database: 'my_app',
      appRole: 'my_app_app',
      adminRole: 'my_app_admin',
      serviceName: 'pg-my-app',
      pgbouncerDb: 'my-app',
      pgbouncerSessionDb: 'my-app_session',
      bucket: 'my-app',
      keyName: 'my-app-key',
      backupPrefix: 'db/my-app',
      storagePrefix: 'storage/my-app',
      traefikWebFile: 'dbm-web-my-app.yml',
    });
  });
  it('builds the public web host', () => {
    expect(webHost('my-app', 'web.example.com')).toBe('my-app.web.example.com');
  });
});
