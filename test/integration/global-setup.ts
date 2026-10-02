import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import type { TestProject } from 'vitest/node';
import { renderGarageToml } from '../../src/core/garage-config.js';
import { renderPgbouncerIni, renderUserlist } from '../../src/core/pgbouncer.js';
import { CERT_DIR, COMPOSE_DIR } from './testcfg.js';

const compose = ['compose', '-f', join(COMPOSE_DIR, 'compose.yaml')];

export default async function setup(_project: TestProject) {
  await mkdir(join(COMPOSE_DIR, 'pgbouncer'), { recursive: true });
  await mkdir(join(COMPOSE_DIR, 'garage'), { recursive: true });
  await mkdir(CERT_DIR, { recursive: true });
  // Self-signed cert with SANs so a client can do full verification with ssl: { ca }.
  await execa('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '3650',
    '-keyout',
    join(CERT_DIR, 'privatekey.key'),
    '-out',
    join(CERT_DIR, 'certificate.crt'),
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  await execa('chmod', [
    '644',
    join(CERT_DIR, 'privatekey.key'),
    join(CERT_DIR, 'certificate.crt'),
  ]);
  await writeFile(
    join(COMPOSE_DIR, 'pgbouncer', 'pgbouncer.ini'),
    renderPgbouncerIni([], { certDir: '/certs/db.test.local' }),
  );
  await writeFile(join(COMPOSE_DIR, 'pgbouncer', 'userlist.txt'), renderUserlist([]));
  await writeFile(
    join(COMPOSE_DIR, 'garage', 'garage.toml'),
    renderGarageToml({ webDomain: 'web.test.local' }),
  );
  await execa('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '180'], {
    stdio: 'inherit',
  });
  return async () => {
    if (process.env.DBM_TEST_KEEP !== '1') {
      await execa('docker', [...compose, 'down', '-v', '--remove-orphans', '-t', '5'], {
        stdio: 'inherit',
      });
    }
  };
}
