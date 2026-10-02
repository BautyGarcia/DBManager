import { userError } from '../core/exit.js';
import { deriveNames, webHost } from '../core/naming.js';
import { getProject, type Project, upsertProject } from '../core/state.js';
import { renderHttpRouter } from '../core/traefik.js';
import type { Deps } from './context.js';

const HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

function requireStorage(p: Project): NonNullable<Project['storage']> {
  if (!p.storage) throw userError(`${p.slug} was created with --no-storage`, 'storage');
  return p.storage;
}

export async function storagePublicCommand(
  deps: Deps,
  o: { slug: string; domain?: string; off: boolean },
): Promise<{ publicBaseUrl?: string; hosts: string[] }> {
  if (o.domain !== undefined && !HOSTNAME.test(o.domain)) {
    throw userError(
      `invalid --domain ${JSON.stringify(o.domain)}: use a lowercase hostname`,
      'storage.public',
    );
  }
  const state = await deps.store.loadState();
  const p = getProject(state, o.slug);
  const storage = requireStorage(p);
  const names = deriveNames(p.slug);
  const routerFile = `${deps.cfg.remote.traefikDynamicDir}/${names.traefikWebFile}`;
  const primaryHost = webHost(p.slug, deps.cfg.webDomain);

  if (o.off) {
    for (const alias of storage.aliases)
      await deps.garage.removeBucketAlias(storage.bucketId, alias);
    await deps.garage.updateBucket(storage.bucketId, { websiteAccess: { enabled: false } });
    await deps.ssh.run(['rm', '-f', routerFile]);
    const { publicBaseUrl: _drop, ...rest } = storage;
    await deps.store.saveState(upsertProject(state, { ...p, storage: { ...rest, aliases: [] } }));
    deps.io.err(`${p.slug} bucket is private again\n`);
    return { hosts: [] };
  }

  await deps.garage.updateBucket(storage.bucketId, {
    websiteAccess: { enabled: true, indexDocument: 'index.html', errorDocument: '404.html' },
  });
  const aliases = [...storage.aliases];
  if (o.domain && !aliases.includes(o.domain)) {
    await deps.garage.addBucketAlias(storage.bucketId, o.domain);
    aliases.push(o.domain);
  }
  const hosts = [primaryHost, ...aliases];
  await deps.ssh.upload(
    routerFile,
    renderHttpRouter({
      name: `dbm-web-${p.slug}`,
      hosts,
      serviceUrl: `http://${deps.cfg.remote.garageContainer}:3902`,
    }),
    { mode: '0644' },
  );
  const publicBaseUrl = `https://${primaryHost}`;
  await deps.store.saveState(
    upsertProject(state, { ...p, storage: { ...storage, publicBaseUrl, aliases } }),
  );
  deps.io.err(
    `public at ${publicBaseUrl}${aliases.length ? ` (also ${aliases.join(', ')}; point their DNS at the VPS)` : ''}\n`,
  );
  return { publicBaseUrl, hosts };
}

export async function storageCorsCommand(
  deps: Deps,
  o: { slug: string; origins: string[] },
): Promise<string[]> {
  if (!o.origins.length) throw userError('at least one --origin is required', 'storage.cors');
  const state = await deps.store.loadState();
  const p = getProject(state, o.slug);
  const storage = requireStorage(p);
  await deps.garage.updateBucket(storage.bucketId, {
    corsRules: [
      {
        allowedOrigins: o.origins,
        allowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
        allowedHeaders: ['*'],
        exposeHeaders: ['ETag'],
        maxAgeSeconds: 3600,
      },
    ],
  });
  await deps.store.saveState(
    upsertProject(state, { ...p, storage: { ...storage, corsOrigins: o.origins } }),
  );
  return o.origins;
}
