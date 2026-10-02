import { describe, expect, it } from 'vitest';
import type { SshRunner } from '../../src/adapters/types.js';
import type { Io } from '../../src/cli.js';
import { INIT_STEPS, type InitAdapters, initCommand } from '../../src/commands/init.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';
import {
  FakeDokploy,
  FakeGarage,
  MemoryStore,
  makeTestDeps,
  seedProject,
  testConfigInput,
} from '../helpers/fakes.js';
import { fakeProject } from '../helpers/project.js';

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

/** Runner whose tailscale status is NeedsLogin until `tailscale up` ran (then Running if `upWorks`). */
function tailscaleRunner(h: ReturnType<typeof harness>, upWorks: boolean) {
  let upCalled = false;
  const status = (state: string) =>
    JSON.stringify({ BackendState: state, Self: { DNSName: 'dbm-vps.tail1234.ts.net.' } });
  const runner = makeFakeRunner([
    {
      match: /tailscale status --json/,
      get stdout() {
        return status(upCalled && upWorks ? 'Running' : 'NeedsLogin');
      },
    },
    { match: /docker service ls/, stdout: 'dokploy' },
    { match: /http_code/, stdout: '200' },
    { match: /openssl s_client/, stdout: "issuer=O = Let's Encrypt" },
    { match: /pgbouncer --version/, stdout: 'PgBouncer 1.26.0' },
    { match: /--config \/c\.conf cat/, stdout: 'smoke-ok' },
  ]);
  const run = runner.runner.run;
  runner.runner.run = async (argv, o) => {
    if (argv.join(' ').includes('tailscale up')) upCalled = true;
    return run(argv, o);
  };
  const adapters: InitAdapters = {
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
  };
  return { runner, adapters };
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
    expect(cfg.dokployUrl).toBe('https://dbm-vps.tail1234.ts.net:8443');
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
    // secrets do not outlive a successful init on this machine; only the target host is kept
    expect(h.store.progress.values).toEqual({ host: '1.2.3.4' });
    expect(Object.keys(h.store.progress.done)).toEqual([...INIT_STEPS]);
  });
  it('resumes: completed steps are skipped on re-run', async () => {
    const h = harness();
    h.store.progress = {
      done: { harden: true, tailscale: true, dokploy: true },
      values: { tailnetUrl: 'https://dbm-vps.tail1234.ts.net:8443' },
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
  it('logs in to tailscale via a 0600 key file (never argv) when status goes NeedsLogin -> Running', async () => {
    const h = harness();
    const t = tailscaleRunner(h, true);
    await initCommand(h.store, h.io, opts, t.adapters);
    const key = t.runner.uploads.find((u) => u.path === '/root/.dbm-tskey');
    expect(key?.content).toBe('tskey-x');
    expect(key?.mode).toBe('0600');
    const up = t.runner.calls.find((c) => c.argv.join(' ').includes('tailscale up'));
    expect(up?.argv.join(' ')).toContain('--auth-key=file:/root/.dbm-tskey');
    expect(up?.argv.join(' ')).toContain('rc=$?; rm -f /root/.dbm-tskey; exit $rc');
    expect(t.runner.calls.some((c) => c.argv.join(' ').includes('tskey-x'))).toBe(false);
  });
  it('fails the tailscale step when the backend is still not Running after up', async () => {
    const h = harness();
    const t = tailscaleRunner(h, false);
    await expect(initCommand(h.store, h.io, opts, t.adapters)).rejects.toThrow(/NeedsLogin/);
    expect(h.store.progress.done.tailscale).toBeUndefined();
    expect(h.store.progress.done.harden).toBe(true);
  });
  it('keeps the smoke error when destroying dbm-smoke also fails', async () => {
    const h = harness();
    h.dokploy.failAt.add('removePostgres');
    const adapters: InitAdapters = { ...h.adapters, probePostgres: async () => false };
    await expect(initCommand(h.store, h.io, opts, adapters)).rejects.toThrow(/could not connect/);
    expect(h.errLines.join('')).toMatch(/warning: could not destroy dbm-smoke/);
  });
  it('removes a leftover dbm-smoke before re-running the smoke step', async () => {
    const h = harness();
    await h.store.saveConfig(testConfigInput);
    seedProject(h, fakeProject('dbm-smoke'));
    h.store.progress = {
      done: Object.fromEntries(INIT_STEPS.filter((s) => s !== 'smoke').map((s) => [s, true])),
      values: {},
    };
    await initCommand(h.store, h.io, opts, h.adapters);
    expect(h.errLines.join('')).toMatch(/removing leftover dbm-smoke/);
    expect(h.dokploy.calls.filter((c) => c === 'createPostgres')).toHaveLength(1);
    expect(h.store.state.projects['dbm-smoke']).toBeUndefined();
    expect(h.store.progress.done.smoke).toBe(true);
  });
  it('reuses an existing dbm-dumps destination', async () => {
    const h = harness();
    h.dokploy.destinations.push({ destinationId: 'dX', name: 'dbm-dumps' });
    const cfg = await initCommand(h.store, h.io, opts, h.adapters);
    expect(cfg.dumpsDestinationId).toBe('dX');
    expect(h.dokploy.calls).not.toContain('createDestination');
  });
  it('adds an additionalFlags hint when the destination test fails', async () => {
    const h = harness();
    h.dokploy.failAt.add('testDestination');
    await expect(initCommand(h.store, h.io, opts, h.adapters)).rejects.toThrow(/additionalFlags/);
  });
  it('re-running after a failure in garage reuses minted tokens and updates the compose', async () => {
    const h = harness();
    let failS3Router = true;
    const flaky: SshRunner = {
      ...h.runner.runner,
      async upload(path, content, o) {
        if (failS3Router && path.endsWith('/dbm-s3.yml')) throw new Error('upload failed');
        return h.runner.runner.upload(path, content, o);
      },
    };
    const adapters: InitAdapters = { ...h.adapters, makeRunner: () => flaky };
    await expect(initCommand(h.store, h.io, opts, adapters)).rejects.toThrow(/upload failed/);
    expect(h.store.progress.done.garage).toBeUndefined();
    expect(h.store.progress.values.garageAdminToken).toBe('scoped');
    failS3Router = false;
    await initCommand(h.store, h.io, opts, adapters);
    expect(h.garage.calls.filter((c) => c === 'createAdminToken')).toHaveLength(1);
    expect([...h.garage.keys.values()].filter((k) => k.name === 'dbm-backup')).toHaveLength(1);
    expect(h.dokploy.calls.filter((c) => c === 'createCompose')).toHaveLength(2);
    expect(h.dokploy.composes.map((c) => c.name)).toEqual(['dbm-garage', 'dbm-pgbouncer']);
  });
  it('creates the two compose services once; a resumed run creates none', async () => {
    const h = harness();
    h.dokploy.failAt.add('createDestination');
    await expect(initCommand(h.store, h.io, opts, h.adapters)).rejects.toThrow();
    expect(h.dokploy.calls.filter((c) => c === 'createCompose')).toHaveLength(2);
    h.dokploy.failAt.clear();
    const before = h.dokploy.calls.length;
    await initCommand(h.store, h.io, opts, h.adapters);
    const second = h.dokploy.calls.slice(before);
    expect(second.filter((c) => c === 'createCompose')).toHaveLength(0);
    expect(h.garage.calls.filter((c) => c === 'createAdminToken')).toHaveLength(1);
    expect(h.store.progress.values).toEqual({ host: '1.2.3.4' });
  });
  it('self-ca fails when the CA script prints no certificate', async () => {
    const h = harness();
    await expect(
      initCommand(h.store, h.io, { ...opts, tls: 'self-ca' }, h.adapters),
    ).rejects.toThrow(/did not print a certificate/);
  });
  it('a re-run against a different host starts from scratch (VPS lost)', async () => {
    const h = harness();
    await initCommand(h.store, h.io, opts, h.adapters);
    expect(h.store.progress.values.host).toBe('1.2.3.4');
    // Same host: everything is skipped.
    h.runner.calls.length = 0;
    await initCommand(h.store, h.io, opts, h.adapters);
    expect(h.runner.calls.some((c) => c.argv.join(' ') === 'bash -s')).toBe(false);
    // New host: nothing is kept, every step runs again.
    h.errLines.length = 0;
    h.runner.calls.length = 0;
    await initCommand(h.store, h.io, { ...opts, host: '5.6.7.8' }, h.adapters);
    expect(h.errLines.join('')).toMatch(/host changed: starting init from scratch/);
    expect(h.errLines.join('')).not.toMatch(/skip harden/);
    expect(h.runner.calls.some((c) => c.argv.join(' ') === 'bash -s')).toBe(true);
    expect(Object.keys(h.store.progress.done)).toEqual([...INIT_STEPS]);
    expect(h.store.progress.values).toEqual({ host: '5.6.7.8' });
    expect((await h.store.requireConfig()).sshHost).toBe('5.6.7.8');
  });
  it('a host change also discards values minted for the old host', async () => {
    const h = harness();
    h.store.progress = {
      done: { harden: true, tailscale: true },
      values: { host: '9.9.9.9', tailnetUrl: 'https://old.ts.net', garageMasterToken: 'old' },
    };
    await initCommand(h.store, h.io, opts, h.adapters);
    expect(h.errLines.join('')).toMatch(/host changed/);
    expect((await h.store.requireConfig()).dokployUrl).toBe('https://dbm-vps.tail1234.ts.net:8443');
  });
  it.each(['Europe/Berlin; rm -rf /', '$(id)', 'a b', ''])(
    'rejects --timezone %j before touching the host',
    async (tz) => {
      const h = harness();
      await expect(
        initCommand(h.store, h.io, { ...opts, timezone: tz }, h.adapters),
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(h.runner.calls).toEqual([]);
    },
  );
  it('accepts IANA timezones and passes them to the hardening script', async () => {
    const h = harness();
    await initCommand(h.store, h.io, { ...opts, timezone: 'Etc/GMT+3' }, h.adapters);
    const harden = h.runner.calls.find((c) => c.argv.join(' ') === 'bash -s');
    expect(harden?.input).toContain('timedatectl set-timezone "Etc/GMT+3"');
  });
});
