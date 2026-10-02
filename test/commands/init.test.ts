import { describe, expect, it } from 'vitest';
import type { Io } from '../../src/cli.js';
import { INIT_STEPS, type InitAdapters, initCommand } from '../../src/commands/init.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';
import { FakeDokploy, FakeGarage, MemoryStore, makeTestDeps } from '../helpers/fakes.js';

function harness() {
  const runner = makeFakeRunner([
    { match: /^bash -s$/, stdout: '[dbm] host hardening converged' },
    {
      match: /tailscale status --json/,
      stdout: JSON.stringify({
        BackendState: 'Running',
        Self: { DNSName: 'dbm-vps.tail1234.ts.net.' },
      }),
    },
    { match: /docker service ls/, stdout: 'dokploy' },
    {
      match: /curl -s -o \/dev\/null -w %\{http_code\} http:\/\/127\.0\.0\.1:3000\//,
      stdout: '200',
    },
    {
      match: /openssl s_client -connect 127\.0\.0\.1:443/,
      stdout: "issuer=C = US, O = Let's Encrypt, CN = R13",
    },
    { match: /test -f \/etc\/dokploy\/dbm\/certs\/db\.example\.com\/certificate\.crt/, stdout: '' },
    { match: /pgbouncer --version/, stdout: 'PgBouncer 1.26.0' },
    { match: /--config \/c\.conf cat/, stdout: 'smoke-ok' },
  ]);
  const dokploy = new FakeDokploy();
  dokploy.files = [
    {
      Path: 'pg-dbm-smoke-abc123/db/dbm-smoke/x.sql.gz',
      Name: 'x.sql.gz',
      Size: 1,
      ModTime: '2026-09-30T12:00:00Z',
    },
  ];
  const garage = new FakeGarage();
  const store = new MemoryStore();
  const prompts: string[] = [];
  const errLines: string[] = [];
  const io: Io = {
    out: () => {},
    err: (s) => {
      errLines.push(s);
    },
  };
  const adapters: InitAdapters = {
    makeRunner: () => runner.runner,
    makeDokploy: () => dokploy,
    makeGarage: () => garage,
    makeDeps: (cfg, st, io2) =>
      makeTestDeps({ cfg, store: st as MemoryStore, dokploy, garage, runner, io: io2 }).deps,
    prompt: async (q) => {
      prompts.push(q);
      return q.includes('API') ? 'pasted-key' : 'answer';
    },
    probePostgres: async () => true,
  };
  return { runner, dokploy, garage, store, prompts, errLines, io, adapters };
}

const opts = {
  host: '1.2.3.4',
  domain: 'example.com',
  tailscaleAuthKey: 'tskey-x',
  b2: {
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    region: 'us-west-004',
    keyId: 'K',
    keySecret: 'S',
    dumpsBucket: 'dbm-dumps',
    storageBucket: 'dbm-storage',
  },
};

