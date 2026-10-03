import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import { makeFileStore, type StateStore } from './adapters/store.js';
import { backupCommand, restoreCommand } from './commands/backup.js';
import { type Deps, makeDeps } from './commands/context.js';
import { createCommand } from './commands/create.js';
import { destroyCommand } from './commands/destroy.js';
import { doctorCommand, externalChecks } from './commands/doctor.js';
import { envCommand } from './commands/env.js';
import { formatReport, importCommand } from './commands/import.js';
import { initCommand } from './commands/init.js';
import { formatTable, listCommand } from './commands/list.js';
import { pauseCommand, resumeCommand } from './commands/pause.js';
import { psqlCommand } from './commands/psql.js';
import { storageCorsCommand, storagePublicCommand } from './commands/storage.js';
import { syncPgbouncerCommand } from './commands/sync-pgbouncer.js';
import { formatEnvBlock } from './core/env.js';
import { DbmError, ExitCode, userError } from './core/exit.js';
import { VERSION } from './version.js';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}
export const stdIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface GlobalOpts {
  json: boolean;
  yes: boolean;
}

export type DepsFactory = (io: Io) => Promise<Deps>;

export const defaultDepsFactory: DepsFactory = (io) => makeDeps(makeFileStore(), io);

/** Every command holds ~/.dbm/lock for its whole run so concurrent commands cannot lose state writes. */
export async function withLock<T>(store: StateStore, fn: () => Promise<T>): Promise<T> {
  await store.acquireLock();
  try {
    return await fn();
  } finally {
    await store.releaseLock();
  }
}

function globals(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals<GlobalOpts>();
}

function emit(io: Io, g: GlobalOpts, json: unknown, human: string): void {
  io.out(g.json ? `${JSON.stringify(json, null, 2)}\n` : human);
}

