import { describe, expect, it } from 'vitest';
import { DbmError } from '../../src/core/exit.js';
import { deriveNames, validateSlug, webHost } from '../../src/core/naming.js';

describe('validateSlug', () => {
  it('accepts lowercase letters, digits, hyphens, 2-31 chars', () => {
    expect(validateSlug('a1')).toBe('a1');
    expect(validateSlug('my-app-2')).toBe('my-app-2');
    expect(validateSlug(`a${'b'.repeat(30)}`)).toHaveLength(31);
  });
  it.each(['A', '1abc', 'my_app', 'a', `a${'b'.repeat(31)}`, 'my app', 'my.app', ''])(
    'rejects %j',
    (bad) => {
      expect(() => validateSlug(bad)).toThrow(DbmError);
      try {
        validateSlug(bad);
      } catch (e) {
        expect((e as DbmError).exitCode).toBe(1);
      }
    },
  );
  it.each(['dbm', 'pgbouncer', 'garage', 'postgres', 'admin', 'template0', 'template1', 'session'])(
    'rejects reserved %s',
    (r) => {
      expect(() => validateSlug(r)).toThrow(/reserved/);
    },
  );
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
