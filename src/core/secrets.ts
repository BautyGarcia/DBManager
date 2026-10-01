import { randomBytes, randomInt } from 'node:crypto';

/** 32 bytes -> 43-char base64url. Alphabet [A-Za-z0-9_-]: safe in URLs, shells, SQL literals. */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const DOKPLOY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Dokploy's databasePassword regex forbids $ ! ' " \ / and space; alphanumerics are always accepted. */
export function dokployPassword(length = 32): string {
  let out = '';
  for (let i = 0; i < length; i++) out += DOKPLOY_ALPHABET[randomInt(DOKPLOY_ALPHABET.length)];
  return out;
}
