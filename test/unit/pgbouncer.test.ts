import { describe, expect, it } from 'vitest';
import { renderPgbouncerIni, renderUserlist } from '../../src/core/pgbouncer.js';
import { fakeProject } from '../helpers/project.js';

const opts = { certDir: '/certs/db.example.com' };

describe('renderPgbouncerIni', () => {
  it('renders a valid file with zero projects', () => {
    const ini = renderPgbouncerIni([], opts);
    expect(ini).toMatch(/^\[databases\]\n\n\[pgbouncer\]\n/m);
    expect(ini).toContain('pool_mode = transaction');
    expect(ini).toContain('max_prepared_statements = 200');
    expect(ini).toContain('auth_type = scram-sha-256');
    expect(ini).toContain('client_tls_sslmode = require');
    expect(ini).toContain('client_tls_cert_file = /certs/db.example.com/certificate.crt');
    expect(ini).toContain('client_tls_key_file = /certs/db.example.com/privatekey.key');
    expect(ini).toContain('server_tls_sslmode = disable');
    expect(ini).toContain('default_pool_size = 10');
    expect(ini).toContain('max_client_conn = 1000');
    expect(ini).not.toContain('user=');
    expect(ini).not.toContain('sslmode=require');
  });
  it('renders one transaction and one session entry per project, sorted, hyphens kept', () => {
    const ini = renderPgbouncerIni([fakeProject('zeta'), fakeProject('my-app')], opts);
    const dbSection = ini.split('[pgbouncer]')[0] ?? '';
    expect(dbSection).toBe(
      [
        '[databases]',
        'my-app = host=pg-my-app-abc123 port=5432 dbname=my_app',
        'my-app_session = host=pg-my-app-abc123 port=5432 dbname=my_app pool_mode=session pool_size=3 reserve_pool_size=0',
        'zeta = host=pg-zeta-abc123 port=5432 dbname=zeta',
        'zeta_session = host=pg-zeta-abc123 port=5432 dbname=zeta pool_mode=session pool_size=3 reserve_pool_size=0',
        '',
        '',
      ].join('\n'),
    );
  });
});

describe('renderUserlist', () => {
  it('renders one SCRAM line per project', () => {
    expect(renderUserlist([])).toBe('');
    expect(renderUserlist([fakeProject('my-app')])).toBe(
      '"my_app_app" "SCRAM-SHA-256$4096:c2FsdA==$a2V5:a2V5"\n',
    );
  });
});
