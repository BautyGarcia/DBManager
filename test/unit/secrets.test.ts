import { describe, expect, it } from 'vitest';
import { dokployPassword, randomSecret } from '../../src/core/secrets.js';

describe('secrets', () => {
  it('randomSecret is base64url of 32 bytes by default', () => {
    const s = randomSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomSecret(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
  it('dokployPassword uses only [A-Za-z0-9] and the requested length', () => {
    for (let i = 0; i < 50; i++) expect(dokployPassword()).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(dokployPassword(12)).toHaveLength(12);
  });
  it('is not constant', () => {
    expect(randomSecret()).not.toBe(randomSecret());
  });
});
