import { describe, expect, it } from 'vitest';
import { curlConfig, makeGarageAdmin } from '../../src/adapters/garage.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';

describe('curlConfig', () => {
  it('escapes quotes and backslashes and never puts the token in argv', () => {
    const cfg = curlConfig({
      url: 'http://127.0.0.1:3903/v2/CreateBucket',
      method: 'POST',
      token: 'tok"en',
      body: { globalAlias: 'a"b\\c' },
    });
    expect(cfg).toContain('url = "http://127.0.0.1:3903/v2/CreateBucket"');
    expect(cfg).toContain('request = "POST"');
    expect(cfg).toContain('header = "Authorization: Bearer tok\\"en"');
    // JSON is {"globalAlias":"a\"b\\c"}; curl-config escaping doubles every backslash and escapes every quote.
    expect(cfg).toContain('data = "{\\"globalAlias\\":\\"a\\\\\\"b\\\\\\\\c\\"}"');
    expect(cfg).toContain('fail-with-body');
  });
});

describe('GarageAdmin', () => {
  const info = JSON.stringify({
    id: 'b1',
    globalAliases: ['my-app'],
    bytes: 0,
    objects: 0,
    unfinishedUploads: 0,
    websiteAccess: false,
  });
  it('createBucket posts JSON via curl -K - and parses the response', async () => {
    const f = makeFakeRunner([{ match: /^curl -K -$/, stdout: info }]);
    const g = makeGarageAdmin(f.runner, { port: 3903, token: 'T' });
    const b = await g.createBucket('my-app');
    expect(b.id).toBe('b1');
    expect(f.calls[0]?.argv).toEqual(['curl', '-K', '-']);
    expect(f.calls[0]?.input).toContain('/v2/CreateBucket');
    expect(f.calls[0]?.input).toContain('header = "Authorization: Bearer T"');
  });
  it('getBucket returns undefined on 404-style failure and health uses the unauthenticated endpoint', async () => {
    const f = makeFakeRunner([
      { match: /curl/, fail: true, stderr: 'curl: (22) The requested URL returned error: 404' },
    ]);
    const g = makeGarageAdmin(f.runner, { port: 3903, token: 'T' });
    expect(await g.getBucket({ globalAlias: 'nope' })).toBeUndefined();
    expect(await g.health()).toBe(false);
  });
  it('allowBucketKey / updateBucket / deleteBucket build the right operations', async () => {
    const f = makeFakeRunner([{ match: /curl/, stdout: '{}' }]);
    const g = makeGarageAdmin(f.runner, { port: 3903, token: 'T' });
    await g.allowBucketKey('b1', 'GK', { read: true, write: true });
    await g.updateBucket('b1', { websiteAccess: { enabled: true, indexDocument: 'index.html' } });
    await g.deleteBucket('b1');
    await g.deleteKey('GK');
    const inputs = f.calls.map((c) => c.input ?? '');
    expect(inputs[0]).toContain('/v2/AllowBucketKey');
    expect(inputs[0]).toContain('\\"permissions\\":{\\"read\\":true,\\"write\\":true}');
    expect(inputs[1]).toContain('/v2/UpdateBucket?id=b1');
    expect(inputs[2]).toContain('/v2/DeleteBucket?id=b1');
    expect(inputs[3]).toContain('/v2/DeleteKey?id=GK');
  });
});