export function buildProgram(io: Io, depsFactory: DepsFactory = defaultDepsFactory): Command {
  const program = new Command('dbm')
    .version(VERSION)
    .description('Personal database platform on one VPS')
    .option('--json', 'machine-readable output', false)
    .option('--yes', 'skip confirmations (destructive commands then need --confirm <slug>)', false)
    .exitOverride()
    .configureOutput({ writeOut: io.out, writeErr: io.err });

  const withDeps = async <T>(fn: (deps: Deps) => Promise<T>): Promise<T> => {
    const deps = await depsFactory(io);
    return withLock(deps.store, () => fn(deps));
  };

  program
    .command('create')
    .description(
      'Create a project: Postgres container, PgBouncer entries, S3 bucket, nightly backup',
    )
    .argument('<slug>')
    .option('--memory <size>', 'container memory limit', '512m')
    .option('--pg <major>', 'Postgres major version (17|18)', '18')
    .option('--extensions <list>', 'comma-separated extra extensions')
    .option('--no-storage', 'skip the S3 bucket')
    .option('--cors-origin <origin...>', 'allowed CORS origins for browser uploads (default *)')
    .action(async function (
      this: Command,
      slug: string,
      opts: {
        memory: string;
        pg: string;
        extensions?: string;
        storage: boolean;
        corsOrigin?: string[];
      },
    ) {
      const g = globals(this);
      const pg = Number(opts.pg);
      if (pg !== 17 && pg !== 18) throw userError('--pg must be 17 or 18', 'create');
      const r = await withDeps((deps) =>
        createCommand(deps, {
          slug,
          memory: opts.memory,
          pg,
          ...(opts.extensions
            ? {
                extensions: opts.extensions
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              }
            : {}),
          storage: opts.storage,
          ...(opts.corsOrigin ? { corsOrigins: opts.corsOrigin } : {}),
        }),
      );
      emit(
        io,
        g,
        { slug: r.project.slug, status: r.project.status, existed: r.existed, env: r.env },
        `${formatEnvBlock(r.env)}\n# Pin Vercel functions to gru1 (templates/nextjs/vercel.json).\n`,
      );
    });

  program
    .command('list')
    .description('List projects with memory, disk, storage and last backup')
    .action(async function (this: Command) {
      const g = globals(this);
      const rows = await withDeps(listCommand);
      const table = [
        ['SLUG', 'STATUS', 'PG', 'MEMORY', 'VOLUME', 'STORAGE', 'LAST BACKUP', 'CREATED'],
        ...rows.map((r) => [
          r.slug,
          r.status,
          String(r.pgMajor),
          r.memory,
          r.volume,
          r.storage,
          r.lastBackup,
          r.createdAt.slice(0, 10),
        ]),
      ];
      emit(io, g, rows, rows.length ? formatTable(table) : 'no projects\n');
    });

  program
    .command('env')
    .description('Print the env block for a project')
    .argument('<slug>')
    .action(async function (this: Command, slug: string) {
      const g = globals(this);
      const env = await withDeps((deps) => envCommand(deps, slug));
      emit(io, g, env, formatEnvBlock(env));
    });

  for (const [name, fn] of [
    ['pause', pauseCommand],
    ['resume', resumeCommand],
  ] as const) {
    program
      .command(name)
      .description(`${name} a project's Postgres container and its backup schedule`)
      .argument('<slug>')
      .action(async function (this: Command, slug: string) {
        const g = globals(this);
        const p = await withDeps((deps) => fn(deps, slug));
        emit(io, g, { slug: p.slug, status: p.status }, `${p.slug}: ${p.status}\n`);
      });
  }

  program
    .command('destroy')
    .description('Destroy a project (final backup first; off-site dumps kept 30 days)')
    .argument('<slug>')
    .option('--purge-storage', 'also delete the S3 bucket', false)
    .option('--confirm <slug>', 'required with --yes')
    .action(async function (
      this: Command,
      slug: string,
      opts: { purgeStorage: boolean; confirm?: string },
    ) {
      const g = globals(this);
      const r = await withDeps((deps) =>
        destroyCommand(deps, {
          slug,
          purgeStorage: opts.purgeStorage,
          yes: g.yes,
          ...(opts.confirm ? { confirmSlug: opts.confirm } : {}),
        }),
      );
      emit(io, g, r, `destroyed ${r.slug}\n`);
    });

  program
    .command('import')
    .description(
      'Import a Supabase (or any Postgres) database and optionally a storage bucket into a project',
    )
    .argument('<slug>')
    .requiredOption('--from <postgres-url>', 'source direct/session-pooler URL (port 5432)')
    .option('--schemas <list>', 'comma-separated schemas', 'public')
    .option('--storage-endpoint <url>')
    .option('--storage-region <region>')
    .option('--storage-key <id>')
    .option('--storage-secret <secret>')
    .option('--storage-bucket <name>')
    .option(
      '--data-only',
      'skip schema; load data only (rehearsal already created the schema)',
      false,
    )
    .option(
      '--replace',
      'truncate previously imported tables before loading (needs confirmation)',
      false,
    )
    .option(
      '--users-out <file>',
      'export auth.users to a local CSV (mode 0600) for scripts/migrate-supabase-users.ts',
    )
    .option('--confirm <slug>', 'required with --yes --replace')
    .action(async function (
      this: Command,
      slug: string,
      opts: Record<string, string | undefined> & { dataOnly?: boolean; replace?: boolean },
    ) {
      const g = globals(this);
      const storage =
        opts.storageEndpoint &&
        opts.storageRegion &&
        opts.storageKey &&
        opts.storageSecret &&
        opts.storageBucket
          ? {
              endpoint: opts.storageEndpoint,
              region: opts.storageRegion,
              keyId: opts.storageKey,
              keySecret: opts.storageSecret,
              bucket: opts.storageBucket,
            }
          : undefined;
      const r = await withDeps((deps) =>
        importCommand(deps, {
          slug,
          from: opts.from ?? '',
          dataOnly: opts.dataOnly === true,
          replace: opts.replace === true,
          yes: g.yes,
          ...(opts.usersOut ? { usersOut: opts.usersOut } : {}),
          ...(opts.confirm ? { confirmSlug: opts.confirm } : {}),
          schemas: (opts.schemas ?? 'public')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          ...(storage ? { storage } : {}),
        }),
      );
      emit(io, g, r, formatReport(r));
    });

  program
    .command('doctor')
    .description('Check versions, drift, TLS, backups, disk; exit 2 on failure')
    .action(async function (this: Command) {
      const g = globals(this);
      const { r, cfg } = await withDeps(async (deps) => ({
        r: await doctorCommand(deps),
        cfg: deps.cfg,
      }));
      const lines = r.checks
        .map(
          (c) =>
            `${c.ok ? pc.green('ok  ') : c.level === 'warn' ? pc.yellow('warn') : pc.red('FAIL')} ${c.name.padEnd(28)} ${c.detail}`,
        )
        .join('\n');
      emit(io, g, r, `${lines}\n\n${externalChecks(cfg)}`);
      if (!r.ok) throw new DbmError('doctor found failures', ExitCode.RemoteFailure, 'doctor');
    });

  program
    .command('backup')
    .description('Run an on-demand off-site backup and list dumps')
    .argument('<slug>')
    .action(async function (this: Command, slug: string) {
      const g = globals(this);
      const r = await withDeps((deps) => backupCommand(deps, slug));
      emit(io, g, r, `${r.files.map((f) => `${f.ModTime}  ${f.Name}`).join('\n')}\n`);
    });

  program
    .command('restore')
    .description('Restore a dump (id or "latest"), optionally into a new project with --as')
    .argument('<slug>')
    .argument('<backup-id>')
    .option('--as <newslug>', 'restore into a freshly created project')
    .option('--confirm <slug>', 'required with --yes for in-place restores')
    .action(async function (
      this: Command,
      slug: string,
      backupId: string,
      opts: { as?: string; confirm?: string },
    ) {
      const g = globals(this);
      const r = await withDeps((deps) =>
        restoreCommand(deps, {
          slug,
          backupId,
          yes: g.yes,
          ...(opts.as ? { as: opts.as } : {}),
          ...(opts.confirm ? { confirmSlug: opts.confirm } : {}),
        }),
      );
      emit(io, g, r, `restored ${r.file} into ${r.target}\n`);
    });

  program
    .command('psql')
    .description('Interactive psql in the project container')
    .argument('<slug>')
    .option('--admin', 'connect as the superuser', false)
    .action(async function (this: Command, slug: string, opts: { admin: boolean }) {
      const code = await withDeps((deps) => psqlCommand(deps, slug, opts.admin));
      if (code !== 0)
        throw new DbmError(`psql exited with ${code}`, ExitCode.RemoteFailure, 'psql');
    });
  const storage = program.command('storage').description('Bucket visibility and CORS');
  storage
    .command('public')
    .argument('<slug>')
    .option('--domain <host>', 'also serve on a vanity hostname')
    .option('--off', 'make private again', false)
    .action(async function (this: Command, slug: string, opts: { domain?: string; off: boolean }) {
      const g = globals(this);
      const r = await withDeps((deps) =>
        storagePublicCommand(deps, {
          slug,
          off: opts.off,
          ...(opts.domain ? { domain: opts.domain } : {}),
        }),
      );
      emit(io, g, r, r.publicBaseUrl ? `S3_PUBLIC_BASE_URL=${r.publicBaseUrl}\n` : 'private\n');
    });
  storage
    .command('cors')
    .argument('<slug>')
    .requiredOption('--origin <origin...>', 'allowed origins')
    .action(async function (this: Command, slug: string, opts: { origin: string[] }) {
      const g = globals(this);
      const origins = await withDeps((deps) =>
        storageCorsCommand(deps, { slug, origins: opts.origin }),
      );
      emit(io, g, { origins }, `${origins.join('\n')}\n`);
    });
  program
    .command('init')
    .description(
      'Bootstrap a fresh Ubuntu 24.04 VPS (hardening, Tailscale, Dokploy, Garage, PgBouncer, backups, smoke test)',
    )
    .argument('<ssh-host>')
    .requiredOption('--domain <domain>', 'base domain; needs db., s3., *.web. A records')
    .option('--user <user>', 'ssh user', 'root')
    .option('--tls <mode>', 'letsencrypt|self-ca', 'letsencrypt')
    .option('--hostname <name>', 'tailscale machine name', 'dbm-vps')
    .option('--timezone <tz>', 'server timezone', 'America/Argentina/Buenos_Aires')
    .option('--tailscale-auth-key <key>')
    .option('--dokploy-api-key <key>')
    .option('--b2-endpoint <url>')
    .option('--b2-region <region>')
    .option('--b2-key-id <id>')
    .option('--b2-key-secret <secret>')
    .option('--b2-dumps-bucket <name>')
    .option('--b2-storage-bucket <name>')
    .action(async (host: string, opts: Record<string, string | undefined>) => {
      if (opts.tls !== 'letsencrypt' && opts.tls !== 'self-ca')
        throw userError('--tls must be letsencrypt or self-ca', 'init');
      const tls = opts.tls;
      const b2 =
        opts.b2Endpoint &&
        opts.b2Region &&
        opts.b2KeyId &&
        opts.b2KeySecret &&
        opts.b2DumpsBucket &&
        opts.b2StorageBucket
          ? {
              endpoint: opts.b2Endpoint,
              region: opts.b2Region,
              keyId: opts.b2KeyId,
              keySecret: opts.b2KeySecret,
              dumpsBucket: opts.b2DumpsBucket,
              storageBucket: opts.b2StorageBucket,
            }
          : undefined;
      const store = makeFileStore();
      await withLock(store, () =>
        initCommand(store, io, {
          host,
          domain: opts.domain ?? '',
          tls,
          user: opts.user ?? 'root',
          hostname: opts.hostname ?? 'dbm-vps',
          timezone: opts.timezone ?? 'America/Argentina/Buenos_Aires',
          ...(opts.tailscaleAuthKey ? { tailscaleAuthKey: opts.tailscaleAuthKey } : {}),
          ...(opts.dokployApiKey ? { dokployApiKey: opts.dokployApiKey } : {}),
          ...(b2 ? { b2 } : {}),
        }),
      );
    });
  program
    .command('sync-pgbouncer', { hidden: true })
    .description('Re-render PgBouncer config from state and reload')
    .action(async () => {
      await withDeps(syncPgbouncerCommand);
    });

  return program;
}

export async function run(
  argv: string[],
  io: Io = stdIo,
  depsFactory?: DepsFactory,
): Promise<number> {
  const program = buildProgram(io, depsFactory);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return ExitCode.Ok;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? ExitCode.Ok : ExitCode.UserError;
    if (e instanceof DbmError) {
      io.err(`${pc.red('error')}${e.step ? ` [${e.step}]` : ''}: ${e.message}\n`);
      return e.exitCode;
    }
    io.err(`unexpected: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return ExitCode.RemoteFailure;
  }
}
