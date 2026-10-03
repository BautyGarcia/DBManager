import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli.js';
import { upsertProject } from '../../src/core/state.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../helpers/project.js';

const OUT = '---SCHEMA-ERRORS---\n---DATA-ERRORS---\n---COUNTS---\n---END---';

function setup() {
  const runner = makeFakeRunner([
    { match: /bash -s/, stdout: OUT },
    { match: /rclone/, stdout: '' },
  ]);
  const t = makeTestDeps({ runner });
  t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
  const out: string[] = [];
  const program = buildProgram({ out: (s) => void out.push(s), err: () => {} }, async () => t.deps);
  return { t, out, program };
}

const base = ['import', 'my-app', '--from', 'postgresql://u:p@h:5432/d', '--json'];
const s3 = [
  '--storage-endpoint',
  'https://x',
  '--storage-region',
  'r',
  '--storage-key',
  'K',
  '--storage-secret',
  'S',
];

describe('dbm import CLI storage flags', () => {
  it('collects repeated --storage-bucket into one copy per bucket under its prefix', async () => {
    const { t, out, program } = setup();
    await program.parseAsync([...base, ...s3, '--storage-bucket', 'a', '--storage-bucket', 'b'], {
      from: 'user',
    });
    const dsts = t.runner.calls
      .filter((c) => c.argv.join(' ').includes('rclone'))
      .map((c) => c.argv[c.argv.indexOf('copy') + 2]);
    expect(dsts).toEqual(['dst:my-app/a', 'dst:my-app/b']);
    const json = JSON.parse(out.join('')) as { storageBuckets: string[] };
    expect(json.storageBuckets).toEqual(['a', 'b']);
  });
  it('rejects a partial set of storage flags before any remote call', async () => {
    const { t, program } = setup();
    await expect(
      program.parseAsync([...base, '--storage-endpoint', 'https://x'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 1, step: 'import.storage' });
    await expect(program.parseAsync([...base, ...s3], { from: 'user' })).rejects.toMatchObject({
      exitCode: 1,
      step: 'import.storage',
    });
    expect(t.runner.calls).toHaveLength(0);
  });
});
