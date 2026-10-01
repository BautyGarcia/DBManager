import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

export interface ScramOptions {
  salt?: Buffer;
  iterations?: number;
}

/**
 * PostgreSQL SCRAM-SHA-256 secret, the exact format of pg_authid.rolpassword and PgBouncer userlist.txt:
 * SCRAM-SHA-256$<iterations>:<salt b64>$<StoredKey b64>:<ServerKey b64>
 * Passwords must be SASLprep-neutral; dbm passwords are ASCII so SASLprep is a no-op.
 */
export function scramSha256Verifier(password: string, opts: ScramOptions = {}): string {
  const salt = opts.salt ?? randomBytes(16);
  const iterations = opts.iterations ?? 4096;
  const saltedPassword = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export function isScramVerifier(s: string): boolean {
  return /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(s);
}
