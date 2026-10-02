import { userError } from './exit.js';

/** DNS label / Garage bucket name: lowercase, starts with a letter, single hyphens between parts. */
export const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const SLUG_MIN = 3;
export const SLUG_MAX = 31;
/** Reserved for dbm's own throwaway projects (init's `dbm-smoke`). */
export const INTERNAL_PREFIX = 'dbm-';
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

export function validateSlug(slug: string, o: { internal?: boolean } = {}): string {
  if (!SLUG_RE.test(slug) || slug.length < SLUG_MIN || slug.length > SLUG_MAX) {
    throw userError(
      `invalid slug ${JSON.stringify(slug)}: must match ${SLUG_RE} and be ${SLUG_MIN}-${SLUG_MAX} chars (lowercase letters, digits and single hyphens; starts with a letter; no leading/trailing hyphen)`,
      'slug',
    );
  }
  if (RESERVED_SLUGS.has(slug)) throw userError(`slug ${JSON.stringify(slug)} is reserved`, 'slug');
  if (!o.internal && slug.startsWith(INTERNAL_PREFIX))
    throw userError(
      `slug ${JSON.stringify(slug)}: the ${INTERNAL_PREFIX} prefix is reserved for dbm itself`,
      'slug',
    );
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