describe('init', () => {
  it('runs every step in order, persists checkpoints, saves config, and leaves no smoke project', async () => {
    const h = harness();
    const cfg = await initCommand(h.store, h.io, opts, h.adapters);
    expect(Object.keys(h.store.progress.done)).toEqual([...INIT_STEPS]);
    expect(cfg.dokployUrl).toBe('https://dbm-vps.tail1234.ts.net');
    expect(cfg.dokployApiKey).toBe('newkey'); // minted, not the pasted one
    expect(cfg.dbHost).toBe('db.example.com');
    expect(cfg.webDomain).toBe('web.example.com');
    expect(cfg.garageAdminToken).toBe('scoped');
    expect(cfg.dumpsDestinationId).toBe('d1');
    expect(h.prompts.some((q) => q.includes('API'))).toBe(true);
    const uploads = h.runner.uploads.map((u) => u.path);
    expect(uploads).toEqual(
      expect.arrayContaining([
        '/etc/dokploy/dbm/garage/garage.toml',
        '/etc/dokploy/traefik/dynamic/dbm-s3.yml',
        '/etc/dokploy/traefik/dynamic/dbm-db-cert.yml',
        '/etc/dokploy/dbm/pgbouncer/pgbouncer.ini',
        '/etc/dokploy/dbm/pgbouncer/userlist.txt',
        '/etc/cron.d/dbm-pgbouncer-reload',
        '/etc/dokploy/dbm/rclone/rclone.conf',
        '/etc/cron.d/dbm-storage-sync',
      ]),
    );
    expect(h.dokploy.calls).toEqual(
      expect.arrayContaining([
        'createProject',
        'createCompose',
        'deployCompose',
        'testDestination',
        'createDestination',
        'createApiKey',
      ]),
    );
    expect(h.garage.calls).toEqual(expect.arrayContaining(['createAdminToken', 'createKey']));
    // smoke project created and destroyed
    expect(h.dokploy.calls.filter((c) => c === 'createPostgres')).toHaveLength(1);
    expect(h.dokploy.calls).toContain('removePostgres');
    expect(h.store.state.projects['dbm-smoke']).toBeUndefined();
    const harden = h.runner.calls.find((c) => c.argv.join(' ') === 'bash -s');
    expect(harden?.input).toContain('set -euo pipefail');
  });
  it('resumes: completed steps are skipped on re-run', async () => {
    const h = harness();
    h.store.progress = {
      done: { harden: true, tailscale: true, dokploy: true },
      values: { tailnetUrl: 'https://dbm-vps.tail1234.ts.net' },
    };
    await initCommand(h.store, h.io, opts, h.adapters);
    expect(h.runner.calls.some((c) => c.argv.join(' ') === 'bash -s')).toBe(false);
    expect(h.errLines.join('')).toMatch(/skip harden/);
  });
  it('self-ca generates a CA on the VPS and stores the PEM', async () => {
    const h = harness();
    const runner = makeFakeRunner([
      // every `bash -s` (harden, tailscale install, CA generation) gets the PEM on stdout; only the CA step reads it
      {
        match: /^bash -s$/,
        stdout: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n',
      },
      {
        match: /tailscale status --json/,
        stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'v.t.ts.net.' } }),
      },
      { match: /docker service ls/, stdout: 'dokploy' },
      { match: /http_code/, stdout: '200' },
      { match: /pgbouncer --version/, stdout: 'PgBouncer 1.26.0' },
      { match: /--config \/c\.conf cat/, stdout: 'smoke-ok' },
    ]);
    const cfg = await initCommand(
      h.store,
      h.io,
      { ...opts, tls: 'self-ca' },
      {
        ...h.adapters,
        makeRunner: () => runner.runner,
        makeDeps: (cfg, st, io2) =>
          makeTestDeps({
            cfg,
            store: st as MemoryStore,
            dokploy: h.dokploy,
            garage: h.garage,
            runner,
            io: io2,
          }).deps,
      },
    );
    expect(cfg.tls).toBe('self-ca');
    expect(cfg.sslCaPem).toContain('BEGIN CERTIFICATE');
    expect(runner.uploads.map((u) => u.path)).not.toContain(
      '/etc/dokploy/traefik/dynamic/dbm-db-cert.yml',
    );
  });
  it('rejects a Dokploy older than 0.30.0', async () => {
    const h = harness();
    h.dokploy.getVersion = async () => '0.29.13';
    await expect(initCommand(h.store, h.io, opts, h.adapters)).rejects.toThrow(/0\.30\.0/);
  });
  it('destroys the smoke project even when the smoke check fails', async () => {
    const h = harness();
    const adapters: InitAdapters = { ...h.adapters, probePostgres: async () => false };
    await expect(initCommand(h.store, h.io, opts, adapters)).rejects.toThrow(/could not connect/);
    expect(h.dokploy.calls).toContain('removePostgres');
    expect(h.store.state.projects['dbm-smoke']).toBeUndefined();
    expect(h.store.progress.done.smoke).toBeUndefined();
    expect(h.store.progress.done.config).toBe(true);
  });
  it('passes the tailscale auth key via a 0600 file, never in argv', async () => {
    const h = harness();
    const runner = makeFakeRunner([
      {
        match: /tailscale status --json/,
        stdout: JSON.stringify({
          BackendState: 'NeedsLogin',
          Self: { DNSName: 'dbm-vps.tail1234.ts.net.' },
        }),
      },
      { match: /docker service ls/, stdout: 'dokploy' },
      { match: /http_code/, stdout: '200' },
      { match: /openssl s_client/, stdout: "issuer=O = Let's Encrypt" },
      { match: /pgbouncer --version/, stdout: 'PgBouncer 1.26.0' },
      { match: /--config \/c\.conf cat/, stdout: 'smoke-ok' },
    ]);
    await initCommand(h.store, h.io, opts, {
      ...h.adapters,
      makeRunner: () => runner.runner,
      makeDeps: (cfg, st, io2) =>
        makeTestDeps({
          cfg,
          store: st as MemoryStore,
          dokploy: h.dokploy,
          garage: h.garage,
          runner,
          io: io2,
        }).deps,
    });
    const key = runner.uploads.find((u) => u.path === '/root/.dbm-tskey');
    expect(key?.content).toBe('tskey-x');
    expect(key?.mode).toBe('0600');
    expect(
      runner.calls.some((c) => c.argv.join(' ').includes('--auth-key=file:/root/.dbm-tskey')),
    ).toBe(true);
    expect(runner.calls.some((c) => c.argv.join(' ').includes('tskey-x'))).toBe(false);
  });
});
