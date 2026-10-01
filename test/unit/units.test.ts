import { describe, expect, it } from 'vitest';
import { DbmError } from '../../src/core/exit.js';
import { formatBytes, parseMemory } from '../../src/core/units.js';

describe('parseMemory', () => {
  it.each([
    ['512m', 536870912],
    ['512M', 536870912],
    ['512mb', 536870912],
    ['1g', 1073741824],
    ['1.5g', 1610612736],
    ['536870912', 536870912],
    ['131072k', 134217728],
  ])('%s -> %d', (input, bytes) => {
    expect(parseMemory(input)).toBe(bytes);
  });
  it.each(['', 'abc', '-1m', '0', '10t'])('rejects %j', (bad) => {
    expect(() => parseMemory(bad)).toThrow(DbmError);
  });
  it('rejects below 128m', () => {
    expect(() => parseMemory('64m')).toThrow(/at least 128m/);
  });
});

describe('formatBytes', () => {
  it('formats', () => {
    expect(formatBytes(536870912)).toBe('512.0 MiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(12)).toBe('12 B');
  });
});
