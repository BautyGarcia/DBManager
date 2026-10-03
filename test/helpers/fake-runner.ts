import type { RunOptions, RunResult, SshRunner } from '../../src/adapters/types.js';
import { DbmError, ExitCode } from '../../src/core/exit.js';

export interface RecordedCall {
  argv: string[];
  input?: string;
}

/** Scripted SshRunner: responders are matched in order against argv joined by spaces. */
export function makeFakeRunner(
  responders: Array<{
    match: RegExp;
    stdout?: string;
    stderr?: string;
    fail?: boolean;
    once?: boolean;
  }> = [],
) {
  const calls: RecordedCall[] = [];
  const uploads: Array<{ path: string; content: string; mode: string }> = [];
  const runner: SshRunner = {
    async run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
      calls.push({ argv, ...(opts.input !== undefined ? { input: opts.input } : {}) });
      const line = argv.join(' ');
      const idx = responders.findIndex((x) => x.match.test(line));
      const r = idx >= 0 ? responders[idx] : undefined;
      if (r?.once) responders.splice(idx, 1);
      if (r?.fail) {
        throw new DbmError(`${line}\n${r.stderr ?? 'failed'}`, ExitCode.RemoteFailure, 'ssh');
      }
      return { stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
    },
    async upload(path, content, opts = {}) {
      uploads.push({ path, content, mode: opts.mode ?? '0600' });
    },
    async interactive() {
      return 0;
    },
  };
  return { runner, calls, uploads };
}
