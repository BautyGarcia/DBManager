import { describe, expect, it } from 'vitest';
import {
  createDatabaseSql,
  createRoleSql,
  extensionsSql,
  grantReplicaRoleSql,
  quoteIdent,
  quoteLiteral,
  tuningSql,
  validateExtensions,
} from '../../src/core/sql.js';

describe('sql builders', () => {
  it('quotes identifiers and literals', () => {
    expect(quoteIdent('my_app')).toBe('"my_app"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(quoteLiteral('SCRAM-SHA-256$4096:a$b:c')).toBe("'SCRAM-SHA-256$4096:a$b:c'");
  });
  it('creates a NOSUPERUSER login role with a verifier literal', () => {
    expect(createRoleSql('my_app_app', 'SCRAM-SHA-256$4096:s$k:k')).toBe(
      `CREATE ROLE "my_app_app" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD 'SCRAM-SHA-256$4096:s$k:k';`,
    );
    expect(grantReplicaRoleSql('my_app_app')).toBe(
      'GRANT SET ON PARAMETER session_replication_role TO "my_app_app";',
    );
    expect(createDatabaseSql('my_app', 'my_app_app')).toBe(
      'CREATE DATABASE "my_app" OWNER "my_app_app";',
    );
  });
  it('extensions', () => {
    expect(extensionsSql(['pgcrypto', 'uuid-ossp'])).toBe(
      'CREATE EXTENSION IF NOT EXISTS "pgcrypto";\nCREATE EXTENSION IF NOT EXISTS "uuid-ossp";\n',
    );
    expect(() => validateExtensions(['pg;drop'])).toThrow(/extension/);
  });
  it('tuning scales with memory', () => {
    const sql = tuningSql(536870912);
    expect(sql).toContain("ALTER SYSTEM SET shared_buffers = '128MB';");
    expect(sql).toContain("ALTER SYSTEM SET effective_cache_size = '384MB';");
    expect(sql).toContain("ALTER SYSTEM SET max_connections = '50';");
    expect(sql).toContain("ALTER SYSTEM SET work_mem = '4MB';");
    expect(sql).toContain("ALTER SYSTEM SET random_page_cost = '1.1';");
    expect(sql).toContain("ALTER SYSTEM SET huge_pages = 'off';");
    expect(tuningSql(2 * 1024 ** 3)).toContain("shared_buffers = '512MB'");
  });
});
