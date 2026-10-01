import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ExecFn, makeLocalRunner, makeSshRunner } from '../../src/adapters/ssh.js';
import { DbmError } from '../../src/core/exit.js';

function fakeExec(result: Partial<Awaited<ReturnType<ExecFn>>> = {}) {
  const calls: Array<{ file: string; args: string[]; input?: string }> = [];
  const exec: ExecFn = async (file, args, opts) => {
    calls.push({ file, args, ...(opts.input !== undefined ? { input: opts.input } : {}) });
    return { exitCode: 0, stdout: 'ok', stderr: '', ...result };
  };
  return { exec, calls };
}

describe('makeSshRunner', () => {
  it('builds ssh argv with batch options and a shlex-joined remote command', async () => {
    const f = fakeExec();
    const r = makeSshRunner({ host: '1.2.3.4', exec: f.exec });
    const out = await r.run(['docker', 'exec', '-i', 'pg-my app', 'psql', '-c', "select 'x'"], {
      input: 'sql',
    });
    expect(out.stdout).toBe('ok');
    const call = f.calls[0];
    expect(call?.file).toBe('ssh');
    expect(call?.args).toContain('BatchMode=yes');
    expect(call?.args).toContain('StrictHostKeyChecking=accept-new');
    expect(call?.args).toContain('root@1.2.3.4');
    expect(call?.args.at(-1)).toBe(`docker exec -i 'pg-my app' psql -c 'select '"'"'x'"'"`);
    expect(call?.input).toBe('sql');
  });
  it('maps non-zero exit to DbmError exit 2 with stderr', async () => {
    const f = fakeExec({ exitCode: 1, stderr: 'boom' });
    const r = makeSshRunner({ host: 'h', user: 'ubuntu', exec: f.exec });
    await expect(r.run(['false'])).rejects.toMatchObject({
      exitCode: 2,
      step: 'ssh',
      message: /boom/,
    });
    expect(f.calls[0]?.args).toContain('ubuntu@h');
  });
  it('maps timeouts', async () => {
    const f = fakeExec({ exitCode: undefined, timedOut: true });
    const r = makeSshRunner({ host: 'h', exec: f.exec });
    await expect(r.run(['sleep', '99'], { timeoutMs: 5 })).rejects.toThrow(/timed out/);
  });
  it('upload sends content on stdin to an atomic mktemp+mv script', async () => {
    const f = fakeExec();
    const r = makeSshRunner({ host: 'h', exec: f.exec });
    await r.upload('/etc/dokploy/dbm/pgbouncer/userlist.txt', 'line\n', { mode: '0640' });
    const remote = f.calls[0]?.args.at(-1) ?? '';
    expect(remote).toContain('mkdir -p');
    expect(remote).toContain('mktemp');
    expect(remote).toContain('chmod 0640');
    expect(remote).toContain('mv -f');
    expect(remote).toContain('/etc/dokploy/dbm/pgbouncer/userlist.txt');
    expect(f.calls[0]?.input).toBe('line\n');
  });
});

describe('makeLocalRunner', () => {
  it('runs argv locally and writes uploads through mapPath', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dbm-local-'));
    const r = makeLocalRunner({
      mapPath: (p) => join(dir, p.replace(/^\/etc\/dokploy\/dbm\//, '')),
    });
    expect((await r.run(['echo', 'hi'])).stdout).toBe('hi');
    await r.upload('/etc/dokploy/dbm/pgbouncer/pgbouncer.ini', 'x=1\n', { mode: '0644' });
    const file = join(dir, 'pgbouncer/pgbouncer.ini');
    expect(await readFile(file, 'utf8')).toBe('x=1\n');
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    await expect(r.run(['sh', '-c', 'echo bad >&2; exit 3'])).rejects.toBeInstanceOf(DbmError);
  });
});
