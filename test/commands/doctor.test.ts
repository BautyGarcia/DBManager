import { describe, expect, it } from 'vitest';
import { doctorCommand, versionAtLeast } from '../../src/commands/doctor.js';
import { renderPgbouncerIni, renderUserlist } from '../../src/core/pgbouncer.js';
import { upsertProject } from '../../src/core/state.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../helpers/project.js';

const p = fakeProject('my-app');
const ini = renderPgbouncerIni([p], { certDir: '/certs/db.example.com' });
const userlist = renderUserlist([p]);
const in60d = new Date(Date.now() + 60 * 86400_000).toISOString();

function healthyRunner(over: Array<{ match: RegExp; stdout?: string; fail?: boolean }> = []) {
  return makeFakeRunner([
    ...over,
    { match: /^true$/, stdout: '' },
    { match: /pgbouncer --version/, stdout: 'PgBouncer 1.26.0\nlibevent 2.1.12' },
    { match: /cat \/etc\/dokploy\/dbm\/pgbouncer\/pgbouncer\.ini/, stdout: ini },
    { match: /cat \/etc\/dokploy\/dbm\/pgbouncer\/userlist\.txt/, stdout: userlist },
    {
      match: /openssl s_client/,
      stdout: 'notAfter=Dec 29 12:00:00 2026 GMT\nsubject=CN = db.example.com',
    },
    { match: /openssl x509 -in/, stdout: 'notAfter=Dec 29 12:00:00 2026 GMT' },
    { match: /docker info --format/, stdout: 'json-file' },
    { match: /cat \/etc\/docker\/daemon\.json/, stdout: '{"log-opts":{"max-size":"10m"}}' },
    {
      match: /tailscale status --json/,
      stdout: JSON.stringify({
        BackendState: 'Running',
        Self: { KeyExpiry: in60d, DNSName: 'vps.tail.ts.net.' },
      }),
    },
    { match: /df --output=pcent/, stdout: 'Use%\n 41%' },
    {
      match: /docker inspect --format/,
      stdout:
        '[{"Type":"volume","Name":"pg-my-app-abc123-data","Destination":"/var/lib/postgresql"}]',
    },
  ]);
}

describe('doctor', () => {
  it('passes on a healthy stack', async () => {
    const t = makeTestDeps({ runner: healthyRunner() });
    t.store.state = upsertProject(t.store.state, p);
    t.pg.runSql = async (_t, sql) =>
      sql.includes('server_version') ? '18.6 (Debian)' : '/var/lib/postgresql/18/docker';
    t.garage.buckets.set('b1', {
      id: 'b1',
      globalAliases: ['my-app'],
      bytes: 0,
      objects: 0,
      unfinishedUploads: 0,
      websiteAccess: false,
    });
    t.dokploy.files = [{ Path: 'x', Name: 'x', Size: 1, ModTime: t.deps.now().toISOString() }];
    const r = await doctorCommand(t.deps);
    const failed = r.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'ssh',
        'dokploy.version',
        'pgbouncer.version',
        'pgbouncer.drift',
        'tls.cert',
        'garage.health',
        'docker.logging',
        'tailscale',
        'disk',
        'my-app.postgres.version',
        'my-app.postgres.datadir',
        'my-app.backup.age',
        'my-app.storage.uploads',
      ]),
    );
  });
  it('fails on an old PgBouncer and warns on a stale backup', async () => {
    const t = makeTestDeps({
      runner: healthyRunner([{ match: /pgbouncer --version/, stdout: 'PgBouncer 1.25.2' }]),
    });
    t.store.state = upsertProject(t.store.state, p);
    t.pg.runSql = async (_t, sql) =>
      sql.includes('server_version') ? '18.6' : '/var/lib/postgresql/18/docker';
    t.dokploy.files = [{ Path: 'x', Name: 'x', Size: 1, ModTime: '2026-09-01T00:00:00Z' }];
    const r = await doctorCommand(t.deps);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'pgbouncer.version')).toMatchObject({
      ok: false,
      level: 'fail',
    });
    expect(r.checks.find((c) => c.name === 'my-app.backup.age')).toMatchObject({
      ok: false,
      level: 'warn',
    });
  });
  it('versionAtLeast', () => {
    expect(versionAtLeast('0.30.8', '0.30.0')).toBe(true);
    expect(versionAtLeast('0.29.13', '0.30.0')).toBe(false);
    expect(versionAtLeast('18.6', '18.6')).toBe(true);
    expect(versionAtLeast('17.10', '17.11')).toBe(false);
  });
});
