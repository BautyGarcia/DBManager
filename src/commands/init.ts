import { randomBytes } from 'node:crypto';
import { quote } from 'shlex';
import { makeDokployClient } from '../adapters/dokploy.js';
import { GARAGE_CLI_SCOPE, makeGarageAdmin } from '../adapters/garage.js';
import { makeSshRunner } from '../adapters/ssh.js';
import type { InitProgress, StateStore } from '../adapters/store.js';
import type { DokployClient, GarageAdmin, SshRunner } from '../adapters/types.js';
import type { Io } from '../cli.js';
import { IMAGES, renderGarageCompose, renderPgbouncerCompose } from '../core/compose.js';
import type { Config, ConfigInput } from '../core/config.js';
import { remoteError, userError } from '../core/exit.js';
import { renderGarageToml } from '../core/garage-config.js';
import { DEFAULT_HARDEN, renderHardenScript } from '../core/harden.js';
import {
  renderPgbouncerReloadCron,
  renderRcloneConf,
  renderStorageSyncCron,
} from '../core/host-files.js';
import { renderPgbouncerIni, renderUserlist } from '../core/pgbouncer.js';
import { randomSecret } from '../core/secrets.js';
import { renderDbCertRouter, renderHttpRouter } from '../core/traefik.js';
import { type Deps, makeDepsFromConfig, waitUntil } from './context.js';
import { createCommand } from './create.js';
import { destroyCommand } from './destroy.js';
import { MIN_VERSIONS, versionAtLeast } from './doctor.js';

export interface InitOptions {
  host: string;
  user?: string;
  domain: string;
  tls?: 'letsencrypt' | 'self-ca';
  hostname?: string;
  timezone?: string;
  tailscaleAuthKey?: string;
  dokployApiKey?: string;
  b2?: {
    endpoint: string;
    region: string;
    keyId: string;
    keySecret: string;
    dumpsBucket: string;
    storageBucket: string;
  };
}

export interface InitAdapters {
  makeRunner: (host: string, user: string) => SshRunner;
  makeDokploy: (url: string, key: string) => DokployClient;
  makeGarage: (runner: SshRunner, port: number, token: string) => GarageAdmin;
  makeDeps: (cfg: Config, store: StateStore, io: Io) => Deps;
  prompt: (question: string, opts?: { secret?: boolean }) => Promise<string>;
  probePostgres: (o: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    ca?: string;
  }) => Promise<boolean>;
}

/** tailscale serve HTTPS port for the Dokploy dashboard/API (443 conflicts with Traefik). */
export const TAILSCALE_SERVE_PORT = 8443;

export const INIT_STEPS = [
  'harden',
  'tailscale',
  'dokploy',
  'apikey',
  'project',
  'garage',
  'pgbouncer',
  'destination',
  'config',
  'smoke',
] as const;

async function ttyPrompt(question: string, opts: { secret?: boolean } = {}): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const { Writable } = await import('node:stream');
  let muted = false;
  // Secrets are typed with echo suppressed: readline writes the echo through this stream.
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stderr.write(chunk);
      cb();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: Boolean(process.stdin.isTTY),
  });
  try {
    const answer = rl.question(`${question} `);
    muted = Boolean(opts.secret);
    const value = (await answer).trim();
    if (muted) process.stderr.write('\n');
    return value;
  } finally {
    rl.close();
  }
}

