import { userError } from './exit.js';

export const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'dbm',
  'pgbouncer',
  'garage',
  'postgres',
  'admin',
  'template0',
  'template1',
  'session',
]);

export interface DerivedNames {
  slug: string;
  slugDb: string;
  database: string;
  appRole: string;
  adminRole: string;
  serviceName: string;
  pgbouncerDb: string;
  pgbouncerSessionDb: string;
  bucket: string;
  keyName: string;
  backupPrefix: string;
  storagePrefix: string;
  traefikWebFile: string;
}

export function validateSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw userError(
      `invalid slug ${JSON.stringify(slug)}: must match ${SLUG_RE} (lowercase, start with a letter, 2-31 chars)`,
      'slug',
    );
  }
  if (RESERVED_SLUGS.has(slug)) throw userError(`slug ${JSON.stringify(slug)} is reserved`, 'slug');
  return slug;
}

export function deriveNames(slug: string): DerivedNames {
  const slugDb = slug.replaceAll('-', '_');
  return {
    slug,
    slugDb,
    database: slugDb,
    appRole: `${slugDb}_app`,
    adminRole: `${slugDb}_admin`,
    serviceName: `pg-${slug}`,
    pgbouncerDb: slug,
    pgbouncerSessionDb: `${slug}_session`,
    bucket: slug,
    keyName: `${slug}-key`,
    backupPrefix: `db/${slug}`,
    storagePrefix: `storage/${slug}`,
    traefikWebFile: `dbm-web-${slug}.yml`,
  };
}

export function webHost(slug: string, webDomain: string): string {
  return `${slug}.${webDomain}`;
}
