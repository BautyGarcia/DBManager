import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../src/adapters/dokploy.js';

describe('redactSecrets', () => {
  it('strips rclone S3 credentials from echoed backup scripts', () => {
    const msg =
      'Command failed: rclone rcat --s3-access-key-id=00513faa835be --s3-secret-access-key=K005abc+def/ghi --s3-region=us-east-005 ":s3:dbm-dumps/x"';
    const out = redactSecrets(msg);
    expect(out).not.toContain('00513faa835be');
    expect(out).not.toContain('K005abc+def/ghi');
    expect(out).toContain(
      '--s3-access-key-id=[redacted] --s3-secret-access-key=[redacted] --s3-region=us-east-005',
    );
  });
});
