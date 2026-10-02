import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('templates/nextjs', () => {
  const files = walk('templates/nextjs');
  it('never uses sslmode=require or rejectUnauthorized:false', () => {
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/sslmode=require\b/);
      expect(s, f).not.toMatch(/rejectUnauthorized:\s*false/);
    }
  });
  it('S3 client opts out of SDK checksums and uses path style', () => {
    const s = readFileSync('templates/nextjs/lib/s3.ts', 'utf8');
    expect(s).toContain('requestChecksumCalculation: "WHEN_REQUIRED"');
    expect(s).toContain('responseChecksumValidation: "WHEN_REQUIRED"');
    expect(s).toContain('forcePathStyle: true');
  });
  it('auth.ts falls back to a localhost baseURL for local dev', () => {
    expect(readFileSync('templates/nextjs/lib/auth.ts', 'utf8')).toContain(
      '"http://localhost:3000"',
    );
  });
  it('drizzle.config.ts uses DATABASE_URL_SESSION only and verifies TLS', () => {
    const s = readFileSync('templates/nextjs/drizzle.config.ts', 'utf8');
    expect(s).toContain('process.env.DATABASE_URL_SESSION;');
    expect(s).not.toMatch(/process\.env\.DATABASE_URL\b(?!_)/);
    expect(s).toContain('throw new Error(');
    expect(s).toContain('"verify-full"');
    expect(s).toContain('process.env.DATABASE_SSL_CA.replace(/\\\\n/g, "\\n")');
    expect(s).toMatch(/dbCredentials: \{[\s\S]*ssl,\n/);
  });
  it('drizzle.config loads .env.local itself so drizzle-kit needs no shell env tricks', () => {
    const s = readFileSync('templates/nextjs/drizzle.config.ts', 'utf8');
    expect(s).toContain('process.loadEnvFile(".env.local")');
    expect(s).toContain('existsSync(".env.local")');
  });
  it('vercel.json pins gru1', () => {
    expect(JSON.parse(readFileSync('templates/nextjs/vercel.json', 'utf8'))).toEqual({
      $schema: 'https://openapi.vercel.sh/vercel.json',
      regions: ['gru1'],
    });
  });
});
