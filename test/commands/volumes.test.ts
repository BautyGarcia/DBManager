import { describe, expect, it } from 'vitest';
import type { SshRunner } from '../../src/adapters/types.js';
import { removeVolume } from '../../src/commands/volumes.js';
import { DbmError, ExitCode } from '../../src/core/exit.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';
import { makeTestDeps } from '../helpers/fakes.js';

/** Runner whose run() fails with each scripted stderr in turn, then succeeds. */
function scriptedRunner(failures: string[]) {
  const calls: string[][] = [];
  const runner: SshRunner = {
    async run(argv) {
      calls.push(argv);
      const msg = failures.shift();
      if (msg !== undefined)
        throw new DbmError(`${argv.join(' ')}\n${msg}`, ExitCode.RemoteFailure, 'ssh');
      return { stdout: '', stderr: '' };
    },
    async upload() {},
    async interactive() {
      return 0;
    },
  };
  return { runner, calls };
}

describe('removeVolume', () => {
  it('a missing volume counts as removed', async () => {
    const r = makeFakeRunner([
      {
        match: /docker volume rm/,
        fail: true,
        stderr: 'Error response from daemon: get pg-x-abc123-data: no such volume',
      },
    ]);
    const t = makeTestDeps({ ssh: r.runner });
    await expect(removeVolume(t.deps, 'pg-x-abc123')).resolves.toBeUndefined();
    expect(r.calls.map((c) => c.argv.join(' '))).toEqual(['docker volume rm pg-x-abc123-data']);
  });

  it('retries while the volume is in use, then succeeds', async () => {
    const inUse =
      'Error response from daemon: remove pg-x-abc123-data: volume is in use - [deadbeef]';
    const s = scriptedRunner([inUse, inUse]);
    const sleeps: number[] = [];
    const t = makeTestDeps({
      ssh: s.runner,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await removeVolume(t.deps, 'pg-x-abc123');
    expect(s.calls).toHaveLength(3);
    expect(s.calls.every((a) => a.join(' ') === 'docker volume rm pg-x-abc123-data')).toBe(true);
    expect(sleeps).toEqual([3000, 3000]);
  });

  it('gives up after 10 attempts when the volume stays in use', async () => {
    const s = scriptedRunner(Array.from({ length: 20 }, () => 'volume is in use - [deadbeef]'));
    const t = makeTestDeps({ ssh: s.runner });
    await expect(removeVolume(t.deps, 'pg-x-abc123')).rejects.toMatchObject({ message: /in use/ });
    expect(s.calls).toHaveLength(10);
  });

  it('other errors are thrown immediately', async () => {
    const s = scriptedRunner(['permission denied']);
    const t = makeTestDeps({ ssh: s.runner });
    await expect(removeVolume(t.deps, 'pg-x-abc123')).rejects.toMatchObject({
      message: /permission denied/,
    });
    expect(s.calls).toHaveLength(1);
  });
});