async function realProbePostgres(o: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ca?: string;
}): Promise<boolean> {
  const { default: pg } = await import('pg');
  const c = new pg.Client({
    host: o.host,
    port: o.port,
    user: o.user,
    password: o.password,
    database: o.database,
    ssl: { servername: o.host, ...(o.ca ? { ca: o.ca } : {}) },
    connectionTimeoutMillis: 15_000,
  });
  try {
    await c.connect();
    const r = await c.query('select 1 as n');
    return r.rows[0]?.n === 1;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}

export const realInitAdapters: InitAdapters = {
  makeRunner: (host, user) => makeSshRunner({ host, user }),
  makeDokploy: (url, key) => makeDokployClient({ baseUrl: url, apiKey: key }),
  makeGarage: (runner, port, token) => makeGarageAdmin(runner, { port, token }),
  makeDeps: makeDepsFromConfig,
  prompt: ttyPrompt,
  probePostgres: realProbePostgres,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const TIMEZONE_RE = /^[A-Za-z0-9_+/-]+$/;

export async function initCommand(
  store: StateStore,
  io: Io,
  o: InitOptions,
  a: InitAdapters = realInitAdapters,
): Promise<Config> {
  const user = o.user ?? 'root';
  const tls = o.tls ?? 'letsencrypt';
  const hostname = o.hostname ?? 'dbm-vps';
  const timezone = o.timezone ?? DEFAULT_HARDEN.timezone;
  // Interpolated into the hardening script: only IANA-name characters.
  if (!TIMEZONE_RE.test(timezone))
    throw userError(
      `invalid --timezone ${JSON.stringify(timezone)}: use an IANA name like America/Argentina/Buenos_Aires`,
      'init',
    );
  const dbHost = `db.${o.domain}`;
  const s3Host = `s3.${o.domain}`;
  const webDomain = `web.${o.domain}`;
  const remote = {
    pgbouncerConfDir: '/etc/dokploy/dbm/pgbouncer',
    certsDir: '/etc/dokploy/dbm/certs',
    garageConfDir: '/etc/dokploy/dbm/garage',
    rcloneConfDir: '/etc/dokploy/dbm/rclone',
    traefikDynamicDir: '/etc/dokploy/traefik/dynamic',
    dockerNetwork: 'dokploy-network',
    pgbouncerContainer: 'dbm-pgbouncer',
    garageContainer: 'dbm-garage',
    garageAdminPort: 3903,
    dbPort: 6432,
  };
  const ssh = a.makeRunner(o.host, user);
  let progress: InitProgress = await store.loadInitProgress();
  if (progress.values.host !== undefined && progress.values.host !== o.host) {
    // VPS lost / moved: steps done on the old host mean nothing on the new one.
    io.err(
      `host changed: starting init from scratch (was ${progress.values.host}, now ${o.host})\n`,
    );
    progress = { done: {}, values: {} };
  }
  progress.values.host = o.host;
  await store.saveInitProgress(progress);
  const v = progress.values;
  /** Persist values minted mid-step (secrets, tokens, keys) so a failed step re-run reuses them. */
  const checkpoint = () => store.saveInitProgress(progress);
  const need = (key: string): string => {
    const val = v[key];
    if (!val)
      throw userError(
        `init state is missing ${key}; delete ~/.dbm/init-progress.json to start over`,
        'init',
      );
    return val;
  };
  const b2 = async () => {
    if (o.b2) return o.b2;
    if (!v.b2Endpoint) {
      v.b2Endpoint = await a.prompt(
        'Backblaze B2 S3 endpoint (https://s3.<region>.backblazeb2.com):',
      );
      v.b2Region = await a.prompt('B2 region (e.g. us-west-004):');
      v.b2KeyId = await a.prompt('B2 application keyID (Read/Write on both buckets):');
      v.b2KeySecret = await a.prompt('B2 applicationKey:', { secret: true });
      v.b2DumpsBucket = await a.prompt('B2 bucket for database dumps (30-day delete rule):');
      v.b2StorageBucket = await a.prompt('B2 bucket for storage mirror (keep versions 30 days):');
    }
    return {
      endpoint: need('b2Endpoint'),
      region: need('b2Region'),
      keyId: need('b2KeyId'),
      keySecret: need('b2KeySecret'),
      dumpsBucket: need('b2DumpsBucket'),
      storageBucket: need('b2StorageBucket'),
    };
  };
  const dokploy = () => a.makeDokploy(need('tailnetUrl'), need('dokployApiKey'));
  const findCompose = async (name: string) => {
    const p = await dokploy().getProject(need('dokployProjectId'));
    return p.environments.flatMap((e) => e.compose).find((c) => c.name === name)?.composeId;
  };
  const upsertCompose = async (name: string, composeFile: string, env: string) => {
    let composeId = await findCompose(name);
    if (!composeId)
      composeId = (
        await dokploy().createCompose({
          name,
          appName: name,
          environmentId: need('dokployEnvironmentId'),
          composeFile,
          env,
        })
      ).composeId;
    await dokploy().updateCompose({ composeId, composeFile, env });
    await dokploy().deployCompose(composeId);
    return composeId;
  };

  const steps: Record<(typeof INIT_STEPS)[number], () => Promise<void>> = {
    async harden() {
      await ssh.run(['bash', '-s'], {
        input: renderHardenScript({ ...DEFAULT_HARDEN, timezone }),
        timeoutMs: 20 * 60_000,
      });
    },
    async tailscale() {
      await ssh.run(['bash', '-s'], {
        input: `set -e
if ! command -v tailscale >/dev/null 2>&1; then
  . /etc/os-release
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/\${VERSION_CODENAME}.noarmor.gpg" | tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/\${VERSION_CODENAME}.tailscale-keyring.list" | tee /etc/apt/sources.list.d/tailscale.list >/dev/null
  apt-get update -qq && apt-get install -y -qq tailscale
fi
systemctl enable --now tailscaled
`,
        timeoutMs: 10 * 60_000,
      });
      const status = () =>
        ssh
          .run(['tailscale', 'status', '--json'])
          .then(
            (r) => JSON.parse(r.stdout) as { BackendState: string; Self?: { DNSName?: string } },
          );
      let st = await status();
      if (st.BackendState !== 'Running') {
        const key =
          o.tailscaleAuthKey ??
          (await a.prompt('Tailscale auth key (non-ephemeral, pre-approved, single-use):', {
            secret: true,
          }));
        await ssh.upload('/root/.dbm-tskey', key, { mode: '0600' });
        await ssh.run(
          [
            'sh',
            '-c',
            `tailscale up --auth-key=file:/root/.dbm-tskey --hostname=${quote(hostname)}; rc=$?; rm -f /root/.dbm-tskey; exit $rc`,
          ],
          { timeoutMs: 120_000 },
        );
        st = await status();
        if (st.BackendState !== 'Running')
          throw remoteError(
            `tailscale is ${st.BackendState} after 'tailscale up'; check that the auth key is valid, single-use and pre-approved`,
            'init.tailscale',
          );
      }
      // 8443, not 443: tailscale serve binds a real socket on the tailnet IP, which trips the
      // Dokploy installer's port check and would collide with Traefik's 0.0.0.0:443.
      await ssh.run([
        'tailscale',
        'serve',
        '--bg',
        `--https=${TAILSCALE_SERVE_PORT}`,
        'http://127.0.0.1:3000',
      ]);
      const fqdn = st.Self?.DNSName?.replace(/\.$/, '');
      if (!fqdn)
        throw userError(
          'tailscale did not report a DNS name; enable MagicDNS in the admin console',
          'init.tailscale',
        );
      v.tailnetUrl = `https://${fqdn}:${TAILSCALE_SERVE_PORT}`;
    },
    async dokploy() {
      const services = (
        await ssh
          .run(['docker', 'service', 'ls', '--format', '{{.Name}}'])
          .catch(() => ({ stdout: '' }))
      ).stdout;
      if (!services.split('\n').includes('dokploy')) {
        io.err('installing Dokploy (this takes a few minutes)...\n');
        await ssh.run(['sh', '-c', 'curl -sSL https://dokploy.com/install.sh | sh'], {
          timeoutMs: 20 * 60_000,
        });
      }
      await waitUntil(
        async () => {
          const code = (
            await ssh
              .run([
                'curl',
                '-s',
                '-o',
                '/dev/null',
                '-w',
                '%{http_code}',
                'http://127.0.0.1:3000/',
              ])
              .catch(() => ({ stdout: '000' }))
          ).stdout.trim();
          return /^[23]\d\d$/.test(code);
        },
        {
          timeoutMs: 300_000,
          intervalMs: 5_000,
          sleep,
          what: 'Dokploy on :3000',
          step: 'init.dokploy',
        },
      );
    },
    async apikey() {
      const pasted =
        o.dokployApiKey ??
        (await a.prompt(
          `Open ${need('tailnetUrl')} , create the admin account, then Settings -> Profile -> API/CLI tab -> Generate API Key (Rate limiting off, limits empty). Paste it:`,
          { secret: true },
        ));
      const tmp = a.makeDokploy(need('tailnetUrl'), pasted);
      const version = await tmp.getVersion();
      if (!versionAtLeast(version, MIN_VERSIONS.dokploy))
        throw userError(
          `Dokploy ${version} is too old; dbm needs >= ${MIN_VERSIONS.dokploy} (run the installer with 'sh -s update')`,
          'init.apikey',
        );
      const org = (await tmp.listOrganizations())[0];
      if (!org) throw userError('no Dokploy organization found for this key', 'init.apikey');
      v.dokployApiKey = await tmp.createApiKey({ name: 'dbm', organizationId: org.id });
      await checkpoint();
      io.err('minted a dedicated "dbm" API key; you may revoke the pasted one in the dashboard\n');
    },
    async project() {
      const existing = (await dokploy().listProjects()).find((p) => p.name === 'dbm');
      if (existing) {
        v.dokployProjectId = existing.projectId;
        v.dokployEnvironmentId =
          existing.environments.find((e) => e.name === 'production')?.environmentId ??
          existing.environments[0]?.environmentId ??
          '';
      } else {
        const created = await dokploy().createProject('dbm');
        v.dokployProjectId = created.projectId;
        v.dokployEnvironmentId = created.environmentId;
      }
      need('dokployEnvironmentId');
    },
    async garage() {
      v.garageRpcSecret ??= randomBytes(32).toString('hex');
      v.garageMasterToken ??= randomSecret(32);
      await checkpoint();
      await ssh.upload(`${remote.garageConfDir}/garage.toml`, renderGarageToml({ webDomain }), {
        mode: '0644',
      });
      await upsertCompose(
        'dbm-garage',
        renderGarageCompose({
          network: remote.dockerNetwork,
          garageConfDir: remote.garageConfDir,
          adminPort: remote.garageAdminPort,
        }),
        `GARAGE_RPC_SECRET=${v.garageRpcSecret}\nGARAGE_ADMIN_TOKEN=${v.garageMasterToken}\n`,
      );
      const master = a.makeGarage(ssh, remote.garageAdminPort, v.garageMasterToken);
      await waitUntil(() => master.health(), {
        timeoutMs: 180_000,
        intervalMs: 5_000,
        sleep,
        what: 'garage /health',
        step: 'init.garage',
      });
      if (!v.garageAdminToken) {
        v.garageAdminToken = (await master.createAdminToken('dbm', GARAGE_CLI_SCOPE)).secretToken;
        await checkpoint();
      }
      if (!v.garageBackupKeyId) {
        const k = await master.createKey('dbm-backup');
        v.garageBackupKeyId = k.accessKeyId;
        v.garageBackupKeySecret = k.secretAccessKey;
        await checkpoint();
      }
      await ssh.upload(
        `${remote.traefikDynamicDir}/dbm-s3.yml`,
        renderHttpRouter({
          name: 'dbm-s3',
          hosts: [s3Host],
          serviceUrl: `http://${remote.garageContainer}:3900`,
        }),
        { mode: '0644' },
      );
    },
    async pgbouncer() {
      const certDir = `/certs/${dbHost}`;
      await ssh.upload(
        `${remote.pgbouncerConfDir}/pgbouncer.ini`,
        renderPgbouncerIni([], { certDir }),
        { mode: '0644' },
      );
      await ssh.upload(`${remote.pgbouncerConfDir}/userlist.txt`, renderUserlist([]), {
        mode: '0644',
      });
      if (tls === 'letsencrypt') {
        await ssh.upload(
          `${remote.traefikDynamicDir}/dbm-db-cert.yml`,
          renderDbCertRouter(dbHost),
          { mode: '0644' },
        );
        io.err(
          `waiting for Let's Encrypt certificate for ${dbHost} (DNS must already point here)...\n`,
        );
        await waitUntil(
          async () => {
            const r = await ssh
              .run([
                'sh',
                '-c',
                `openssl s_client -connect 127.0.0.1:443 -servername ${quote(dbHost)} </dev/null 2>/dev/null | openssl x509 -noout -issuer`,
              ])
              .catch(() => ({ stdout: '' }));
            return /Let's Encrypt/.test(r.stdout);
          },
          {
            timeoutMs: 300_000,
            intervalMs: 10_000,
            sleep,
            what: `certificate for ${dbHost}`,
            step: 'init.pgbouncer.cert',
          },
        );
      } else {
        const r = await ssh.run(['bash', '-s'], {
          input: `set -e
d=${quote(`${remote.certsDir}/${dbHost}`)}; mkdir -p "$d"; cd "$d"
[ -f ca.key ] || openssl req -x509 -newkey rsa:4096 -nodes -days 3650 -keyout ca.key -out ca.crt -subj "/CN=dbm private CA" >/dev/null 2>&1
if [ ! -f privatekey.key ]; then
  openssl req -newkey rsa:2048 -nodes -keyout privatekey.key -out server.csr -subj ${quote(`/CN=${dbHost}`)} -addext ${quote(`subjectAltName=DNS:${dbHost}`)} >/dev/null 2>&1
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 -copy_extensions copy -out certificate.crt >/dev/null 2>&1
fi
chown -R 70:70 "$d"; chmod 600 privatekey.key
cat ca.crt
`,
        });
        if (!r.stdout.includes('-----BEGIN CERTIFICATE-----'))
          throw remoteError(
            `self-signed CA generation did not print a certificate: ${JSON.stringify(r.stdout.slice(0, 200))}`,
            'init.pgbouncer.ca',
          );
        v.sslCaPem = `${r.stdout.trim()}\n`;
      }
      await upsertCompose(
        'dbm-pgbouncer',
        renderPgbouncerCompose({
          network: remote.dockerNetwork,
          pgbouncerConfDir: remote.pgbouncerConfDir,
          certsDir: remote.certsDir,
          traefikDynamicDir: remote.traefikDynamicDir,
          tls,
        }),
        '',
      );
      if (tls === 'letsencrypt') {
        await waitUntil(
          () =>
            ssh.run(['test', '-f', `${remote.certsDir}/${dbHost}/certificate.crt`]).then(
              () => true,
              () => false,
            ),
          {
            timeoutMs: 180_000,
            intervalMs: 5_000,
            sleep,
            what: 'certs-dumper output',
            step: 'init.pgbouncer.dumper',
          },
        );
      }
      await ssh.upload(
        '/etc/cron.d/dbm-pgbouncer-reload',
        renderPgbouncerReloadCron({
          certsDir: remote.certsDir,
          pgbouncerContainer: remote.pgbouncerContainer,
        }),
        { mode: '0644' },
      );
      await ssh.run([
        'sh',
        '-c',
        // The dumper writes certs as root and PgBouncer (uid 70) may already have exited on
        // "permission denied"; a SIGHUP cannot revive it, so fix ownership and restart.
        `chown -R 70:70 ${quote(remote.certsDir)}; chmod -R go-rwx ${quote(remote.certsDir)}; docker restart ${quote(remote.pgbouncerContainer)} >/dev/null 2>&1 || true`,
      ]);
      await waitUntil(
        () =>
          ssh.run(['docker', 'exec', remote.pgbouncerContainer, 'pgbouncer', '--version']).then(
            () => true,
            () => false,
          ),
        {
          timeoutMs: 120_000,
          intervalMs: 5_000,
          sleep,
          what: 'pgbouncer container',
          step: 'init.pgbouncer',
        },
      );
    },
    async destination() {
      const b = await b2();
      const input = {
        name: 'dbm-dumps',
        provider: 'Other',
        accessKey: b.keyId,
        secretAccessKey: b.keySecret,
        bucket: b.dumpsBucket,
        region: b.region,
        endpoint: b.endpoint,
        // Skip the post-upload HEAD: Backblaze counts it as a Class B transaction and, past the daily
        // cap, answers 403, which Dokploy treats as a failed backup and deletes the good upload.
        additionalFlags: ['--s3-no-head'],
      };
      try {
        await dokploy().testDestination(input);
      } catch (e) {
        throw remoteError(
          `${e instanceof Error ? e.message : String(e)}\nIf this is Backblaze B2 with provider Other, check endpoint/region, or pass rclone flags via additionalFlags (see docs/runbook.md)`,
          'init.destination',
        );
      }
      if (!v.dumpsDestinationId) {
        const existing = (await dokploy().listDestinations()).find((d) => d.name === input.name);
        v.dumpsDestinationId =
          existing?.destinationId ?? (await dokploy().createDestination(input)).destinationId;
        await checkpoint();
      }
      await ssh.upload(
        `${remote.rcloneConfDir}/rclone.conf`,
        renderRcloneConf({
          garage: {
            keyId: need('garageBackupKeyId'),
            keySecret: need('garageBackupKeySecret'),
            endpoint: `http://${remote.garageContainer}:3900`,
          },
          b2: { endpoint: b.endpoint, region: b.region, keyId: b.keyId, keySecret: b.keySecret },
        }),
        { mode: '0600' },
      );
      await ssh.upload(
        '/etc/cron.d/dbm-storage-sync',
        renderStorageSyncCron({
          network: remote.dockerNetwork,
          rcloneConfDir: remote.rcloneConfDir,
          storageBucket: b.storageBucket,
        }),
        { mode: '0644' },
      );
    },
    async config() {
      const cfg: ConfigInput = {
        sshHost: o.host,
        sshUser: user,
        dokployUrl: need('tailnetUrl'),
        dokployApiKey: need('dokployApiKey'),
        dokployProjectId: need('dokployProjectId'),
        dokployEnvironmentId: need('dokployEnvironmentId'),
        domain: o.domain,
        dbHost,
        s3Host,
        webDomain,
        garageAdminToken: need('garageAdminToken'),
        garageBackupKeyId: need('garageBackupKeyId'),
        dumpsDestinationId: need('dumpsDestinationId'),
        tls,
        ...(v.sslCaPem ? { sslCaPem: v.sslCaPem } : {}),
        remote,
      };
      await store.saveConfig(cfg);
    },
    async smoke() {
      const cfg = await store.requireConfig();
      const deps = a.makeDeps(cfg, store, io);
      const destroySmoke = () =>
        destroyCommand(deps, {
          slug: 'dbm-smoke',
          purgeStorage: true,
          yes: true,
          confirmSlug: 'dbm-smoke',
        });
      if ((await store.loadState()).projects['dbm-smoke']) {
        io.err('removing leftover dbm-smoke from a previous run...\n');
        await destroySmoke();
      }
      io.err('smoke test: creating dbm-smoke...\n');
      const created = await createCommand(deps, { slug: 'dbm-smoke', internal: true });
      let smokeError: unknown;
      try {
        const p = created.project;
        for (const db of ['dbm-smoke', 'dbm-smoke_session']) {
          const ok = await a.probePostgres({
            host: dbHost,
            port: 6432,
            user: p.postgres.appRole,
            password: p.postgres.appPassword,
            database: db,
            ...(cfg.sslCaPem ? { ca: cfg.sslCaPem } : {}),
          });
          if (!ok)
            throw userError(
              `could not connect to ${dbHost}:6432/${db} with certificate verification from this machine`,
              'init.smoke.postgres',
            );
        }
        if (!p.storage)
          throw remoteError('dbm-smoke was created without a storage bucket', 'init.smoke.s3');
        const conf = `[g]\ntype = s3\nprovider = Other\nenv_auth = false\naccess_key_id = ${p.storage.keyId}\nsecret_access_key = ${p.storage.keySecret}\nendpoint = https://${s3Host}\nregion = garage\nforce_path_style = true\nno_check_bucket = true\n`;
        await ssh.upload('/root/.dbm-smoke-rclone.conf', conf, { mode: '0600' });
        const obj = quote(`g:${p.storage.bucket}/smoke.txt`);
        // On rcat failure remove the credentials file before failing.
        await ssh.run([
          'sh',
          '-c',
          `printf smoke-ok | docker run --rm -i -v /root/.dbm-smoke-rclone.conf:/c.conf:ro ${IMAGES.rclone} --config /c.conf rcat ${obj} || { rm -f /root/.dbm-smoke-rclone.conf; exit 1; }`,
        ]);
        const got = await ssh.run([
          'sh',
          '-c',
          `docker run --rm -v /root/.dbm-smoke-rclone.conf:/c.conf:ro ${IMAGES.rclone} --config /c.conf cat ${obj}; rm -f /root/.dbm-smoke-rclone.conf`,
        ]);
        if (got.stdout.trim() !== 'smoke-ok')
          throw userError(
            `S3 round-trip through https://${s3Host} failed: got ${JSON.stringify(got.stdout)}`,
            'init.smoke.s3',
          );
        if (!p.dokploy.backupId)
          throw remoteError('dbm-smoke was created without a backup schedule', 'init.smoke.backup');
        await deps.dokploy.manualBackup(p.dokploy.backupId);
        const files = await deps.dokploy.listBackupFiles(
          cfg.dumpsDestinationId,
          `${p.dokploy.appName}/db/dbm-smoke/`,
        );
        if (!files.length)
          throw userError(
            'manual backup ran but no object appeared in the dumps bucket',
            'init.smoke.backup',
          );
      } catch (e) {
        smokeError = e;
      }
      try {
        await destroySmoke();
      } catch (e) {
        io.err(
          `warning: could not destroy dbm-smoke: ${e instanceof Error ? e.message : String(e)}\n`,
        );
        if (smokeError === undefined) throw e;
      }
      if (smokeError !== undefined) throw smokeError;
    },
  };

  for (const name of INIT_STEPS) {
    if (progress.done[name]) {
      io.err(`skip ${name} (done)\n`);
      continue;
    }
    io.err(`== ${name}\n`);
    await steps[name]();
    progress.done[name] = true;
    await store.saveInitProgress(progress);
  }
  // Spec 5.4: intermediate secrets (Garage master token, B2 secret, ...) must not stay on this machine.
  // The target host is kept (not a secret) so a later init against a different host starts over.
  await store.saveInitProgress({ done: progress.done, values: { host: o.host } });
  const cfg = await store.requireConfig();
  io.err(
    `\ninit complete.\n  dashboard: ${cfg.dokployUrl}\n  database:  ${cfg.dbHost}:6432 (TLS, ${cfg.tls})\n  storage:   https://${cfg.s3Host}\n\nFrom a machine outside the tailnet verify:\n  nc -zv -w3 ${quote(o.host)} 3000   # must FAIL\n  nc -zv -w3 ${quote(cfg.dbHost)} 6432  # must succeed\n`,
  );
  return cfg;
}
