import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/core/config.js';
import {
  emptyState,
  getProject,
  listProjects,
  parseState,
  removeProject,
  upsertProject,
} from '../../src/core/state.js';
import { fakeProject } from '../helpers/project.js';

describe('state', () => {
  it('parses version 1 and rejects unknown versions', () => {
    expect(parseState(emptyState())).toEqual({ version: 1, projects: {} });
    expect(() => parseState({ version: 99, projects: {} })).toThrow();
    expect(() => parseState({ version: 1, projects: { x: { slug: 'x' } } })).toThrow();
  });
  it('upsert/remove/list are immutable and sorted', () => {
    const s0 = emptyState();
    const s1 = upsertProject(s0, fakeProject('zeta'));
    const s2 = upsertProject(s1, fakeProject('alpha'));
    expect(s0.projects).toEqual({});
    expect(listProjects(s2).map((p) => p.slug)).toEqual(['alpha', 'zeta']);
    const s3 = removeProject(s2, 'zeta');
    expect(Object.keys(s3.projects)).toEqual(['alpha']);
    expect(Object.keys(s2.projects)).toHaveLength(2);
  });
  it('getProject throws a user error for unknown slugs', () => {
    expect(() => getProject(emptyState(), 'nope')).toThrow(/not found/);
  });
});

describe('config', () => {
  it('applies remote defaults', () => {
    const cfg = ConfigSchema.parse({
      sshHost: '1.2.3.4',
      dokployUrl: 'https://vps.tail.ts.net',
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
    expect(cfg.sshUser).toBe('root');
    expect(cfg.tls).toBe('letsencrypt');
    expect(cfg.remote).toEqual({
      pgbouncerConfDir: '/etc/dokploy/dbm/pgbouncer',
      certsDir: '/etc/dokploy/dbm/certs',
      garageConfDir: '/etc/dokploy/dbm/garage',
      rcloneConfDir: '/etc/dokploy/dbm/rclone',
      traefikDynamicDir: '/etc/dokploy/traefik/dynamic',
      dockerNetwork: 'dokploy-network',
      pgbouncerContainer: 'dbm-pgbouncer',
      garageContainer: 'dbm-garage',
      garageAdminPort: 3903,
      dbPort: 6432,
    });
  });
});
