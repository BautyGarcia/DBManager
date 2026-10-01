import { userError } from './exit.js';

const UNITS: Record<string, number> = {
  '': 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
};
export const MIN_MEMORY_BYTES = 128 * 1024 ** 2;

/** '512m' | '1.5g' | '536870912' -> bytes. Minimum 128m. */
export function parseMemory(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(input.trim());
  if (!m)
    throw userError(`invalid memory size ${JSON.stringify(input)} (use e.g. 512m, 1g)`, 'memory');
  const unit = (m[2] ?? '').toLowerCase();
  const mult = UNITS[unit];
  if (mult === undefined) throw userError(`unknown memory unit ${JSON.stringify(m[2])}`, 'memory');
  const bytes = Math.round(Number(m[1]) * mult);
  if (bytes < MIN_MEMORY_BYTES)
    throw userError(`memory must be at least 128m, got ${input}`, 'memory');
  return bytes;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
