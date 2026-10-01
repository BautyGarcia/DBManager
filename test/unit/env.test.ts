import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/core/config.js';
import { formatEnvBlock, projectEnv } from '../../src/core/env.js';
import { fakeProject } from '../helpers/project.js';

const cfg = ConfigSchema.parse({
  sshHost: 'h',
  dokployUrl: 'https://x.ts.net',
  dokployApiKey: 'k',
  dokployProjectId: 'p',
  dokployEnvironmentId: 'e',
  domain: 'example.com',
  dbHost: 'db.example.com',
  s3Host: 's3.example.com',
  webDomain: 'web.example.com',
  garageAdminToken: 't',
  garageBackupKeyId: 'GKb',
  dumpsDestinationId: 'd',
});

describe('projectEnv', () => {
  it('uses hyphenated slug in the URL path and underscores in the role', () => {
    const env = projectEnv(fakeProject('my-app'), cfg);
    expect(env.DATABASE_URL).toBe(
      'postgresql://my_app_app:apppw@db.example.com:6432/my-app?sslmode=verify-full',
    );
    expect(env.DATABASE_URL_SESSION).toBe(
      'postgresql://my_app_app:apppw@db.example.com:6432/my-app_session?sslmode=verify-full',
    );
    expect(env.S3_ENDPOINT).toBe('https://s3.example.com');
    expect(env.S3_REGION).toBe('garage');
    expect(env.S3_BUCKET).toBe('my-app');
    expect(env.S3_ACCESS_KEY_ID).toBe('GK1');
    expect(env.S3_SECRET_ACCESS_KEY).toBe('sec');
    expect(env.BETTER_AUTH_SECRET).toBe('bas');
    expect(env.BETTER_AUTH_URL).toBe('');
    expect(env.S3_PUBLIC_BASE_URL).toBeUndefined();
    expect(env.DATABASE_SSL_CA).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('adminpw');
  });
  it('omits storage vars for --no-storage projects and adds public/CA vars when present', () => {
    const noStorage = projectEnv(fakeProject('a1', { storage: undefined }), cfg);
    expect(noStorage.S3_BUCKET).toBeUndefined();
    const pub = fakeProject('a1');
    if (pub.storage) pub.storage.publicBaseUrl = 'https://a1.web.example.com';
    const env = projectEnv(pub, {
      ...cfg,
      tls: 'self-ca',
      sslCaPem: '-----BEGIN\nabc\n-----END\n',
    });
    expect(env.S3_PUBLIC_BASE_URL).toBe('https://a1.web.example.com');
    expect(env.DATABASE_SSL_CA).toBe('-----BEGIN\\nabc\\n-----END\\n');
  });
  it('formatEnvBlock is KEY=value per line, sorted as inserted', () => {
    expect(formatEnvBlock({ B: '2', A: '' })).toBe('B=2\nA=\n');
  });
});
