import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import { DbmError, ExitCode } from './core/exit.js';
import { VERSION } from './version.js';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

export const stdIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export function buildProgram(io: Io): Command {
  const program = new Command('dbm')
    .version(VERSION)
    .description('Personal database platform on one VPS')
    .option('--json', 'machine-readable output', false)
    .option('--yes', 'skip confirmations', false)
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: io.out, writeErr: io.err });
  return program;
}

export async function run(argv: string[], io: Io = stdIo): Promise<number> {
  const program = buildProgram(io);
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
