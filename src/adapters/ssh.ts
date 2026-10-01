import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { join as shJoin, quote as shQuote } from 'shlex';
import { DbmError, ExitCode, remoteError } from '../core/exit.js';
import type { RunOptions, RunResult, SshRunner } from './types.js';

export interface ExecResult {
  exitCode?: number | undefined;
  stdout: string;
  stderr: string;
  timedOut?: boolean | undefined;
  shortMessage?: string | undefined;
}
export type ExecFn = (
  file: string,
  args: string[],
  opts: { input?: string; timeout: number; stdin: 'pipe' | 'ignore' },
) => Promise<ExecResult>;

const defaultExec: ExecFn = async (file, args, opts) => {
  const r = await execa(file, args, {
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    stdin: opts.stdin,
    timeout: opts.timeout,
    reject: false,
    stripFinalNewline: true,
  });
  return {
    exitCode: r.exitCode,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    timedOut: r.timedOut,
    shortMessage: r.shortMessage,
  };
};

export const SSH_OPTS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3',
  '-o',
  'LogLevel=ERROR',
];

const DEFAULT_TIMEOUT_MS = 60_000;

function timeoutMultiplier(): number {
  const m = Number(process.env.DBM_TIMEOUT_MULTIPLIER ?? '1');
  return Number.isFinite(m) && m > 0 ? m : 1;
}

function checkResult(r: ExecResult, what: string, timeoutMs: number): RunResult {
  if (r.timedOut) throw remoteError(`command timed out after ${timeoutMs}ms: ${what}`, 'ssh');
  if (r.exitCode !== 0) {
    throw new DbmError(
      `${what}\n${r.stderr || r.shortMessage || `exit ${r.exitCode}`}`,
      ExitCode.RemoteFailure,
      'ssh',
    );
  }
  return { stdout: r.stdout, stderr: r.stderr };
}

/** POSIX script: create parent, write to a temp file in the same dir, chmod, rename over the target. */
export function atomicUploadScript(remotePath: string, mode: string): string {
  const dir = shQuote(dirname(remotePath));
  const target = shQuote(remotePath);
  return `set -e; d=${dir}; mkdir -p "$d"; umask 077; t=$(mktemp "$d/.tmp.XXXXXX"); cat > "$t"; chmod ${mode} "$t"; mv -f "$t" ${target}`;
}

export function makeSshRunner(o: { host: string; user?: string; exec?: ExecFn }): SshRunner {
  const exec = o.exec ?? defaultExec;
  const target = `${o.user ?? 'root'}@${o.host}`;
  async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
    const remote = shJoin(argv);
    const timeout = (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) * timeoutMultiplier();
    const r = await exec('ssh', [...SSH_OPTS, target, remote], {
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      timeout,
      stdin: opts.input === undefined ? 'ignore' : 'pipe',
    });
    return checkResult(r, `ssh ${target} ${remote}`, timeout);
  }
  return {
    run,
    async upload(remotePath, content, opts = {}) {
      await run(['sh', '-c', atomicUploadScript(remotePath, opts.mode ?? '0600')], {
        input: content,
      });
    },
    async interactive(argv) {
      const r = await execa('ssh', ['-t', ...SSH_OPTS, target, shJoin(argv)], {
        stdio: 'inherit',
        reject: false,
      });
      return r.exitCode ?? 1;
    },
  };
}

/** Runs the same argv on this machine (integration tests, or dbm running on the VPS itself). */
export function makeLocalRunner(
  o: { exec?: ExecFn; mapPath?: (remotePath: string) => string } = {},
): SshRunner {
  const exec = o.exec ?? defaultExec;
  const mapPath = o.mapPath ?? ((p: string) => p);
  return {
    async run(argv, opts = {}) {
      const [file, ...args] = argv;
      if (!file) throw remoteError('empty argv', 'local');
      const timeout = (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) * timeoutMultiplier();
      const r = await exec(file, args, {
        ...(opts.input !== undefined ? { input: opts.input } : {}),
        timeout,
        stdin: opts.input === undefined ? 'ignore' : 'pipe',
      });
      return checkResult(r, shJoin(argv), timeout);
    },
    async upload(remotePath, content, opts = {}) {
      const file = mapPath(remotePath);
      await mkdir(dirname(file), { recursive: true });
      const tmp = join(dirname(file), `.tmp.${process.pid}.${Date.now()}`);
      await writeFile(tmp, content, 'utf8');
      await chmod(tmp, Number.parseInt(opts.mode ?? '0600', 8));
      await rename(tmp, file);
    },
    async interactive(argv) {
      const [file, ...args] = argv;
      if (!file) return 1;
      const r = await execa(file, args, { stdio: 'inherit', reject: false });
      return r.exitCode ?? 1;
    },
  };
}
