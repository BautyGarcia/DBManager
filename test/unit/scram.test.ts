import { describe, expect, it } from 'vitest';
import { isScramVerifier, scramSha256Verifier } from '../../src/core/scram.js';

describe('scramSha256Verifier', () => {
  it('matches the known-answer vector (computed with node:crypto, format verified against PG17 pg_authid)', () => {
    const salt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    expect(scramSha256Verifier('correct horse battery staple', { salt })).toBe(
      'SCRAM-SHA-256$4096:ASNFZ4mrze8BI0VniavN7w==$QBFKFII7AUqdBBhgLEMpXlELyov2F0DDsChPQZct0aM=:Fb2c1Vznjh3q0/vyrHtpquSYm3x5Si1AJeeYgN455Tc=',
    );
  });
  it('uses a random 16-byte salt and 4096 iterations by default', () => {
    const v = scramSha256Verifier('x');
    expect(v).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/,
    );
    expect(scramSha256Verifier('x')).not.toBe(v);
  });
  it('isScramVerifier', () => {
    expect(isScramVerifier(scramSha256Verifier('x'))).toBe(true);
    expect(isScramVerifier('md5abc')).toBe(false);
  });
});
