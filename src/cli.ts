import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import { makeFileStore } from './adapters/store.js';
import { type Deps, makeDeps } from './commands/context.js';
import { createCommand } from './commands/create.js';
import { envCommand } from './commands/env.js';
import { formatTable, listCommand } from './commands/list.js';
import { pauseCommand, resumeCommand } from './commands/pause.js';
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
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: io.out, writeErr: io.err });

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
      const deps = await depsFactory(io);
      const r = await createCommand(deps, {
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
      });
      emit(
        io,
        g,
        { slug: r.project.slug, existed: r.existed, env: r.env },
        `${formatEnvBlock(r.env)}\n# Pin Vercel functions to gru1 (templates/nextjs/vercel.json).\n`,
      );
    });

  program
    .command('list')
    .description('List projects with memory, disk, storage and last backup')
    .action(async function (this: Command) {
      const g = globals(this);
      const deps = await depsFactory(io);
      const rows = await listCommand(deps);
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
      const deps = await depsFactory(io);
      const env = await envCommand(deps, slug);
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
        const p = await fn(await depsFactory(io), slug);
        emit(io, g, { slug: p.slug, status: p.status }, `${p.slug}: ${p.status}\n`);
      });
  }

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
