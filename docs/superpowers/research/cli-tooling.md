# Research: CLI tooling and project setup for `dbm`

Date: 2026-09-30. Versions below come from `npm view` run on that date (local Node v22.18.0, npm 10.9.3). Every recommended config file in this document was exercised in a throwaway project (`/tmp/dbm-smoke`) with the pinned versions: `tsc --noEmit` and `tsc -p tsconfig.build.json` under TypeScript 7.0.2, 11 Vitest 5.0.3 tests across a `unit` and an `integration` project (the latter bringing up `postgres:17` with `docker compose up -d --wait` in `globalSetup`), MSW 3.0.1 fixture replay, `biome ci` under Biome 2.5.15, and the SCRAM-SHA-256 verifier reproduced byte-for-byte from a real PostgreSQL 17.10 `pg_authid.rolpassword`.

## Summary

- Target Node `>=22.12.0` (Node 22 "Jod" is Maintenance LTS until 2027-04-30; Node 24 "Krypton" is Active LTS; Node 26 becomes LTS on 2026-10-28). CI on 22 and 24; publish from 24 (bundles npm 11.19, needed for trusted publishing).
- The npm name `dbm` is taken (v1.4.20, updated 2026-08-05). `db-manager` is free. Publish as `db-manager` with `bin: { "dbm": ... }`; `npx db-manager` runs `dbm` because the package has a single bin. `npx dbm` cannot work.
- Build with plain `tsc` (TypeScript 7.0.2, native Go compiler) to `dist/`, plus a hand-written `bin/dbm.js` with the shebang. No bundler. tsup is unmaintained; tsdown is the successor if bundling is ever wanted.
- Lint/format with Biome 2.5.15, not ESLint+Prettier: typescript-eslint's peer range is `typescript <6.1.0`, so it does not support TS 7.
- Zod 4.6.5 (`import { z } from 'zod'`); the v4 API is the default export of the package. Use `z.discriminatedUnion('version', ...)` plus a migration table for `state.json`.
- Commander 15.0.0 (ESM-only, Node >=22.12), execa 10.0.1 (Node >=22), pg 8.23.1 (ESM named imports), picocolors 1.1.1.
- Vitest 5.0.3 requires `vite` as a non-optional peer: add `vite@8.3.1` to devDependencies. Do not set a root `test.include` when using `projects` (it merges into every project).
- Remote execution: system `ssh` via execa with `-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10`; SQL and file contents go over stdin, argv is built with `shlex.join`. `ssh2` is not recommended (no `~/.ssh/config`/`known_hosts` reuse).
- MSW 3.0.1 for Dokploy fixtures (`server.listen({ onUnhandledFrame: 'error' })` — the option was renamed from `onUnhandledRequest` in v3).
- Release: release-please (conventional commits) + npm trusted publishing (OIDC, automatic provenance, no token secret).

## Pinned versions

All from `npm view <pkg> version` on 2026-09-30 unless noted.

| Package | Version | Node engines (from `npm view … engines`) | Notes |
|---|---|---|---|
| `typescript` | 7.0.2 | `>=16.20.0` | Native Go compiler; `latest` tag. No programmatic API in 7.0 (expected 7.1). Fallback JS compiler: `typescript@6.0.3` or `npm:@typescript/typescript6@6.0.2`. |
| `commander` | 15.0.0 | `>=22.12.0` | ESM-only since v15. |
| `zod` | 4.6.5 | (none declared) | v4 is the default `zod` export; `zod/v3`, `zod/v4`, `zod/mini` subpaths exist. |
| `execa` | 10.0.1 | `>=22` | Subprocess is a plain promise now; `execaCommand` removed. |
| `pg` | 8.23.1 | `>= 16.0.0` | ESM named imports since 8.15.x. |
| `@types/pg` | 8.23.1 | — | |
| `vitest` | 5.0.3 | `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` | Peer `vite ^6.4 \|\| ^7 \|\| ^8` is **not optional**. |
| `vite` | 8.3.1 | `^20.19.0 \|\| >=22.12.0` | Required by vitest 5 as peer. |
| `@vitest/coverage-v8` | 5.0.3 | — | Optional. |
| `tsx` | 4.23.15 | `>=18.0.0` | Optional: Node 22.18+ strips types natively (see below). |
| `picocolors` | 1.1.1 | — | ESM+CJS, types bundled, `NO_COLOR` honoured. |
| `@types/node` | 22.20.4 | — | Match the minimum Node line (`npm view @types/node@22 version`). Latest overall is 26.6.3. |
| `@biomejs/biome` | 2.5.15 | `>=14.21.3` | Schema URL `https://biomejs.dev/schemas/2.5.15/schema.json` returns 200. |
| `msw` | 3.0.1 | `>=22.12.0` | ESM-only; peer `typescript >=5.9`; released 2026-09-28. |
| `shlex` | 3.0.0 | — | Ships `shlex.d.ts`; `quote`/`join`/`split`. Last published 2025-06-28. |
| `release-please` (CLI) | 17.11.2 | `>=22.0.0` | Used via `googleapis/release-please-action@v5` (v5.0.0, 2026-04-22). |
| `tsdown` | 0.23.0 | `^22.18.0 \|\| ^24.11.0 \|\| >=26.0.0` | Not used; recorded as the bundler choice if one is ever needed. |
| `tsup` | 8.5.1 | — | README says "not actively maintained anymore". Do not use. |
| `unbuild` | 3.6.1 | — | Not evaluated beyond version; not recommended for a CLI. |
| `eslint` / `typescript-eslint` / `prettier` | 10.11.0 / 8.71.0 / 3.9.9 | eslint `^20.19 \|\| ^22.13 \|\| >=24` | typescript-eslint peer `typescript >=4.8.4 <6.1.0` — incompatible with TS 7. Not used. |
| `@changesets/cli` | 3.0.3 | `^22.11 \|\| ^24 \|\| >=26` | Alternative to release-please; not used. |
| `ssh2` | 1.17.0 | `>=10.16.0` | Not used. |
| `undici` | 8.11.2 | `>=22.19.0` | Not used (MSW chosen). |

