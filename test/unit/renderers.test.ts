import { describe, expect, it } from 'vitest';
import { IMAGES, renderGarageCompose, renderPgbouncerCompose } from '../../src/core/compose.js';
import { renderGarageToml } from '../../src/core/garage-config.js';
import {
  renderPgbouncerReloadCron,
  renderRcloneConf,
  renderStorageSyncCron,
} from '../../src/core/host-files.js';
import { renderDbCertRouter, renderHttpRouter } from '../../src/core/traefik.js';

describe('garage.toml', () => {
  it('single node, fsync, snapshots, web root domain, no secrets inline', () => {
    const toml = renderGarageToml({ webDomain: 'web.example.com' });
    expect(toml).toContain('replication_factor = 1');
    expect(toml).toContain('metadata_fsync = true');
    expect(toml).toContain('metadata_auto_snapshot_interval = "6h"');
    expect(toml).toContain('s3_region = "garage"');
    expect(toml).toContain('root_domain = ".web.example.com"');
    expect(toml).toContain('api_bind_addr = "[::]:3903"');
    expect(toml).not.toMatch(/^rpc_secret = /m);
    expect(toml).not.toMatch(/^admin_token = /m);
  });
});

describe('compose files', () => {
  it('garage compose pins the image, binds admin port to loopback, joins the network', () => {
    const y = renderGarageCompose({
      network: 'dokploy-network',
      garageConfDir: '/etc/dokploy/dbm/garage',
      adminPort: 3903,
    });
    expect(y).toContain(`image: ${IMAGES.garage}`);
    expect(IMAGES.garage).toBe('dxflrs/garage:v2.4.1');
    expect(y).toContain('container_name: dbm-garage');
    expect(y).toContain('"127.0.0.1:3903:3903"');
    expect(y).toContain('/etc/dokploy/dbm/garage/garage.toml:/etc/garage.toml:ro');
    expect(y).toContain(`GARAGE_RPC_SECRET: \${GARAGE_RPC_SECRET}`);
    expect(y).toContain('external: true');
    expect(y).toMatch(/command:\s*\["server", "--single-node"\]/);
  });
  it('pgbouncer compose has pgbouncer + dumper for letsencrypt, pgbouncer only for self-ca', () => {
    const le = renderPgbouncerCompose({
      network: 'dokploy-network',
      pgbouncerConfDir: '/etc/dokploy/dbm/pgbouncer',
      certsDir: '/etc/dokploy/dbm/certs',
      traefikDynamicDir: '/etc/dokploy/traefik/dynamic',
      tls: 'letsencrypt',
    });
    expect(le).toContain(`image: ${IMAGES.pgbouncer}`);
    expect(IMAGES.pgbouncer).toBe('edoburu/pgbouncer:v1.26.0-p0');
    expect(le).toContain('container_name: dbm-pgbouncer');
    expect(le).toContain('"6432:6432"');
    expect(le).toContain('/etc/dokploy/dbm/pgbouncer:/etc/pgbouncer:ro');
    expect(le).toContain('/etc/dokploy/dbm/certs:/certs:ro');
    expect(le).toContain('container_name: dbm-certs-dumper');
    expect(le).toContain(`image: ${IMAGES.certsDumper}`);
    expect(le).toContain('/etc/dokploy/traefik/dynamic:/acme:ro');
    expect(le).toContain('--version');
    expect(le).toContain('--domain-subdir');
    const sc = renderPgbouncerCompose({
      network: 'dokploy-network',
      pgbouncerConfDir: '/etc/dokploy/dbm/pgbouncer',
      certsDir: '/etc/dokploy/dbm/certs',
      traefikDynamicDir: '/etc/dokploy/traefik/dynamic',
      tls: 'self-ca',
    });
    expect(sc).not.toContain('certs-dumper');
  });
});

describe('traefik routers', () => {
  it('http router yaml', () => {
    const y = renderHttpRouter({
      name: 'dbm-s3',
      hosts: ['s3.example.com'],
      serviceUrl: 'http://dbm-garage:3900',
    });
    expect(y).toContain('rule: Host(`s3.example.com`)');
    expect(
      renderHttpRouter({ name: 'x', hosts: ['a.b', 'c.d'], serviceUrl: 'http://x' }),
    ).toContain('rule: Host(`a.b`) || Host(`c.d`)');
    expect(y).toContain('certResolver: letsencrypt');
    expect(y).toContain('- url: http://dbm-garage:3900');
    expect(y).toContain('- websecure');
    expect(renderDbCertRouter('db.example.com')).toContain('rule: Host(`db.example.com`)');
  });
});

describe('host files', () => {
  it('rclone.conf has both remotes with path style', () => {
    const c = renderRcloneConf({
      garage: { keyId: 'GK', keySecret: 'S', endpoint: 'http://dbm-garage:3900' },
      b2: {
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        region: 'us-west-004',
        keyId: 'K',
        keySecret: 'S2',
      },
    });
    expect(c).toContain('[garage]');
    expect(c).toContain('[b2]');
    expect(c).toContain('provider = Other');
    expect(c).toContain('force_path_style = true');
    expect(c).toContain('no_check_bucket = true');
    expect(c).toContain('region = garage');
  });
  it('cron files', () => {
    const r = renderPgbouncerReloadCron({
      certsDir: '/etc/dokploy/dbm/certs',
      pgbouncerContainer: 'dbm-pgbouncer',
    });
    expect(r).toMatch(/^10 4 \* \* \* root /m);
    expect(r).toContain('chown -R 70:70 /etc/dokploy/dbm/certs');
    expect(r).toContain('docker kill -s HUP dbm-pgbouncer');
    const s = renderStorageSyncCron({
      network: 'dokploy-network',
      rcloneConfDir: '/etc/dokploy/dbm/rclone',
      storageBucket: 'dbm-storage',
    });
    expect(s).toMatch(/^30 6 \* \* \* root /m);
    expect(s).toContain(IMAGES.rclone);
    expect(s).toContain('sync garage: b2:dbm-storage/storage');
    expect(s).toContain('copy /snapshots b2:dbm-storage/garage-meta');
    expect(s).toContain('--network dokploy-network');
  });
});
