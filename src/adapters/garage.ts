import { z } from 'zod';
import { DbmError, remoteError } from '../core/exit.js';
import type {
  GarageAdmin,
  GarageBucketInfo,
  GarageCorsRule,
  GaragePermissions,
  SshRunner,
} from './types.js';

export interface GarageAdminOptions {
  port: number;
  token: string;
}

/** Operations the CLI's scoped admin token needs (Garage admin API v2). */
export const GARAGE_CLI_SCOPE = [
  'GetClusterHealth',
  'GetClusterStatus',
  'ListBuckets',
  'GetBucketInfo',
  'CreateBucket',
  'UpdateBucket',
  'DeleteBucket',
  'AddBucketAlias',
  'RemoveBucketAlias',
  'CleanupIncompleteUploads',
  'ListKeys',
  'GetKeyInfo',
  'CreateKey',
  'DeleteKey',
  'AllowBucketKey',
  'DenyBucketKey',
];

function esc(s: string): string {
  return s.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export interface CurlConfigInput {
  url: string;
  method: 'GET' | 'POST';
  token?: string;
  body?: unknown;
}

/** curl -K - config: token and body travel on stdin, never in argv. */
export function curlConfig(i: CurlConfigInput): string {
  const lines = [
    `url = "${esc(i.url)}"`,
    `request = "${i.method}"`,
    'silent',
    'show-error',
    'fail-with-body',
    'max-time = 15',
  ];
  if (i.token) lines.push(`header = "Authorization: Bearer ${esc(i.token)}"`);
  if (i.body !== undefined) {
    lines.push('header = "Content-Type: application/json"');
    lines.push(`data = "${esc(JSON.stringify(i.body))}"`);
  }
  return `${lines.join('\n')}\n`;
}

/** Garage's cors.Rule reuses the S3 XML field names (singular, PascalCase); camelCase is rejected. */
export function toGarageCorsRule(r: GarageCorsRule): Record<string, unknown> {
  return {
    AllowedOrigin: r.allowedOrigins,
    AllowedMethod: r.allowedMethods,
    AllowedHeader: r.allowedHeaders,
    ExposeHeader: r.exposeHeaders,
    MaxAgeSeconds: r.maxAgeSeconds,
  };
}

const BucketInfo = z.looseObject({
  id: z.string(),
  globalAliases: z.array(z.string()).default([]),
  bytes: z.number().default(0),
  objects: z.number().default(0),
  unfinishedUploads: z.number().default(0),
  websiteAccess: z.boolean().default(false),
});

export function makeGarageAdmin(runner: SshRunner, o: GarageAdminOptions): GarageAdmin {
  const base = `http://127.0.0.1:${o.port}`;

  async function call(
    op: string,
    opts: { method?: 'GET' | 'POST'; query?: Record<string, string>; body?: unknown } = {},
  ): Promise<unknown> {
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
    const cfg = curlConfig({
      url: `${base}/v2/${op}${qs}`,
      method: opts.method ?? 'POST',
      token: o.token,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    });
    try {
      const r = await runner.run(['curl', '-K', '-'], { input: cfg, timeoutMs: 20_000 });
      return r.stdout ? JSON.parse(r.stdout) : {};
    } catch (e) {
      if (e instanceof DbmError) throw remoteError(`garage ${op}: ${e.message}`, `garage.${op}`);
      throw e;
    }
  }

  async function perms(
    op: 'AllowBucketKey' | 'DenyBucketKey',
    bucketId: string,
    accessKeyId: string,
    p: GaragePermissions,
  ) {
    const permissions: Record<string, boolean> = {};
    if (p.read) permissions.read = true;
    if (p.write) permissions.write = true;
    if (p.owner) permissions.owner = true;
    await call(op, { body: { bucketId, accessKeyId, permissions } });
  }

  return {
    async health() {
      try {
        await runner.run(['curl', '-K', '-'], {
          input: curlConfig({ url: `${base}/health`, method: 'GET' }),
          timeoutMs: 10_000,
        });
        return true;
      } catch {
        return false;
      }
    },
    async createBucket(globalAlias) {
      return BucketInfo.parse(
        await call('CreateBucket', { body: { globalAlias } }),
      ) as GarageBucketInfo;
    },
    async getBucket(q) {
      try {
        const query: Record<string, string> = q.id
          ? { id: q.id }
          : { globalAlias: q.globalAlias ?? '' };
        return BucketInfo.parse(
          await call('GetBucketInfo', { method: 'GET', query }),
        ) as GarageBucketInfo;
      } catch (e) {
        if (e instanceof DbmError && /404|NoSuchBucket|not found/i.test(e.message))
          return undefined;
        throw e;
      }
    },
    async listBuckets() {
      return z
        .array(z.looseObject({ id: z.string(), globalAliases: z.array(z.string()).default([]) }))
        .parse(await call('ListBuckets', { method: 'GET' }));
    },
    async createKey(name) {
      return z.looseObject({ accessKeyId: z.string(), secretAccessKey: z.string() }).parse(
        await call('CreateKey', {
          body: { name, neverExpires: true, allow: { createBucket: false } },
        }),
      );
    },
    allowBucketKey: (b, k, p) => perms('AllowBucketKey', b, k, p),
    denyBucketKey: (b, k, p) => perms('DenyBucketKey', b, k, p),
    async updateBucket(bucketId, patch) {
      const { corsRules, ...rest } = patch;
      const body = corsRules ? { ...rest, corsRules: corsRules.map(toGarageCorsRule) } : rest;
      await call('UpdateBucket', { query: { id: bucketId }, body });
    },
    async addBucketAlias(bucketId, globalAlias) {
      await call('AddBucketAlias', { body: { bucketId, globalAlias } });
    },
    async removeBucketAlias(bucketId, globalAlias) {
      await call('RemoveBucketAlias', { body: { bucketId, globalAlias } });
    },
    async deleteKey(accessKeyId) {
      await call('DeleteKey', { query: { id: accessKeyId } });
    },
    async deleteBucket(bucketId) {
      await call('DeleteBucket', { query: { id: bucketId } });
    },
    async cleanupIncompleteUploads(bucketId) {
      await call('CleanupIncompleteUploads', { body: { bucketId, olderThanSecs: 0 } });
    },
    async createAdminToken(name, scope) {
      return z
        .looseObject({ secretToken: z.string() })
        .parse(await call('CreateAdminToken', { body: { name, scope, neverExpires: true } }));
    },
  };
}
