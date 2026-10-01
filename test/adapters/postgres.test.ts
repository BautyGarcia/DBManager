import { describe, expect, it } from 'vitest';
import { makePostgresAdmin } from '../../src/adapters/postgres.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';

const target = { appName: 'pg-my-app-abc123', role: 'my_app_admin', database: 'my_app' };

describe('PostgresAdmin', () => {
  it('resolves the swarm task container by service label, then runs psql with SQL on stdin', async () => {
    const f = makeFakeRunner([
      {
        match: /docker ps -q --filter label=com\.docker\.swarm\.service\.name=pg-my-app-abc123/,
        stdout: 'c0ffee',
      },
      { match: /docker exec -i c0ffee psql/, stdout: '1' },
    ]);
    const pg = makePostgresAdmin(f.runner, {
      network: 'dokploy-network',
      clientImage: 'postgres:18',
    });
    expect(await pg.runSql(target, 'select 1;')).toBe('1');
    const exec = f.calls[1];
    expect(exec?.argv).toEqual([
      'docker',
      'exec',
      '-i',
      'c0ffee',
      'psql',
      '-U',
      'my_app_admin',
      '-d',
      'my_app',
      '-v',
      'ON_ERROR_STOP=1',
      '-qAt',
      '-f',
      '-',
    ]);
    expect(exec?.input).toBe('select 1;');
  });
  it('falls back to a container name filter (compose/test containers)', async () => {
    const f = makeFakeRunner([
      { match: /--filter label=/, stdout: '' },
      { match: /docker ps -q --filter name=\^dbm-test-pg\$/, stdout: 'abc' },
      { match: /docker exec -i abc psql/, stdout: '1' },
    ]);
    const pg = makePostgresAdmin(f.runner, { network: 'n', clientImage: 'postgres:18' });
    expect(await pg.ping({ ...target, appName: 'dbm-test-pg' })).toBe(true);
  });
  it('ping returns false on failure; pingViaPgbouncer uses a throwaway client container', async () => {
    const f = makeFakeRunner([
      { match: /--filter label=/, stdout: 'c1' },
      { match: /docker exec/, fail: true, stderr: 'FATAL' },
      {
        match:
          /docker run --rm --network dokploy-network postgres:18 psql postgresql:\/\/u:p@dbm-pgbouncer:6432\/my-app -Atc select 1/,
        stdout: '1',
      },
    ]);
    const pg = makePostgresAdmin(f.runner, {
      network: 'dokploy-network',
      clientImage: 'postgres:18',
    });
    expect(await pg.ping(target)).toBe(false);
    expect(await pg.pingViaPgbouncer('postgresql://u:p@dbm-pgbouncer:6432/my-app')).toBe(true);
  });
  it('throws a remote error naming the container when none is found', async () => {
    const f = makeFakeRunner([{ match: /docker ps/, stdout: '' }]);
    const pg = makePostgresAdmin(f.runner, { network: 'n', clientImage: 'postgres:18' });
    await expect(pg.runSql(target, 'x')).rejects.toThrow(
      /no running container for pg-my-app-abc123/,
    );
  });
});
