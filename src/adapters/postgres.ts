import { remoteError } from '../core/exit.js';
import type { PgTarget, PostgresAdmin, RunOptions, SshRunner } from './types.js';

export interface PostgresAdminOptions {
  network: string;
  clientImage: string;
}

export function makePostgresAdmin(runner: SshRunner, o: PostgresAdminOptions): PostgresAdmin {
  async function findContainer(appName: string): Promise<string> {
    const byLabel = await runner.run([
      'docker',
      'ps',
      '-q',
      '--filter',
      `label=com.docker.swarm.service.name=${appName}`,
    ]);
    const id1 = byLabel.stdout.split('\n')[0]?.trim();
    if (id1) return id1;
    const byName = await runner.run(['docker', 'ps', '-q', '--filter', `name=^${appName}$`]);
    const id2 = byName.stdout.split('\n')[0]?.trim();
    if (id2) return id2;
    throw remoteError(`no running container for ${appName}`, 'postgres.container');
  }

  async function runSql(t: PgTarget, sql: string, opts: RunOptions = {}): Promise<string> {
    const container = await findContainer(t.appName);
    const r = await runner.run(
      [
        'docker',
        'exec',
        '-i',
        container,
        'psql',
        '-U',
        t.role,
        '-d',
        t.database,
        '-v',
        'ON_ERROR_STOP=1',
        '-qAt',
        '-f',
        '-',
      ],
      { input: sql, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) },
    );
    return r.stdout;
  }

  return {
    findContainer,
    runSql,
    async ping(t) {
      try {
        return (await runSql(t, 'select 1;')).trim() === '1';
      } catch {
        return false;
      }
    },
    async pingViaPgbouncer(url) {
      try {
        const r = await runner.run(
          [
            'docker',
            'run',
            '--rm',
            '--network',
            o.network,
            o.clientImage,
            'psql',
            url,
            '-Atc',
            'select 1',
          ],
          { timeoutMs: 90_000 },
        );
        return r.stdout.trim() === '1';
      } catch {
        return false;
      }
    },
  };
}