Node release lines (nodejs/Release README, fetched 2026-09-30):

| Line | Codename | Active LTS | Maintenance | EOL | Bundled npm (dist/index.json) |
|---|---|---|---|---|---|
| 22.x (22.23.3) | Jod | 2024-10-29 | 2025-10-21 | 2027-04-30 | 10.9.9 |
| 24.x (24.21.0) | Krypton | 2025-10-28 | 2026-10-20 | 2028-04-30 | 11.19.0 |
| 26.x (26.10.0) | — | 2026-10-28 | 2027-10-20 | 2029-04-30 | 11.19.1 |

Package name check (`npm view`, 2026-09-30): `dbm` → **taken** (1.4.20, maintainer `developedbyme`, modified 2026-08-05, no description/bin/readme). `db-manager` → **404, available**. `dbm-cli` taken (1.0.0), `db-mgr` taken (1.0.3), `dbmanager` taken (1.0.0), `dbmgr` available, `@bautygarcia/dbm` available (scope name is a guess at the owner's npm user; confirm).

## Recommended package.json / tsconfig / vitest.config

### package.json

```json
{
  "name": "db-manager",
  "version": "0.1.0",
  "description": "Self-hosted per-project Postgres + S3 on one VPS, managed from the CLI (dbm).",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/<owner>/db-manager.git" },
  "homepage": "https://github.com/<owner>/db-manager#readme",
  "bugs": { "url": "https://github.com/<owner>/db-manager/issues" },
  "keywords": ["postgres", "pgbouncer", "dokploy", "garage", "s3", "vps", "cli"],
  "type": "module",
  "engines": { "node": ">=22.12.0" },
  "bin": { "dbm": "./bin/dbm.js" },
  "exports": {
    ".": "./dist/cli.js",
    "./package.json": "./package.json"
  },
  "files": ["bin", "dist", "templates", "skills", "compose"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit",
    "lint": "biome ci .",
    "lint:fix": "biome check --write .",
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test:watch": "vitest --project unit",
    "dev": "tsx src/cli.ts",
    "prepack": "npm run clean && npm run build"
  },
  "dependencies": {
    "commander": "15.0.0",
    "execa": "10.0.1",
    "pg": "8.23.1",
    "picocolors": "1.1.1",
    "shlex": "3.0.0",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.15",
    "@types/node": "22.20.4",
    "@types/pg": "8.23.1",
    "msw": "3.0.1",
    "tsx": "4.23.15",
    "typescript": "7.0.2",
    "vite": "8.3.1",
    "vitest": "5.0.3"
  },
  "publishConfig": { "access": "public" }
}
```

Notes:
- `bin` files must start with `#!/usr/bin/env node` (npm docs). `package.json`, `README`, `LICENSE` and the `bin` files are always included in the tarball; when `files` is present at the root, `.npmignore` is ignored entirely (npm docs). So: use `files`, do not create `.npmignore`.
- `npx db-manager` runs `dbm`: "If the package has a single entry in its `bin` field … that command will be used" (npx docs). `npx dbm` would download and run the unrelated `dbm@1.4.20`. Document `npx db-manager …` and `npm i -g db-manager`.
- Dependencies are pinned exactly (no `^`) so that multiple AI implementers get identical trees; bump deliberately.
- `dev` uses tsx. Node 22.18+ also runs `node src/cli.ts` directly (type stripping is on by default and "no longer experimental as of v22.18.0"), but it requires `.ts` import specifiers; the layout below uses `.js` specifiers so `tsx`/Vitest are the dev runners. `tsx` is optional if you prefer `.ts` specifiers plus `rewriteRelativeImportExtensions` (not tested here).

### bin/dbm.js (committed with the exec bit; plain JS, no build step)

```js
#!/usr/bin/env node
import { run } from '../dist/cli.js';

process.exitCode = await run(process.argv.slice(2));
```

Verified: `./bin/dbm.js fail x` printed the error and exited 2; `--version` exited 0. Setting `process.exitCode` and letting the loop drain is the documented alternative to `process.exit()`, which "will force the process to exit as quickly as possible even if there are still asynchronous operations pending … including I/O operations to `process.stdout`" (Node process docs).

### tsconfig.json (type-check everything; no emit)

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true,
    "rootDir": ".",
    "outDir": "dist",
    "noEmit": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

### tsconfig.build.json (emit `src` only)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

TS 6/7 notes that shaped this: TS 6.0 deprecated and 7.0 removed `moduleResolution: node/node10/classic`, `module: amd/umd/systemjs/none`, `baseUrl`, `outFile`, `target: es5`; 7.0 defaults are `strict: true`, `module: esnext`, `types: []`, `rootDir: .` — so `types: ["node"]` and `rootDir` are set explicitly. `module: nodenext` + `moduleResolution: nodenext` remain the recommendation for Node. Relative imports inside `src/` use `.js` specifiers (`import { x } from './core/naming.js'`), which is what `nodenext` resolves and what Vitest/tsx map back to `.ts`.

`erasableSyntaxOnly: true` is deliberate (keeps the code runnable by Node's native type stripping), and it bites: **no `enum`, no `namespace` with runtime code, no constructor parameter properties** (`constructor(readonly x: number)` fails with TS1294 — observed in the smoke build). Use `as const` objects for enums and declare class fields explicitly.

### vitest.config.ts

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Do NOT set `include` here: with `extends: true` it merges into every project
    // (observed: the unit file ran under the integration project too).
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts', 'test/adapters/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
```

Vitest 5 changes worth knowing (migration guide): Node >=22.12 and Vite >=6.4; `test.clearMocks` now defaults to `true`; unawaited async assertions fail the test; `vi.mock()` must be top-level; coverage/reporters can only be set at root, not per project. `--project unit` selects one project.

### test/integration/global-setup.ts (verified against Docker 27.4 / Compose 2.31 locally)

```ts
import { execa } from 'execa';
import type { TestProject } from 'vitest/node';

const compose = ['compose', '-f', 'test/compose/compose.yaml'];

export default async function setup(project: TestProject) {
  await execa('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '120'], { stdio: 'inherit' });
  project.provide('pgUrl', 'postgres://postgres:test@127.0.0.1:55432/postgres');
  return async () => {
    if (process.env.DBM_TEST_KEEP !== '1') {
      await execa('docker', [...compose, 'down', '-v', '--remove-orphans', '-t', '5'], { stdio: 'inherit' });
    }
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgUrl: string;
  }
}
```

`--wait`: "Wait for services to be running|healthy. Implies detached mode." `down -v`: "Remove named volumes declared in the volumes section of the Compose file and anonymous volumes attached to containers" (Docker docs). `globalSetup` runs in a separate process from tests, so data must flow through `project.provide()` / `inject()` (Vitest docs). Tests read it with `import { inject } from 'vitest'; inject('pgUrl')`. Services in `test/compose/compose.yaml` need a `healthcheck:` for `--wait` to be meaningful (e.g. `pg_isready -U postgres` for Postgres; PgBouncer/Garage need their own).

### biome.json

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.15/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!dist", "!node_modules", "!coverage", "!templates/nextjs"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "javascript": {
    "formatter": { "quoteStyle": "single", "semicolons": "always", "trailingCommas": "all" }
  },
  "linter": { "enabled": true, "rules": { "preset": "recommended" } },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```

`rules.recommended: true` is deprecated in 2.5 ("Use `preset` instead"); `preset` accepts `"recommended"` (default), `"all"`, `"none"`. `biome ci .` is the CI command; `biome check --write .` fixes locally. `templates/nextjs` is excluded so the copied-verbatim templates are not reformatted.

### .nvmrc

```
22
```

## Code patterns

### 1. Commander: subcommands, global `--json`, typed exit codes, testable I/O

```ts
// src/core/exit.ts
export const ExitCode = { Ok: 0, UserError: 1, RemoteFailure: 2, RollbackFailed: 3 } as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export class DbmError extends Error {
  readonly exitCode: ExitCode;
  readonly step: string | undefined; // e.g. 'dokploy.create', 'ssh.pgbouncer-reload'
  constructor(message: string, exitCode: ExitCode, step?: string) {
    super(message);
    this.name = 'DbmError';
    this.exitCode = exitCode;
    this.step = step;
  }
}
```

```ts
// src/cli.ts
import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import { DbmError, ExitCode } from './core/exit.js';

export interface Io { out: (s: string) => void; err: (s: string) => void }

export function buildProgram(io: Io): Command {
  const program = new Command('dbm')
    .version(VERSION)
    .description('Personal database platform on one VPS')
    .option('--json', 'machine-readable output', false)
    .option('--yes', 'skip confirmations', false)
    .enablePositionalOptions()
    .exitOverride()                                   // throw CommanderError instead of process.exit
    .configureOutput({ writeOut: io.out, writeErr: io.err });

  program.command('create')
    .argument('<slug>')
    .option('--memory <size>', 'container memory limit', '512m')
    .action(async function (this: Command, slug: string, opts: { memory: string }) {
      const { json } = this.optsWithGlobals<{ json: boolean }>();  // merged global + local
      const result = await createCommand({ slug, memory: opts.memory }, deps);
      io.out(json ? `${JSON.stringify(result)}\n` : renderEnvBlock(result));
    });
  return program;
}

export async function run(argv: string[], io: Io = stdIo): Promise<number> {
  const program = buildProgram(io);
  try {
    await program.parseAsync(argv, { from: 'user' });   // argv without node/script
    return ExitCode.Ok;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : ExitCode.UserError; // --help/--version → 0
    if (e instanceof DbmError) {
      io.err(`${pc.red('error')}${e.step ? ` [${e.step}]` : ''}: ${e.message}\n`);
      return e.exitCode;
    }
    io.err(`unexpected: ${String(e)}\n`);
    return ExitCode.RemoteFailure;
  }
}
```

Unit test (verified under Vitest 5):

```ts
function capture() {
  const out: string[] = [], err: string[] = [];
  return { io: { out: (s: string) => { out.push(s); }, err: (s: string) => { err.push(s); } }, out, err };
}
it('--json is visible in the subcommand', async () => {
  const c = capture();
  expect(await run(['--json', 'secret'], c.io)).toBe(0);
  expect(JSON.parse(c.out.join(''))).toMatchObject({ secret: expect.any(String) });
});
it('remote failure → 2', async () => {
  const c = capture();
  expect(await run(['fail', 'myapp'], c.io)).toBe(2);
  expect(c.err.join('')).toContain('[dokploy.create]');
});
```

Commander references: `.exitOverride()` throws `CommanderError` with `exitCode`, `code`, `message`; `.configureOutput({ writeOut, writeErr, outputError })`; `.parseAsync(argv, { from: 'user' })`; `.optsWithGlobals()` "returns merged local and global option values"; `.error(msg, { exitCode, code })` for commander-styled errors; `.hook('preAction', ...)` if you want `--json` to switch picocolors off globally (`createColors(false)`). Commander 15 is ESM-only and requires Node >=22.12. `--json` output should be the only thing on stdout; all human text goes to stderr in JSON mode.

### 2. Secure random secrets

```ts
import { randomBytes } from 'node:crypto';
/** 32 bytes → 43-char base64url string, URL/shell/SQL-literal safe ([A-Za-z0-9_-]). */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
```

`crypto.randomBytes` "generates cryptographically strong pseudorandom data" and returns a Buffer synchronously without a callback (Node crypto docs). `'base64url'` "will omit padding" when encoding (Node buffer docs; added v15.7.0). Because the alphabet has no quotes, `PASSWORD '<secret>'` needs no SQL escaping and the secret is SASLprep-neutral (ASCII). For `BETTER_AUTH_SECRET` the spec says "base64"; base64url is accepted by better-auth as an opaque string, but confirm if a strict base64 consumer exists.

### 3. Files with 0600 (and why `chmod` is still needed) + atomic JSON writes

```ts
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);                     // mkdir's mode is ignored when the dir already exists
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',                                // fail if tmp exists; never widen an existing file
  });
  await rename(tmp, file);                     // atomic replace on the same filesystem
  await chmod(file, 0o600);                    // belt and braces
}
```

Why: for `fsPromises.writeFile`, "the `mode` option only applies when the file is created. If the file already exists, the `mode` is ignored" (Node fs docs) — hence the explicit `chmod`. `rename(2)`: "If newpath already exists, it will be atomically replaced, so that there is no point at which another process attempting to access newpath will find it missing"; it fails with `EXDEV` across filesystems, which is why the temp file lives in the same directory. Verified in the smoke test: after two writes the file is `0600`, the directory `0700`, and content is the second write. The `state.json.bak.<ts>` copy is just another `writeJsonAtomic` call before mutation.

### 4. Zod 4 versioned state schema with migrations

```ts
import { z } from 'zod';

const ProjectV1 = z.object({ slug: z.string(), createdAt: z.string(), status: z.enum(['running', 'paused']) /* … */ });
export const StateV1 = z.object({ version: z.literal(1), projects: z.record(z.string(), ProjectV1) });

// Future: bump CURRENT_VERSION, add StateV2, add migrations[1].
export const CURRENT_VERSION = 1;
export const StateCurrent = StateV1;
export type State = z.infer<typeof StateCurrent>;

const AnyState = z.discriminatedUnion('version', [StateV1 /* , StateV2 */]);
const migrations: Record<number, (s: unknown) => unknown> = {
  // 1: (s) => ({ ...(s as z.infer<typeof StateV1>), version: 2, /* transform */ }),
};

export function loadState(raw: unknown): State {
  let s: unknown = AnyState.parse(raw);                 // rejects unknown versions early
  while ((s as { version: number }).version < CURRENT_VERSION) {
    const v = (s as { version: number }).version;
    const m = migrations[v];
    if (!m) throw new Error(`no migration from state version ${v}`);
    s = m(s);
  }
  return StateCurrent.parse(s);                          // re-validate after migrating
}
```

Verified with a v1→v2 example (extra field with `.default('')`) in the smoke tests. Zod 4 rules to remember (zod.dev/v4/changelog): `z.record()` needs two args; `.strict()`/`.passthrough()` → `z.strictObject()`/`z.looseObject()`; `.merge()` deprecated → `.extend()`; `message:` → `error:`; `z.string().email()` → `z.email()`; `.default()` now short-circuits and must match the output type (use `.prefault()` for the old behaviour); `ZodError.format()/flatten()` deprecated → `z.treeifyError()` / `z.prettifyError()`; `safeParse` returns `{ success, data } | { success, error }`.

### 5. SSH from Node: execa + system `ssh`

Recommended `SshRunner` (adapters/ssh.ts):

```ts
import { execa, type Options } from 'execa';
import { join as shJoin } from 'shlex';

const SSH_OPTS = [
  '-o', 'BatchMode=yes',                    // never prompt (passwords, host-key confirmation)
  '-o', 'StrictHostKeyChecking=accept-new', // add unknown hosts, refuse changed keys (OpenSSH ≥7.6)
  '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
  '-o', 'LogLevel=ERROR',
  // optional speed-up for many calls per command (multiplexing):
  '-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', 'ControlPath=~/.ssh/dbm-%C',
];

export interface SshRunner {
  run(argv: string[], opts?: { input?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>;
  upload(remotePath: string, content: string, mode?: string): Promise<void>;
}

export function makeSshRunner(host: string, user = 'root'): SshRunner {
  const base = (input?: string, timeoutMs = 60_000): Options => ({
    input, timeout: timeoutMs, reject: false, stripFinalNewline: true, stdin: input === undefined ? 'ignore' : 'pipe',
  });
  async function ssh(remoteArgv: string[], input?: string, timeoutMs?: number) {
    const remote = shJoin(remoteArgv);       // one POSIX-quoted string for the remote shell
    const r = await execa('ssh', [...SSH_OPTS, `${user}@${host}`, remote], base(input, timeoutMs));
    if (r.timedOut) throw new DbmError(`ssh timed out after ${timeoutMs}ms: ${remote}`, ExitCode.RemoteFailure, 'ssh');
    if (r.exitCode !== 0) throw new DbmError(r.stderr || r.shortMessage, ExitCode.RemoteFailure, 'ssh');
    return { stdout: r.stdout, stderr: r.stderr };
  }
  return {
    run: (argv, o) => ssh(argv, o?.input, o?.timeoutMs),
    // Upload = `install -m 0600 -D /dev/stdin <path>` with the content on stdin (no scp, one round-trip).
    upload: async (remotePath, content, mode = '0600') => { await ssh(['install', '-m', mode, '-D', '/dev/stdin', remotePath], content); },
  };
}

// PostgresAdmin.runSql: SQL goes over stdin, never in argv.
await ssh.run(['docker', 'exec', '-i', appName, 'psql', '-U', adminRole, '-d', db, '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: sql });
// PgBouncer reload:
await ssh.run(['docker', 'kill', '-s', 'HUP', pgbouncerContainer]);
```

Verified: `ssh -G` on OpenSSH 9.9 accepted every option above; `printf … | docker exec -i <c> psql -v ON_ERROR_STOP=1` created a role from stdin; `install -m 0600 -D /dev/stdin /etc/dokploy/dbm/pgbouncer/pgbouncer.ini` on `ubuntu:24.04` produced a `0600 root` file with the right content; `docker kill -s HUP` is valid syntax. For a strictly atomic replace (PgBouncer may read the file at any time), use the mktemp+mv variant instead of `install` — also verified:
`sh -c 'set -e; d=/etc/dokploy/dbm/pgbouncer; umask 077; t=$(mktemp "$d/.tmp.XXXXXX"); cat > "$t"; mv -f "$t" "$d/userlist.txt"'` with content on stdin.

execa 10 facts used above (docs/api.md, docs/errors.md, docs/termination.md): `input` (string/Buffer/stream) feeds stdin; `timeout` sends SIGTERM and sets `error.timedOut`; `reject: false` returns the error-shaped result instead of throwing; `exitCode` is `undefined` when killed by a signal; `shortMessage` excludes stdout/stderr; `stdin: 'inherit'` for the interactive `dbm psql` (`execa('ssh', ['-t', ...], { stdio: 'inherit' })`). Set `stdin: 'ignore'` when there is no input so `ssh` does not consume the parent's stdin.

Quoting: `shlex` 3.0.0 — `quote("it's a $test")` → `'it'"'"'s a $test'`; `join(['docker','exec','-i','pg-my app','psql','-c',"select 'x'"])` → `docker exec -i 'pg-my app' psql -c 'select '"'"'x'"'"`; ships `shlex.d.ts` (typecheck verified). It implements Python `shlex` semantics and is single-maintainer with the last publish 2025-06-28 — small and stable rather than abandoned; `shell-quote` 1.11.0 (ljharb, active 2026-09) is the alternative. Because all remote argv values are our own validated slugs/appNames, quoting is defence in depth; data (SQL, file contents) never goes through the shell at all.

scp vs `ssh 'cat > file'`: prefer the stdin upload above. scp needs a second binary and a two-step (`scp` + `ssh chmod/mv`), whereas one `ssh install`/`mktemp+mv` call gives mode, ownership and atomicity in a single round-trip. Keep `scp` only for `dbm import`'s large dump transfer if streaming through `ssh 'cat > …'` proves slow (unmeasured).

ssh2 comparison: `ssh2` 1.17.0 (Node >=10.16, types via `@types/ssh2` 1.15.6) works in-process but "does not automatically read `~/.ssh/config` or `~/.ssh/known_hosts`"; without a `hostVerifier` it accepts any host key, and agent use must be wired manually (`agent: process.env.SSH_AUTH_SOCK`). The system `ssh` gives the operator's config, keys, agent, known_hosts, ProxyJump and Tailscale SSH for free, and `dbm psql` needs a real TTY anyway. Recommendation: system `ssh` via execa (as the spec says); ssh2 is not needed.

### 6. SCRAM-SHA-256 verifier in Node (verified against PostgreSQL 17.10)

No maintained npm package exists for this: `pg-scram`, `@pgsql/scram`, `scram-sha-256`, `postgres-scram-sha-256` all return 404 on `npm view` (2026-09-30), and a web search found only web tools/gists. The reference implementation is ~10 lines of `node:crypto`:

```ts
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/**
 * Build the PostgreSQL SCRAM-SHA-256 secret for a password, same format as pg_authid.rolpassword
 * and PgBouncer userlist.txt: SCRAM-SHA-256$<iterations>:<salt b64>$<StoredKey b64>:<ServerKey b64>
 * Password must be SASLprep'd (RFC 4013); dbm passwords are ASCII base64url, for which SASLprep is a no-op.
 */
export function scramSha256Verifier(
  password: string,
  { salt = randomBytes(16), iterations = 4096 }: { salt?: Buffer; iterations?: number } = {},
): string {
  const saltedPassword = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256'); // Hi()
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
```

Evidence: constants and structure from PostgreSQL `src/common/scram-common.c` (`scram_build_secret` formats `"SCRAM-SHA-256$%d:"` + b64 salt + `$` + b64 StoredKey + `:` + b64 ServerKey; `scram_ClientKey`/`scram_ServerKey` HMAC the literals `"Client Key"`/`"Server Key"`), `scram-common.h` (`SCRAM_DEFAULT_SALT_LEN 16`, `SCRAM_SHA_256_DEFAULT_ITERATIONS 4096`), PG 17 docs (`scram_iterations` default 4096; passwords are SASLprep'd), and node-postgres `sasl.js` (same derivation on the client side). Empirical check on 2026-09-30: created a role with a random base64url password in `postgres:17` (17.10), read `rolpassword`, recomputed with the same salt/iterations → `MATCH`; also `CREATE ROLE demo2 LOGIN PASSWORD '<verifier computed locally>'` then `psql -U demo2` with the plaintext → login OK. PostgreSQL accepts a pre-computed verifier as the `PASSWORD` literal, so `dbm` can compute the verifier once, use it in `CREATE ROLE`, and write the identical string to `userlist.txt` — which also satisfies PgBouncer's requirement that "the SCRAM secrets are identical in PgBouncer and the PostgreSQL server (same salt and iterations)" if server-side SCRAM is ever enabled (PgBouncer config docs). Reading `pg_authid` afterwards (the spec's approach) remains valid; the local computation avoids one round-trip and a superuser `SELECT`.

### 7. HTTP fixtures for the Dokploy client: MSW 3 (recommended) vs undici MockAgent

MSW 3.0.1 pattern (verified under Vitest 5 with global `fetch`):

```ts
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import fixture from '../fixtures/dokploy/project.all.json' with { type: 'json' };

const server = setupServer(
  http.get('https://dokploy.test/api/project.all', ({ request }) => {
    if (request.headers.get('x-api-key') !== 'tok') return new HttpResponse(null, { status: 401 });
    return HttpResponse.json(fixture.response);
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' })); // v3 name; was onUnhandledRequest in v2
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

An unhandled `fetch` rejected instead of touching the network (verified). Fixture files are `{ request: {method, path, body?}, response: … }` JSON recorded once from a real Dokploy; a small helper can turn a directory of fixtures into handlers. MSW 3 is ESM-only, Node >=22.12, TS >=5.9, and moved GraphQL to `msw/graphql` (irrelevant here).

undici `MockAgent` (`new MockAgent(); setGlobalDispatcher(agent); agent.disableNetConnect(); agent.get(origin).intercept({ path, method }).reply(200, body)`) also works with global `fetch`, but requires `undici@8.11.2` as a dependency whose engines are `>=22.19.0` (stricter than our floor) and couples tests to the npm undici version rather than Node's bundled one. MSW is the better-documented choice and is what the spec already names.

## CI workflow

`.github/workflows/ci.yml`

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck

  unit:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: [22, 24]
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run test:unit
      - run: npm run build
      - name: smoke the packed CLI
        run: |
          npm pack --silent
          npx --yes ./db-manager-*.tgz --version

  integration:
    runs-on: ubuntu-latest   # ubuntu-24.04 image ships Docker 28.0.4 + Compose 2.38.2
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: docker compose version
      - run: npm ci
      - run: npm run test:integration
      - name: compose logs on failure
        if: failure()
        run: docker compose -f test/compose/compose.yaml logs --no-color || true
```

`.github/workflows/release.yml` (release-please + npm trusted publishing; configure the trusted publisher on npmjs.com with repository `<owner>/db-manager` and workflow filename `release.yml`)

```yaml
name: release

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write
  issues: write
  id-token: write        # OIDC for npm trusted publishing

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - id: release
        uses: googleapis/release-please-action@v5
        with:
          release-type: node
          # token: ${{ secrets.RELEASE_PLEASE_TOKEN }}  # optional PAT so CI runs on the release PR

      - uses: actions/checkout@v6
        if: ${{ steps.release.outputs.release_created }}
      - uses: actions/setup-node@v6
        if: ${{ steps.release.outputs.release_created }}
        with:
          node-version: 24                       # bundles npm 11.19.0 (trusted publishing needs >= 11.5.1)
          registry-url: https://registry.npmjs.org
          cache: npm
      - run: npm ci
        if: ${{ steps.release.outputs.release_created }}
      - run: npm run build
        if: ${{ steps.release.outputs.release_created }}
      - run: npm publish
        if: ${{ steps.release.outputs.release_created }}
        # No NODE_AUTH_TOKEN: OIDC trusted publishing; provenance is generated automatically.
```

Facts behind this: trusted publishing needs `id-token: write`, npm CLI >= 11.5.1, Node >= 22.14, a GitHub-hosted runner, no `NODE_AUTH_TOKEN`; "npm automatically generates and publishes provenance attestations" for public repos (npm docs, which themselves use `actions/checkout@v6` / `actions/setup-node@v6`). The classic path (`npm publish --provenance` with an `NPM_TOKEN`) needs npm >= 9.5.0 and a matching public `repository` field. release-please-action exposes `release_created`, `tag_name`, `version`; the job needs `contents: write`, `pull-requests: write`, `issues: write`; with the default `GITHUB_TOKEN`, workflows are not triggered on the release PR — use a PAT if you want `ci.yml` to run on it. v5.0.0 (2026-04-22) upgraded the action runtime to Node 24; the README examples still show `@v4`.

Why release-please over changesets: one package, conventional commits are what AI implementers already write, no per-PR changeset file to forget, and the CHANGELOG/tag/GitHub Release come from one PR merge. `@changesets/cli@3.0.3` is fine if per-PR intent files are preferred.

LICENSE: MIT text from opensource.org/license/mit (copy verbatim, replace `<YEAR> <COPYRIGHT HOLDER>`):

```
MIT License

Copyright (c) 2026 <COPYRIGHT HOLDER>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

`.gitignore` additions per spec: `node_modules/`, `dist/`, `coverage/`, `.vitest/` (Vitest 5 consolidates artifacts there), `.dbm/`, `*.local.json`, `.env*`, `*.tgz`.

## Unverified / uncertain

- Exact latest patch tags of `actions/checkout@v6` and `actions/setup-node@v6`: the GitHub releases pages returned inconsistent dates through the fetch tool. The v6 majors are confirmed by npm's own trusted-publishing docs; pin to `@v6` (or look up the SHA when creating the repo).
- `tsdown` shebang/`chmod +x` behaviour: the options page 404'd; the CLI reference mentions a `bin` option that auto-detects a shebang entry. Irrelevant with the recommended `bin/dbm.js` wrapper.
- `unbuild` 3.6.1 was only version-checked, not evaluated.
- `@bautygarcia/dbm` as the scoped fallback assumes the npm username; confirm before relying on it.
- `exports: { ".": "./dist/cli.js" }` exposes `run()`/`buildProgram()` programmatically; whether that surface should be public is a product decision. Behaviour of an empty `exports: {}` was not tested.
- Vitest 5 `provide/inject` typing via `declare module 'vitest' { interface ProvidedContext }` worked when the declaration sits in the global-setup file (typecheck passed); the docs show the same.
- `install -m 0600 -D /dev/stdin <path>` was verified on `ubuntu:24.04`; Ubuntu 22.04 coreutils should behave the same but was not run. The mktemp+mv variant is POSIX-shell only and safer for files PgBouncer reads.
- Whether better-auth requires standard base64 (with `+/=`) for `BETTER_AUTH_SECRET` rather than base64url was not checked (other researcher's domain).
- Trusted publishing "first publish" behaviour: npm's docs describe configuring a trusted publisher in package settings, which implies the package must exist; the first `0.1.0` may need a one-off manual `npm publish --provenance` from a laptop. Not confirmed.
- No timing was done for `scp` vs `ssh 'cat > file'` for large dumps.

## Recommended spec deviations

1. **Package name (5.6):** publish as `db-manager` with bin `dbm`. `npx dbm` is not achievable because `dbm` is an active third-party package; document `npx db-manager` and `npm i -g db-manager`. Scoped fallback: `@<npm-user>/dbm`.
2. **Node floor (3, 5.6):** state `>=22.12.0` (not just "22+") — commander 15, vitest 5 and msw 3 all require it. Test on 22 and 24; add 26 to the matrix after 2026-10-28.
3. **Dependencies (5.6):** add `shlex` (runtime) and, as devDependencies, `vite` (mandatory vitest 5 peer), `@biomejs/biome`, `msw`, `tsx`, `@types/node`, `@types/pg`. Drop any plan for eslint/prettier.
4. **SCRAM verifier (5.2/5.3):** compute the verifier locally with `node:crypto` and pass it as the `PASSWORD` literal in `CREATE ROLE`, writing the same string to `userlist.txt`. Reading `pg_authid` becomes an optional consistency check in `dbm doctor` rather than the source of the verifier.
5. **Uploads (5.3):** replace "scp" with a single `ssh … 'umask 077; t=$(mktemp …); cat > "$t"; mv -f "$t" <path>'` call over stdin; drop the `scp` binary from prerequisites.
6. **Coding rules for implementers (5.6):** `erasableSyntaxOnly` forbids `enum`, runtime `namespace`, and constructor parameter properties; use `as const` objects and explicit fields. Relative imports use `.js` specifiers.
7. **Testing (15):** the "Adapter contract" and "Dokploy adapter" rows both run in the `unit` Vitest project (`test/adapters/**`), the compose-backed suite in the `integration` project; CI runs integration on every PR on `ubuntu-latest`, which has Compose 2.38.2 preinstalled — no extra setup action.
8. **Exit codes (14):** commander's own parse errors (unknown command/option, missing argument) map to exit 1 (user error); `--help`/`--version` exit 0. In `--json` mode stdout carries only the JSON document; diagnostics go to stderr.
9. **Repo layout (16):** add `bin/dbm.js`, `tsconfig.build.json`, `biome.json`, `.nvmrc`, `.github/workflows/{ci,release}.yml`, `test/compose/compose.yaml` with healthchecks; `dist/` is build output (gitignored, published).
10. **Release process (not in spec):** release-please PR → merge → GitHub Release → npm publish via OIDC trusted publishing with automatic provenance. No `NPM_TOKEN` secret in the repo.

## Sources

Registry data (all `npm view <pkg> …`, 2026-09-30): `typescript` 7.0.2 (dist-tags latest 7.0.2, rc 7.0.1-rc; `typescript@6` → 6.0.3; `@typescript/typescript6` 6.0.2), `commander` 15.0.0 (engines `>=22.12.0`), `zod` 4.6.5, `execa` 10.0.1 (`>=22`), `pg` 8.23.1, `@types/pg` 8.23.1, `vitest` 5.0.3 (engines `^22.12.0 || ^24.0.0 || >=26.0.0`; `peerDependenciesMeta.vite.optional = false`), `vite` 8.3.1, `tsx` 4.23.15, `picocolors` 1.1.1, `tsup` 8.5.1, `tsdown` 0.23.0, `unbuild` 3.6.1, `@types/node` 26.6.3 / `@types/node@22` 22.20.4 / `@types/node@24` 24.19.0, `eslint` 10.11.0, `prettier` 3.9.9, `@biomejs/biome` 2.5.15, `typescript-eslint` 8.71.0 (peer `typescript >=4.8.4 <6.1.0`), `msw` 3.0.1 (`>=22.12.0`, peer `typescript >=5.9.x`), `undici` 8.11.2 (`>=22.19.0`), `ssh2` 1.17.0, `@types/ssh2` 1.15.6, `shell-quote` 1.11.0, `shlex` 3.0.0 (`types: shlex.d.ts`), `@changesets/cli` 3.0.3, `release-please` 17.11.2, `dbm` 1.4.20 (taken), `db-manager` E404, `dbm-cli` 1.0.0, `db-mgr` 1.0.3, `dbmanager` 1.0.0, `dbmgr` E404, `@bautygarcia/dbm` E404; `pg-scram`, `@pgsql/scram`, `scram-sha-256`, `postgres-scram-sha-256` all E404. Node bundled npm from `https://nodejs.org/dist/index.json` (v22.23.3 → npm 10.9.9; v24.21.0 → 11.19.0; v26.10.0 → 11.19.1).

- Node release schedule: https://github.com/nodejs/Release (README) and https://nodejs.org/en/about/previous-releases
- Node type stripping (default since 22.18.0, `erasableSyntaxOnly`, `.ts` specifiers): https://nodejs.org/docs/latest-v22.x/api/typescript.html
- Node fs `writeFile` mode only on create; `mkdir` mode/recursive: https://nodejs.org/api/fs.html#fspromiseswritefilefile-data-options
- Node `crypto.randomBytes`: https://nodejs.org/api/crypto.html#cryptorandombytessize-callback
- Node Buffer `base64url`: https://nodejs.org/api/buffer.html#buffers-and-character-encodings
- Node `process.exitCode` vs `process.exit()`: https://nodejs.org/api/process.html#processexitcode_1
- rename(2) atomicity / EXDEV: https://man7.org/linux/man-pages/man2/rename.2.html
- TypeScript 7.0 announcement (native compiler, removed options, defaults, no API yet): https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- TypeScript 6.0 announcement (deprecations, new defaults, nodenext recommendation): https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/
- Zod 4 changelog: https://zod.dev/v4/changelog ; Zod API (discriminatedUnion, record, safeParse, transform): https://zod.dev/api
- Commander README (exitOverride, configureOutput, parseAsync from:'user', optsWithGlobals, error(), hooks): https://github.com/tj/commander.js/blob/master/Readme.md ; CHANGELOG (v15 ESM-only, Node 22.12): https://github.com/tj/commander.js/blob/master/CHANGELOG.md
- execa docs — input: https://github.com/sindresorhus/execa/blob/main/docs/input.md ; errors: https://github.com/sindresorhus/execa/blob/main/docs/errors.md ; termination/timeout: https://github.com/sindresorhus/execa/blob/main/docs/termination.md ; API: https://github.com/sindresorhus/execa/blob/main/docs/api.md ; v10 release notes: https://github.com/sindresorhus/execa/releases
- node-postgres ESM named imports: https://node-postgres.com/features/esm ; SSL: https://node-postgres.com/features/ssl ; SASL client derivation: https://github.com/brianc/node-postgres/blob/master/packages/pg/lib/crypto/sasl.js
- PostgreSQL SCRAM: https://www.postgresql.org/docs/17/sasl-authentication.html ; `scram_iterations`: https://www.postgresql.org/docs/17/runtime-config-connection.html ; source: https://github.com/postgres/postgres/blob/master/src/common/scram-common.c and https://github.com/postgres/postgres/blob/master/src/include/common/scram-common.h
- PgBouncer auth file format and SCRAM constraints: https://www.pgbouncer.org/config.html
- OpenSSH `ssh_config` (BatchMode, StrictHostKeyChecking accept-new, ConnectTimeout, ServerAlive*, ControlMaster/Persist): https://man.openbsd.org/ssh_config.5
- ssh2 README (hostVerifier, agent, exec): https://github.com/mscdex/ssh2/blob/master/README.md
- node-shlex README: https://github.com/rgov/node-shlex/blob/master/README.md
- Vitest — globalSetup + provide/inject typing: https://vitest.dev/config/globalsetup ; projects: https://vitest.dev/guide/projects and https://vitest.dev/config/projects ; v5 migration: https://vitest.dev/guide/migration
- MSW Node integration: https://mswjs.io/docs/integrations/node ; `server.listen({ onUnhandledFrame })`: https://mswjs.io/docs/api/setup-server/listen ; v3.0.0 release notes: https://github.com/mswjs/msw/releases
- undici MockAgent: https://undici.nodejs.org/#/docs/api/MockAgent
- Docker Compose `up --wait`: https://docs.docker.com/reference/cli/docker/compose/up/ ; `down -v`: https://docs.docker.com/reference/cli/docker/compose/down/
- GitHub ubuntu-24.04 runner image (Docker 28.0.4, Compose 2.38.2, Node 22/24 cached): https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md
- Biome getting started / commands: https://biomejs.dev/guides/getting-started/ ; configuration (`rules.preset`, `files.includes`, `vcs.useIgnoreFile`): https://biomejs.dev/reference/configuration/ ; configure guide: https://biomejs.dev/guides/configure-biome/
- tsdown (successor to tsup; `bin`/shebang detection; engines): https://tsdown.dev/guide/getting-started , https://tsdown.dev/guide/faq , https://tsdown.dev/reference/cli ; tsup maintenance status: https://github.com/egoist/tsup/issues/1391
- npm package.json (`bin` shebang, `files`, `.npmignore` ignored when `files` present, `engines`, `publishConfig`, `repository`): https://docs.npmjs.com/cli/v11/configuring-npm/package-json
- npx binary resolution (`single bin`, `--package`): https://docs.npmjs.com/cli/v11/commands/npx
- npm provenance (`--provenance`, npm >= 9.5.0, `id-token: write`): https://docs.npmjs.com/generating-provenance-statements ; trusted publishers (OIDC, npm >= 11.5.1, example workflow with checkout@v6/setup-node@v6): https://docs.npmjs.com/trusted-publishers ; GA announcement: https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/ ; gotchas: https://philna.sh/blog/2026/01/28/trusted-publishing-npm/
- release-please-action README (outputs, permissions, npm publish chaining, token note): https://github.com/googleapis/release-please-action/blob/main/README.md ; releases (v5.0.0 2026-04-22): https://github.com/googleapis/release-please-action/releases
- actions/setup-node README (`node-version-file`, `cache: npm`, `registry-url`, v6 notes): https://github.com/actions/setup-node/blob/main/README.md
- MIT license text: https://opensource.org/license/mit
