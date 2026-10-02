import { describe, expect, it } from 'vitest';
import { type DepsFactory, type Io, run } from '../../src/cli.js';
import { makeTestDeps, seedProject } from '../helpers/fakes.js';
import { fakeProject } from '../helpers/project.js';

/** run() against fakes: the deps factory hands the CLI's io to the fake deps, like makeDeps does. */
function harness() {
  const t = makeTestDeps();
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (s) => {
      out.push(s);
    },
    err: (s) => {
      err.push(s);
    },
  };
  const lockEvents: string[] = [];
  t.store.acquireLock = async () => {
    lockEvents.push('acquire');
  };
  t.store.releaseLock = async () => {
    lockEvents.push('release');
  };
  const factory: DepsFactory = async (cliIo) => ({ ...t.deps, io: cliIo });
  return { t, io, out, err, factory, lockEvents };
}

describe('cli wiring', () => {
  it('list --json (flag after the subcommand) emits only JSON on stdout', async () => {
    const h = harness();
    seedProject(h.t, fakeProject('my-app'));
    expect(await run(['list', '--json'], h.io, h.factory)).toBe(0);
    const stdout = h.out.join('');
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual([expect.objectContaining({ slug: 'my-app', status: 'running' })]);
    expect(stdout.trim().startsWith('[')).toBe(true);
  });
  it('--json before the subcommand still works', async () => {
    const h = harness();
    expect(await run(['--json', 'list'], h.io, h.factory)).toBe(0);
    expect(JSON.parse(h.out.join(''))).toEqual([]);
  });
  it('create x --json works and reports status', async () => {
    const h = harness();
    expect(await run(['create', 'my-app', '--json'], h.io, h.factory)).toBe(0);
    const doc = JSON.parse(h.out.join(''));
    expect(doc).toMatchObject({ slug: 'my-app', status: 'running', existed: false });
    expect(doc.env.DATABASE_URL).toContain('my_app_app');
    // progress goes to stderr, never stdout
    expect(h.err.join('')).toMatch(/created my-app/);
  });
  it('destroy x --yes --confirm x (flags after the subcommand)', async () => {
    const h = harness();
    seedProject(h.t, fakeProject('my-app'));
    expect(await run(['destroy', 'my-app', '--yes', '--confirm', 'my-app'], h.io, h.factory)).toBe(
      0,
    );
    expect(h.t.store.state.projects['my-app']).toBeUndefined();
  });
  it('holds the state lock around a command and releases it on failure', async () => {
    const h = harness();
    expect(await run(['env', 'missing'], h.io, h.factory)).toBe(1);
    expect(h.lockEvents).toEqual(['acquire', 'release']);
    expect(await run(['list'], h.io, h.factory)).toBe(0);
    expect(h.lockEvents).toEqual(['acquire', 'release', 'acquire', 'release']);
  });
  it('a held lock is a user error and the command does not run', async () => {
    const h = harness();
    const { userError } = await import('../../src/core/exit.js');
    h.t.store.acquireLock = async () => {
      throw userError('another dbm command is running (pid 42)', 'lock');
    };
    expect(await run(['create', 'my-app'], h.io, h.factory)).toBe(1);
    expect(h.err.join('')).toMatch(/another dbm command is running \(pid 42\)/);
    expect(h.t.dokploy.calls).toEqual([]);
  });
});
