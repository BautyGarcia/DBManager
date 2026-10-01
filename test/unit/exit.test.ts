import { describe, expect, it } from 'vitest';
import { run } from '../../src/cli.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (s: string) => {
        out.push(s);
      },
      err: (s: string) => {
        err.push(s);
      },
    },
    out,
    err,
  };
}

describe('cli run()', () => {
  it('--version exits 0 and prints the version', async () => {
    const c = capture();
    expect(await run(['--version'], c.io)).toBe(0);
    expect(c.out.join('')).toMatch(/^\d+\.\d+\.\d+/);
  });
  it('unknown command exits 1', async () => {
    const c = capture();
    expect(await run(['nope'], c.io)).toBe(1);
  });
});
