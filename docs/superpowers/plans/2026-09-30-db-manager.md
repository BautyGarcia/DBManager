# db-manager (`dbm`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `dbm` CLI (npm `db-manager`) that turns one Dokploy-managed VPS into a personal Supabase replacement: per-project Postgres behind a shared TLS PgBouncer, per-project Garage S3 buckets, nightly off-site backups, and env vars that drop into a Next.js app on Vercel.

**Architecture:** A TypeScript CLI with three layers. `core/` is pure functions (naming, secrets, SCRAM, renderers for PgBouncer/Garage/compose/Traefik/hardening, zod schemas). `adapters/` wrap the four external systems behind interfaces: Dokploy REST (fetch), SSH (system `ssh` via execa), Postgres admin (`docker exec psql` over SSH), Garage admin v2 (`curl -K -` on the VPS over SSH), plus a file-backed state store. `commands/` orchestrate adapters with rollback. Integration tests run the real commands against `docker compose` (Postgres 18, PgBouncer 1.26, Garage 2.4.1) through a local runner that executes the same argv without SSH.

**Tech Stack:** Node >= 22.12, TypeScript 7.0.2 (`tsc`, `erasableSyntaxOnly`), commander 15, zod 4, execa 10, pg 8.23, shlex, picocolors, Biome 2.5, Vitest 5 (+ vite 8), MSW 3. Infra images pinned: `postgres:18`, `edoburu/pgbouncer:v1.26.0-p0`, `dxflrs/garage:v2.4.1`, `ldez/traefik-certs-dumper:v2.11.4`, `rclone/rclone:1.71`.

**Spec:** `docs/superpowers/specs/2026-09-30-db-manager-design.md` (revision 2). Research with sources: `docs/superpowers/research/*.md`. Read the spec section named in each task before implementing it.

## Global Constraints

- Node `engines: ">=22.12.0"`; CI matrix Node 22 and 24. Package name `db-manager`, binary `dbm`. `npx db-manager` must work.
- TypeScript 7.0.2 with `module: nodenext`, `strict`, `erasableSyntaxOnly: true`, `verbatimModuleSyntax: true`. **No `enum`, no runtime `namespace`, no constructor parameter properties.** Relative imports inside `src/` and `test/` use `.js` specifiers (`import { x } from './naming.js'`).
- All runtime dependencies pinned exactly (no `^`): `commander@15.0.0`, `execa@10.0.1`, `pg@8.23.1`, `picocolors@1.1.1`, `shlex@3.0.0`, `zod@4.6.5`.
- Lint/format is Biome only (`biome ci .` must pass). No ESLint, no Prettier.
- Secrets, SQL, file contents, and tokens travel on **stdin**, never in remote argv. Remote argv is joined with `shlex.join`.
- Files under `~/.dbm/` are written atomically (temp + rename) with mode 0600; the directory is 0700.
- In `--json` mode stdout carries only the JSON document. Exit codes: 0 ok, 1 user error, 2 remote failure, 3 rollback failed.
- Slug regex `^[a-z][a-z0-9-]{1,30}$`; reserved slugs `dbm, pgbouncer, garage, postgres, admin, template0, template1, session`.
- Dokploy `databasePassword` alphabet is `[A-Za-z0-9]` only; `memoryLimit` is sent as a **byte count string**; `postgres.deploy` is blocking and its response is the pre-deploy row.
- PgBouncer config is rendered **only** from state; never edited by hand. Every change is followed by `docker kill -s HUP dbm-pgbouncer`.
- Connection strings use `sslmode=verify-full`. `sslmode=require` never appears anywhere in this repo.
- Every command that mutates state writes `state.json.bak.<ts>` first.
- Commit after every task with a conventional-commit message (`feat:`, `test:`, `docs:`, `chore:`).

## Review Focus

Inputs the spec implies but no single task obviously covers. Each has a pinned test in the task named.

1. **Slug with hyphens** (`my-app`): database and roles use underscores (`my_app`, `my_app_app`) while the PgBouncer entry and `DATABASE_URL` path use the hyphenated slug (`/my-app`). Wrong mixing yields a connection string that authenticates but hits no database. Pinned in Task 2 and Task 6.
2. **Re-running `create` on a slug already in state** must print the existing status and exit 0 with **zero** adapter calls. Pinned in Task 13.
3. **Dokploy returns 409 (appName conflict) on `postgres.create`**: nothing has been created yet, so rollback must do nothing and the error must name the step `dokploy.create`. Pinned in Task 13.
4. **`destroy` on a paused project** cannot take a final backup (container stopped). It must warn and continue, not fail. Pinned in Task 16.
5. **Zero projects in state** must still render a valid `pgbouncer.ini` with an empty `[databases]` section and an empty userlist (init's smoke test runs before any project exists). Pinned in Task 5.

---

## Phase A — Scaffold

### Task 1: Project scaffold, toolchain, CI

**Spec:** 5.6, 16. **Research:** `cli-tooling.md` (every file below was exercised with these versions).

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `biome.json`, `vitest.config.ts`, `.nvmrc`, `bin/dbm.js`, `LICENSE`, `src/version.ts`, `src/core/exit.ts`, `src/cli.ts` (minimal), `test/unit/exit.test.ts`, `.github/workflows/ci.yml`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `ExitCode` (`{ Ok: 0, UserError: 1, RemoteFailure: 2, RollbackFailed: 3 } as const`), `DbmError(message, exitCode, step?)`, `run(argv, io): Promise<number>`, `Io { out(s), err(s) }`.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "db-manager",
  "version": "0.1.0",
  "description": "Self-hosted per-project Postgres + S3 on one VPS, managed from the CLI (dbm).",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=22.12.0" },
  "bin": { "dbm": "./bin/dbm.js" },
  "exports": { ".": "./dist/cli.js", "./package.json": "./package.json" },
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
    "@aws-sdk/client-s3": "3.1144.0",
    "@aws-sdk/s3-request-presigner": "3.1144.0",
    "@biomejs/biome": "2.5.15",
    "@types/node": "22.20.4",
    "@types/pg": "8.23.1",
    "drizzle-kit": "0.31.11",
    "drizzle-orm": "0.45.3",
    "msw": "3.0.1",
    "postgres": "3.4.9",
    "tsx": "4.23.15",
    "typescript": "7.0.2",
    "vite": "8.3.1",
    "vitest": "5.0.3"
  },
  "publishConfig": { "access": "public" }
}
```

- [ ] **Step 2: Write tsconfig.json and tsconfig.build.json**

`tsconfig.json`:
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
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true,
    "rootDir": ".",
    "outDir": "dist",
    "noEmit": true
  },
  "include": ["src", "test", "vitest.config.ts", "scripts/*.ts"]
}
```

`tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

- [ ] **Step 3: Write biome.json, vitest.config.ts, .nvmrc**

`biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.15/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!dist", "!node_modules", "!coverage", "!templates/nextjs", "!test/fixtures"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "always", "trailingCommas": "all" } },
  "linter": { "enabled": true, "rules": { "preset": "recommended" } },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts', 'test/adapters/**/*.test.ts', 'test/commands/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
```

`.nvmrc`: `22`

- [ ] **Step 4: Write bin/dbm.js, src/version.ts, src/core/exit.ts**

`bin/dbm.js` (run `chmod +x bin/dbm.js`):
```js
#!/usr/bin/env node
import { run } from '../dist/cli.js';

process.exitCode = await run(process.argv.slice(2));
```

`src/version.ts`:
```ts
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
```

`src/core/exit.ts`:
```ts
export const ExitCode = {
  Ok: 0,
  UserError: 1,
  RemoteFailure: 2,
  RollbackFailed: 3,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export class DbmError extends Error {
  readonly exitCode: ExitCode;
  readonly step: string | undefined;
  constructor(message: string, exitCode: ExitCode, step?: string) {
    super(message);
    this.name = 'DbmError';
    this.exitCode = exitCode;
    this.step = step;
  }
}

export function userError(message: string, step?: string): DbmError {
  return new DbmError(message, ExitCode.UserError, step);
}

export function remoteError(message: string, step: string): DbmError {
  return new DbmError(message, ExitCode.RemoteFailure, step);
}
```

- [ ] **Step 5: Write the failing test for run()/exit mapping**

`test/unit/exit.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { run } from '../../src/cli.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (s: string) => {
        out.push(s);
      },
      err: (s: string) => {
        err.push(s);
      },
    },
    out,
    err,
  };
}

describe('cli run()', () => {
  it('--version exits 0 and prints the version', async () => {
    const c = capture();
    expect(await run(['--version'], c.io)).toBe(0);
    expect(c.out.join('')).toMatch(/^\d+\.\d+\.\d+/);
  });
  it('unknown command exits 1', async () => {
    const c = capture();
    expect(await run(['nope'], c.io)).toBe(1);
  });
});
```

- [ ] **Step 6: Write the minimal src/cli.ts**

```ts
import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import { DbmError, ExitCode } from './core/exit.js';
import { VERSION } from './version.js';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

export const stdIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export function buildProgram(io: Io): Command {
  const program = new Command('dbm')
    .version(VERSION)
    .description('Personal database platform on one VPS')
    .option('--json', 'machine-readable output', false)
    .option('--yes', 'skip confirmations', false)
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: io.out, writeErr: io.err });
  return program;
}

export async function run(argv: string[], io: Io = stdIo): Promise<number> {
  const program = buildProgram(io);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return ExitCode.Ok;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? ExitCode.Ok : ExitCode.UserError;
    if (e instanceof DbmError) {
      io.err(`${pc.red('error')}${e.step ? ` [${e.step}]` : ''}: ${e.message}\n`);
      return e.exitCode;
    }
    io.err(`unexpected: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    return ExitCode.RemoteFailure;
  }
}
```

- [ ] **Step 7: Install, run the test, expect it to pass; lint and typecheck**

Run: `npm install && npm run test:unit && npm run typecheck && npm run lint`
Expected: 2 tests pass; typecheck clean; biome clean (run `npm run lint:fix` once first to format).

- [ ] **Step 8: Add LICENSE, .gitignore entries, CI workflow**

`LICENSE`: MIT text with `Copyright (c) 2026 <owner name>` (copy verbatim from `research/cli-tooling.md`, "LICENSE" block; replace the holder).

Append to `.gitignore`:
```
coverage/
.vitest/
*.tgz
```

`.github/workflows/ci.yml`:
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
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
  unit:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: { node: [22, 24] }
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with: { node-version: '${{ matrix.node }}', cache: npm }
      - run: npm ci
      - run: npm run test:unit
      - run: npm run build
      - run: |
          npm pack --silent
          npx --yes ./db-manager-*.tgz --version
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with: { node-version-file: .nvmrc, cache: npm }
      - run: docker compose version
      - run: npm ci
      - run: npm run test:integration
      - if: failure()
        run: docker compose -f test/compose/compose.yaml logs --no-color || true
```

- [ ] **Step 9: Build and smoke the binary, then commit**

Run: `npm run build && node bin/dbm.js --version`
Expected: prints `0.1.0`.

```bash
git add -A
git commit -m "chore: scaffold db-manager CLI with TS7, Biome, Vitest 5, CI"
```

---

## Phase B — Core (pure functions)

### Task 2: Slug validation and derived names

**Spec:** 6. **Review Focus 1.**

**Files:**
- Create: `src/core/naming.ts`, `test/unit/naming.test.ts`

**Interfaces:**
- Produces: `validateSlug(slug: string): string` (throws `DbmError` exit 1), `deriveNames(slug): DerivedNames`, `webHost(slug, webDomain): string`, `RESERVED_SLUGS`.

```ts
export interface DerivedNames {
  slug: string;              // 'my-app'
  slugDb: string;            // 'my_app'
  database: string;          // 'my_app'
  appRole: string;           // 'my_app_app'
  adminRole: string;         // 'my_app_admin'
  serviceName: string;       // 'pg-my-app'  (Dokploy `name` and requested `appName`)
  pgbouncerDb: string;       // 'my-app'
  pgbouncerSessionDb: string;// 'my-app_session'
  bucket: string;            // 'my-app'
  keyName: string;           // 'my-app-key'
  backupPrefix: string;      // 'db/my-app'
  storagePrefix: string;     // 'storage/my-app'
  traefikWebFile: string;    // 'dbm-web-my-app.yml'
}
```

- [ ] **Step 1: Write the failing tests**

`test/unit/naming.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DbmError } from '../../src/core/exit.js';
import { deriveNames, validateSlug, webHost } from '../../src/core/naming.js';

describe('validateSlug', () => {
  it('accepts lowercase letters, digits, hyphens, 2-31 chars', () => {
    expect(validateSlug('a1')).toBe('a1');
    expect(validateSlug('my-app-2')).toBe('my-app-2');
    expect(validateSlug(`a${'b'.repeat(30)}`)).toHaveLength(31);
  });
  it.each(['A', '1abc', 'my_app', 'a', `a${'b'.repeat(31)}`, 'my app', 'my.app', ''])(
    'rejects %j',
    (bad) => {
      expect(() => validateSlug(bad)).toThrow(DbmError);
      try {
        validateSlug(bad);
      } catch (e) {
        expect((e as DbmError).exitCode).toBe(1);
      }
    },
  );
  it.each(['dbm', 'pgbouncer', 'garage', 'postgres', 'admin', 'template0', 'template1', 'session'])(
    'rejects reserved %s',
    (r) => {
      expect(() => validateSlug(r)).toThrow(/reserved/);
    },
  );
});

describe('deriveNames', () => {
  it('keeps hyphens for PgBouncer/bucket names and uses underscores for SQL identifiers', () => {
    const n = deriveNames('my-app');
    expect(n).toEqual({
      slug: 'my-app',
      slugDb: 'my_app',
      database: 'my_app',
      appRole: 'my_app_app',
      adminRole: 'my_app_admin',
      serviceName: 'pg-my-app',
      pgbouncerDb: 'my-app',
      pgbouncerSessionDb: 'my-app_session',
      bucket: 'my-app',
      keyName: 'my-app-key',
      backupPrefix: 'db/my-app',
      storagePrefix: 'storage/my-app',
      traefikWebFile: 'dbm-web-my-app.yml',
    });
  });
  it('builds the public web host', () => {
    expect(webHost('my-app', 'web.example.com')).toBe('my-app.web.example.com');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/unit/naming.test.ts`
Expected: FAIL, cannot find module `naming.js`.

- [ ] **Step 3: Implement**

`src/core/naming.ts`:
```ts
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
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run --project unit test/unit/naming.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/naming.ts test/unit/naming.test.ts
git commit -m "feat(core): slug validation and derived names"
```

### Task 3: Secrets, SCRAM-SHA-256 verifier, memory units

**Spec:** 5.2, 5.3, 5.6. **Research:** `cli-tooling.md` §"Code patterns" 2 and 6 (verifier verified against Postgres 17 `pg_authid`).

**Files:**
- Create: `src/core/secrets.ts`, `src/core/scram.ts`, `src/core/units.ts`, `test/unit/secrets.test.ts`, `test/unit/scram.test.ts`, `test/unit/units.test.ts`

**Interfaces:**
- Produces: `randomSecret(bytes = 32): string` (base64url), `dokployPassword(length = 32): string` (`[A-Za-z0-9]`), `scramSha256Verifier(password, opts?: { salt?: Buffer; iterations?: number }): string`, `isScramVerifier(s): boolean`, `parseMemory(input): number` (bytes), `formatBytes(n): string`.

- [ ] **Step 1: Write the failing tests**

`test/unit/secrets.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { dokployPassword, randomSecret } from '../../src/core/secrets.js';

describe('secrets', () => {
  it('randomSecret is base64url of 32 bytes by default', () => {
    const s = randomSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomSecret(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
  it('dokployPassword uses only [A-Za-z0-9] and the requested length', () => {
    for (let i = 0; i < 50; i++) expect(dokployPassword()).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(dokployPassword(12)).toHaveLength(12);
  });
  it('is not constant', () => {
    expect(randomSecret()).not.toBe(randomSecret());
  });
});
```

`test/unit/scram.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isScramVerifier, scramSha256Verifier } from '../../src/core/scram.js';

describe('scramSha256Verifier', () => {
  it('matches the known-answer vector (computed with node:crypto, format verified against PG17 pg_authid)', () => {
    const salt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    expect(scramSha256Verifier('correct horse battery staple', { salt })).toBe(
      'SCRAM-SHA-256$4096:ASNFZ4mrze8BI0VniavN7w==$QBFKFII7AUqdBBhgLEMpXlELyov2F0DDsChPQZct0aM=:Fb2c1Vznjh3q0/vyrHtpquSYm3x5Si1AJeeYgN455Tc=',
    );
  });
  it('uses a random 16-byte salt and 4096 iterations by default', () => {
    const v = scramSha256Verifier('x');
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    expect(scramSha256Verifier('x')).not.toBe(v);
  });
  it('isScramVerifier', () => {
    expect(isScramVerifier(scramSha256Verifier('x'))).toBe(true);
    expect(isScramVerifier('md5abc')).toBe(false);
  });
});
```

`test/unit/units.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DbmError } from '../../src/core/exit.js';
import { formatBytes, parseMemory } from '../../src/core/units.js';

describe('parseMemory', () => {
  it.each([
    ['512m', 536870912],
    ['512M', 536870912],
    ['512mb', 536870912],
    ['1g', 1073741824],
    ['1.5g', 1610612736],
    ['536870912', 536870912],
    ['2048k', 2097152],
  ])('%s -> %d', (input, bytes) => {
    expect(parseMemory(input)).toBe(bytes);
  });
  it.each(['', 'abc', '-1m', '0', '10t'])('rejects %j', (bad) => {
    expect(() => parseMemory(bad)).toThrow(DbmError);
  });
  it('rejects below 128m', () => {
    expect(() => parseMemory('64m')).toThrow(/at least 128m/);
  });
});

describe('formatBytes', () => {
  it('formats', () => {
    expect(formatBytes(536870912)).toBe('512.0 MiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(12)).toBe('12 B');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/unit/secrets.test.ts test/unit/scram.test.ts test/unit/units.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/core/secrets.ts`:
```ts
import { randomBytes, randomInt } from 'node:crypto';

/** 32 bytes -> 43-char base64url. Alphabet [A-Za-z0-9_-]: safe in URLs, shells, SQL literals. */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const DOKPLOY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Dokploy's databasePassword regex forbids $ ! ' " \ / and space; alphanumerics are always accepted. */
export function dokployPassword(length = 32): string {
  let out = '';
  for (let i = 0; i < length; i++) out += DOKPLOY_ALPHABET[randomInt(DOKPLOY_ALPHABET.length)];
  return out;
}
```

`src/core/scram.ts`:
```ts
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

export interface ScramOptions {
  salt?: Buffer;
  iterations?: number;
}

/**
 * PostgreSQL SCRAM-SHA-256 secret, the exact format of pg_authid.rolpassword and PgBouncer userlist.txt:
 * SCRAM-SHA-256$<iterations>:<salt b64>$<StoredKey b64>:<ServerKey b64>
 * Passwords must be SASLprep-neutral; dbm passwords are ASCII so SASLprep is a no-op.
 */
export function scramSha256Verifier(password: string, opts: ScramOptions = {}): string {
  const salt = opts.salt ?? randomBytes(16);
  const iterations = opts.iterations ?? 4096;
  const saltedPassword = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export function isScramVerifier(s: string): boolean {
  return /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(s);
}
```

`src/core/units.ts`:
```ts
import { userError } from './exit.js';

const UNITS: Record<string, number> = { '': 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3 };
export const MIN_MEMORY_BYTES = 128 * 1024 ** 2;

/** '512m' | '1.5g' | '536870912' -> bytes. Minimum 128m. */
export function parseMemory(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(input.trim());
  if (!m) throw userError(`invalid memory size ${JSON.stringify(input)} (use e.g. 512m, 1g)`, 'memory');
  const unit = (m[2] ?? '').toLowerCase();
  const mult = UNITS[unit];
  if (mult === undefined) throw userError(`unknown memory unit ${JSON.stringify(m[2])}`, 'memory');
  const bytes = Math.round(Number(m[1]) * mult);
  if (bytes < MIN_MEMORY_BYTES) throw userError(`memory must be at least 128m, got ${input}`, 'memory');
  return bytes;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run --project unit test/unit/secrets.test.ts test/unit/scram.test.ts test/unit/units.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/secrets.ts src/core/scram.ts src/core/units.ts test/unit/secrets.test.ts test/unit/scram.test.ts test/unit/units.test.ts
git commit -m "feat(core): secrets, SCRAM-SHA-256 verifier, memory units"
```

### Task 4: State and config schemas, file store

**Spec:** 5.6 (local files), 8. **Research:** `cli-tooling.md` §"Code patterns" 3 and 4.

**Files:**
- Create: `src/core/state.ts`, `src/core/config.ts`, `src/adapters/store.ts`, `test/unit/state.test.ts`, `test/adapters/store.test.ts`

**Interfaces:**
- Produces:
  - `Project`, `State`, `ProjectSchema`, `StateV1Schema`, `emptyState()`, `parseState(raw): State`, `upsertProject(state, p): State`, `removeProject(state, slug): State`, `listProjects(state): Project[]`, `getProject(state, slug): Project` (throws user error if missing).
  - `Config`, `ConfigInput`, `ConfigSchema` with `remote` defaults.
  - `StateStore` interface, `InitProgress { done: Record<string, boolean>; values: Record<string, string> }`, and `makeFileStore(dir?)`.

- [ ] **Step 1: Write the failing tests**

`test/unit/state.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/core/config.js';
import {
  emptyState,
  getProject,
  listProjects,
  parseState,
  type Project,
  removeProject,
  upsertProject,
} from '../../src/core/state.js';

export function fakeProject(slug = 'my-app', over: Partial<Project> = {}): Project {
  return {
    slug,
    createdAt: '2026-09-30T00:00:00.000Z',
    status: 'running',
    pgMajor: 18,
    dokploy: { postgresId: 'pg_1', appName: `pg-${slug}-abc123`, backupId: 'bk_1' },
    postgres: {
      database: slug.replaceAll('-', '_'),
      appRole: `${slug.replaceAll('-', '_')}_app`,
      appPassword: 'apppw',
      appScramVerifier: 'SCRAM-SHA-256$4096:c2FsdA==$a2V5:a2V5',
      adminRole: `${slug.replaceAll('-', '_')}_admin`,
      adminPassword: 'adminpw',
      extensions: ['pgcrypto', 'uuid-ossp'],
      memoryBytes: 536870912,
    },
    storage: {
      bucketId: 'b1',
      bucket: slug,
      keyId: 'GK1',
      keySecret: 'sec',
      corsOrigins: ['*'],
      aliases: [],
    },
    betterAuthSecret: 'bas',
    ...over,
  };
}

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
```

`test/adapters/store.test.ts`:
```ts
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFileStore } from '../../src/adapters/store.js';
import { emptyState, upsertProject } from '../../src/core/state.js';
import { fakeProject } from '../unit/state.test.js';

describe('file store', () => {
  it('round-trips state with 0600/0700 permissions and keeps 10 backups', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dbm-store-'));
    const store = makeFileStore(join(dir, '.dbm'));
    expect(await store.loadState()).toEqual(emptyState());
    let s = emptyState();
    for (let i = 0; i < 12; i++) {
      s = upsertProject(s, fakeProject(`p${i}`));
      await store.saveState(s);
    }
    expect(Object.keys((await store.loadState()).projects)).toHaveLength(12);
    const files = await readdir(join(dir, '.dbm'));
    expect(files.filter((f) => f.startsWith('state.json.bak.'))).toHaveLength(10);
    expect((await stat(join(dir, '.dbm'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, '.dbm', 'state.json'))).mode & 0o777).toBe(0o600);
  });
  it('config is undefined until saved, then parsed with defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dbm-store-'));
    const store = makeFileStore(join(dir, '.dbm'));
    expect(await store.loadConfig()).toBeUndefined();
    const cfg = await store.saveConfig({
      sshHost: 'h',
      dokployUrl: 'https://x.ts.net',
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
    expect((await store.loadConfig())?.remote.dbPort).toBe(6432);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/unit/state.test.ts test/adapters/store.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/core/state.ts`:
```ts
import { z } from 'zod';
import { userError } from './exit.js';

export const ProjectStatusSchema = z.enum(['provisioning', 'running', 'paused']);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ProjectSchema = z.object({
  slug: z.string(),
  createdAt: z.string(),
  status: ProjectStatusSchema,
  pgMajor: z.union([z.literal(17), z.literal(18)]),
  dokploy: z.object({
    postgresId: z.string(),
    appName: z.string(),
    backupId: z.string().optional(),
  }),
  postgres: z.object({
    database: z.string(),
    appRole: z.string(),
    appPassword: z.string(),
    appScramVerifier: z.string(),
    adminRole: z.string(),
    adminPassword: z.string(),
    extensions: z.array(z.string()),
    memoryBytes: z.number().int().positive(),
  }),
  storage: z
    .object({
      bucketId: z.string(),
      bucket: z.string(),
      keyId: z.string(),
      keySecret: z.string(),
      corsOrigins: z.array(z.string()),
      publicBaseUrl: z.string().optional(),
      aliases: z.array(z.string()),
    })
    .optional(),
  betterAuthSecret: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const StateV1Schema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), ProjectSchema),
});
export type State = z.infer<typeof StateV1Schema>;
export const CURRENT_STATE_VERSION = 1;

const AnyStateSchema = z.discriminatedUnion('version', [StateV1Schema]);
// Future: add StateV2Schema above and `1: (s) => ({ ...s, version: 2 })` here.
const migrations: Record<number, (s: unknown) => unknown> = {};

export function emptyState(): State {
  return { version: 1, projects: {} };
}

export function parseState(raw: unknown): State {
  let s: unknown = AnyStateSchema.parse(raw);
  while ((s as { version: number }).version < CURRENT_STATE_VERSION) {
    const v = (s as { version: number }).version;
    const m = migrations[v];
    if (!m) throw new Error(`no migration from state version ${v}`);
    s = m(s);
  }
  return StateV1Schema.parse(s);
}

export function upsertProject(state: State, project: Project): State {
  return { ...state, projects: { ...state.projects, [project.slug]: project } };
}

export function removeProject(state: State, slug: string): State {
  const { [slug]: _removed, ...rest } = state.projects;
  return { ...state, projects: rest };
}

export function listProjects(state: State): Project[] {
  return Object.values(state.projects).sort((a, b) => a.slug.localeCompare(b.slug));
}

export function getProject(state: State, slug: string): Project {
  const p = state.projects[slug];
  if (!p) throw userError(`project ${JSON.stringify(slug)} not found in state (run \`dbm list\`)`, 'state');
  return p;
}
```

`src/core/config.ts`:
```ts
import { z } from 'zod';

export const RemotePathsSchema = z.object({
  pgbouncerConfDir: z.string().default('/etc/dokploy/dbm/pgbouncer'),
  certsDir: z.string().default('/etc/dokploy/dbm/certs'),
  garageConfDir: z.string().default('/etc/dokploy/dbm/garage'),
  rcloneConfDir: z.string().default('/etc/dokploy/dbm/rclone'),
  traefikDynamicDir: z.string().default('/etc/dokploy/traefik/dynamic'),
  dockerNetwork: z.string().default('dokploy-network'),
  pgbouncerContainer: z.string().default('dbm-pgbouncer'),
  garageContainer: z.string().default('dbm-garage'),
  garageAdminPort: z.number().int().default(3903),
  dbPort: z.number().int().default(6432),
});

export const ConfigSchema = z.object({
  sshHost: z.string(),
  sshUser: z.string().default('root'),
  dokployUrl: z.url(),
  dokployApiKey: z.string(),
  dokployProjectId: z.string(),
  dokployEnvironmentId: z.string(),
  domain: z.string(),
  dbHost: z.string(),
  s3Host: z.string(),
  webDomain: z.string(),
  garageAdminToken: z.string(),
  garageBackupKeyId: z.string(),
  dumpsDestinationId: z.string(),
  tls: z.enum(['letsencrypt', 'self-ca']).default('letsencrypt'),
  sslCaPem: z.string().optional(),
  remote: RemotePathsSchema.prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
```

`src/adapters/store.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Config, type ConfigInput, ConfigSchema } from '../core/config.js';
import { userError } from '../core/exit.js';
import { type State, emptyState, parseState } from '../core/state.js';

export interface InitProgress {
  done: Record<string, boolean>;
  values: Record<string, string>;
}

export interface StateStore {
  readonly dir: string;
  loadConfig(): Promise<Config | undefined>;
  saveConfig(cfg: ConfigInput): Promise<Config>;
  requireConfig(): Promise<Config>;
  loadState(): Promise<State>;
  saveState(state: State): Promise<void>;
  loadInitProgress(): Promise<InitProgress>;
  saveInitProgress(p: InitProgress): Promise<void>;
}

const KEEP_BACKUPS = 10;

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(tmp, file);
  await chmod(file, 0o600);
}

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export function makeFileStore(dir = join(homedir(), '.dbm')): StateStore {
  const configFile = join(dir, 'config.json');
  const stateFile = join(dir, 'state.json');
  const progressFile = join(dir, 'init-progress.json');

  async function backupState(): Promise<void> {
    const current = await readJson(stateFile);
    if (current === undefined) return;
    const ts = new Date().toISOString().replaceAll(':', '-');
    await writeJsonAtomic(join(dir, `state.json.bak.${ts}`), current);
    const backups = (await readdir(dir)).filter((f) => f.startsWith('state.json.bak.')).sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
      await unlink(join(dir, old));
    }
  }

  return {
    dir,
    async loadConfig() {
      const raw = await readJson(configFile);
      return raw === undefined ? undefined : ConfigSchema.parse(raw);
    },
    async saveConfig(cfg) {
      const parsed = ConfigSchema.parse(cfg);
      await writeJsonAtomic(configFile, parsed);
      return parsed;
    },
    async requireConfig() {
      const cfg = await this.loadConfig();
      if (!cfg) throw userError(`no config at ${configFile}; run \`dbm init <host> --domain <domain>\` first`, 'config');
      return cfg;
    },
    async loadState() {
      const raw = await readJson(stateFile);
      return raw === undefined ? emptyState() : parseState(raw);
    },
    async saveState(state) {
      await backupState();
      await writeJsonAtomic(stateFile, state);
    },
    async loadInitProgress() {
      const raw = (await readJson(progressFile)) as Partial<InitProgress> | undefined;
      return { done: raw?.done ?? {}, values: raw?.values ?? {} };
    },
    async saveInitProgress(p) {
      await writeJsonAtomic(progressFile, p);
    },
  };
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run --project unit test/unit/state.test.ts test/adapters/store.test.ts`
Expected: PASS. (If `prefault` is not recognised, confirm zod is 4.6.5: `npm ls zod`.)

- [ ] **Step 5: Commit**

```bash
git add src/core/state.ts src/core/config.ts src/adapters/store.ts test/unit/state.test.ts test/adapters/store.test.ts
git commit -m "feat(core): versioned state/config schemas and atomic file store"
```

### Task 5: PgBouncer config rendering

**Spec:** 5.3. **Review Focus 5.**

**Files:**
- Create: `src/core/pgbouncer.ts`, `test/unit/pgbouncer.test.ts`

**Interfaces:**
- Produces: `renderPgbouncerIni(projects: Project[], opts: { certDir: string }): string`, `renderUserlist(projects: Project[]): string`, `PGBOUNCER_INI_PATH = '/etc/pgbouncer/pgbouncer.ini'`, `PGBOUNCER_USERLIST_PATH = '/etc/pgbouncer/userlist.txt'`.

- [ ] **Step 1: Write the failing tests**

`test/unit/pgbouncer.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { renderPgbouncerIni, renderUserlist } from '../../src/core/pgbouncer.js';
import { fakeProject } from './state.test.js';

const opts = { certDir: '/certs/db.example.com' };

describe('renderPgbouncerIni', () => {
  it('renders a valid file with zero projects', () => {
    const ini = renderPgbouncerIni([], opts);
    expect(ini).toMatch(/^\[databases\]\n\n\[pgbouncer\]\n/m);
    expect(ini).toContain('pool_mode = transaction');
    expect(ini).toContain('max_prepared_statements = 200');
    expect(ini).toContain('auth_type = scram-sha-256');
    expect(ini).toContain('client_tls_sslmode = require');
    expect(ini).toContain('client_tls_cert_file = /certs/db.example.com/certificate.crt');
    expect(ini).toContain('client_tls_key_file = /certs/db.example.com/privatekey.key');
    expect(ini).toContain('server_tls_sslmode = disable');
    expect(ini).toContain('default_pool_size = 10');
    expect(ini).toContain('max_client_conn = 1000');
    expect(ini).not.toContain('user=');
    expect(ini).not.toContain('sslmode=require');
  });
  it('renders one transaction and one session entry per project, sorted, hyphens kept', () => {
    const ini = renderPgbouncerIni([fakeProject('zeta'), fakeProject('my-app')], opts);
    const dbSection = ini.split('[pgbouncer]')[0] ?? '';
    expect(dbSection).toBe(
      [
        '[databases]',
        'my-app = host=pg-my-app-abc123 port=5432 dbname=my_app',
        'my-app_session = host=pg-my-app-abc123 port=5432 dbname=my_app pool_mode=session pool_size=3 reserve_pool_size=0',
        'zeta = host=pg-zeta-abc123 port=5432 dbname=zeta',
        'zeta_session = host=pg-zeta-abc123 port=5432 dbname=zeta pool_mode=session pool_size=3 reserve_pool_size=0',
        '',
        '',
      ].join('\n'),
    );
  });
});

describe('renderUserlist', () => {
  it('renders one SCRAM line per project', () => {
    expect(renderUserlist([])).toBe('');
    expect(renderUserlist([fakeProject('my-app')])).toBe(
      '"my_app_app" "SCRAM-SHA-256$4096:c2FsdA==$a2V5:a2V5"\n',
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/unit/pgbouncer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/core/pgbouncer.ts`:
```ts
import type { Project } from './state.js';

export const PGBOUNCER_INI_PATH = '/etc/pgbouncer/pgbouncer.ini';
export const PGBOUNCER_USERLIST_PATH = '/etc/pgbouncer/userlist.txt';

export interface PgbouncerRenderOptions {
  /** Directory inside the container holding certificate.crt and privatekey.key */
  certDir: string;
}

function sorted(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => a.slug.localeCompare(b.slug));
}

export function renderPgbouncerIni(projects: Project[], opts: PgbouncerRenderOptions): string {
  const dbLines: string[] = [];
  for (const p of sorted(projects)) {
    const base = `host=${p.dokploy.appName} port=5432 dbname=${p.postgres.database}`;
    dbLines.push(`${p.slug} = ${base}`);
    dbLines.push(`${p.slug}_session = ${base} pool_mode=session pool_size=3 reserve_pool_size=0`);
  }
  return [
    '[databases]',
    ...dbLines,
    '',
    '[pgbouncer]',
    'listen_addr = 0.0.0.0',
    'listen_port = 6432',
    'unix_socket_dir =',
    'pool_mode = transaction',
    'max_client_conn = 1000',
    'default_pool_size = 10',
    'min_pool_size = 0',
    'reserve_pool_size = 5',
    'reserve_pool_timeout = 3',
    'server_idle_timeout = 300',
    'server_lifetime = 3600',
    'pool_idle_timeout = 3600',
    'client_idle_timeout = 0',
    'query_wait_timeout = 30',
    'client_login_timeout = 15',
    'max_prepared_statements = 200',
    'ignore_startup_parameters = extra_float_digits',
    'auth_type = scram-sha-256',
    `auth_file = ${PGBOUNCER_USERLIST_PATH}`,
    'client_tls_sslmode = require',
    `client_tls_cert_file = ${opts.certDir}/certificate.crt`,
    `client_tls_key_file = ${opts.certDir}/privatekey.key`,
    'client_tls_protocols = tlsv1.2,tlsv1.3',
    'server_tls_sslmode = disable',
    'so_reuseport = 1',
    'tcp_keepalive = 1',
    'log_connections = 1',
    'log_disconnections = 1',
    'log_pooler_errors = 1',
    'stats_period = 60',
    '',
  ].join('\n');
}

export function renderUserlist(projects: Project[]): string {
  return sorted(projects)
    .map((p) => `"${p.postgres.appRole}" "${p.postgres.appScramVerifier}"\n`)
    .join('');
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run --project unit test/unit/pgbouncer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/pgbouncer.ts test/unit/pgbouncer.test.ts
git commit -m "feat(core): render pgbouncer.ini and userlist from state"
```

### Task 6: SQL builders, env rendering, backup cron

**Spec:** 5.2, 7 (`create` output), 5.5. **Review Focus 1.**

**Files:**
- Create: `src/core/sql.ts`, `src/core/env.ts`, `src/core/cron.ts`, `test/unit/sql.test.ts`, `test/unit/env.test.ts`, `test/unit/cron.test.ts`

**Interfaces:**
- Produces: `quoteIdent`, `quoteLiteral`, `createRoleSql(appRole, verifier)`, `createDatabaseSql(database, owner)`, `extensionsSql(exts)`, `validateExtensions(exts)`, `tuningSql(memoryBytes)`, `projectEnv(project, cfg): Record<string,string>`, `formatEnvBlock(env): string`, `backupCron(slug): string`, `STORAGE_SYNC_CRON`, `PGBOUNCER_RELOAD_CRON`.

- [ ] **Step 1: Write the failing tests**

`test/unit/sql.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  createDatabaseSql,
  createRoleSql,
  extensionsSql,
  quoteIdent,
  quoteLiteral,
  tuningSql,
  validateExtensions,
} from '../../src/core/sql.js';

describe('sql builders', () => {
  it('quotes identifiers and literals', () => {
    expect(quoteIdent('my_app')).toBe('"my_app"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(quoteLiteral('SCRAM-SHA-256$4096:a$b:c')).toBe("'SCRAM-SHA-256$4096:a$b:c'");
  });
  it('creates a NOSUPERUSER login role with a verifier literal', () => {
    expect(createRoleSql('my_app_app', 'SCRAM-SHA-256$4096:s$k:k')).toBe(
      `CREATE ROLE "my_app_app" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD 'SCRAM-SHA-256$4096:s$k:k';`,
    );
    expect(createDatabaseSql('my_app', 'my_app_app')).toBe('CREATE DATABASE "my_app" OWNER "my_app_app";');
  });
  it('extensions', () => {
    expect(extensionsSql(['pgcrypto', 'uuid-ossp'])).toBe(
      'CREATE EXTENSION IF NOT EXISTS "pgcrypto";\nCREATE EXTENSION IF NOT EXISTS "uuid-ossp";\n',
    );
    expect(() => validateExtensions(['pg;drop'])).toThrow(/extension/);
  });
  it('tuning scales with memory', () => {
    const sql = tuningSql(536870912);
    expect(sql).toContain("ALTER SYSTEM SET shared_buffers = '128MB';");
    expect(sql).toContain("ALTER SYSTEM SET effective_cache_size = '384MB';");
    expect(sql).toContain("ALTER SYSTEM SET max_connections = '50';");
    expect(sql).toContain("ALTER SYSTEM SET work_mem = '4MB';");
    expect(sql).toContain("ALTER SYSTEM SET random_page_cost = '1.1';");
    expect(sql).toContain("ALTER SYSTEM SET huge_pages = 'off';");
    expect(tuningSql(2 * 1024 ** 3)).toContain("shared_buffers = '512MB'");
  });
});
```

`test/unit/env.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/core/config.js';
import { formatEnvBlock, projectEnv } from '../../src/core/env.js';
import { fakeProject } from './state.test.js';

const cfg = ConfigSchema.parse({
  sshHost: 'h',
  dokployUrl: 'https://x.ts.net',
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

describe('projectEnv', () => {
  it('uses hyphenated slug in the URL path and underscores in the role', () => {
    const env = projectEnv(fakeProject('my-app'), cfg);
    expect(env.DATABASE_URL).toBe(
      'postgresql://my_app_app:apppw@db.example.com:6432/my-app?sslmode=verify-full',
    );
    expect(env.DATABASE_URL_SESSION).toBe(
      'postgresql://my_app_app:apppw@db.example.com:6432/my-app_session?sslmode=verify-full',
    );
    expect(env.S3_ENDPOINT).toBe('https://s3.example.com');
    expect(env.S3_REGION).toBe('garage');
    expect(env.S3_BUCKET).toBe('my-app');
    expect(env.S3_ACCESS_KEY_ID).toBe('GK1');
    expect(env.S3_SECRET_ACCESS_KEY).toBe('sec');
    expect(env.BETTER_AUTH_SECRET).toBe('bas');
    expect(env.BETTER_AUTH_URL).toBe('');
    expect(env.S3_PUBLIC_BASE_URL).toBeUndefined();
    expect(env.DATABASE_SSL_CA).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('adminpw');
  });
  it('omits storage vars for --no-storage projects and adds public/CA vars when present', () => {
    const noStorage = projectEnv(fakeProject('a1', { storage: undefined }), cfg);
    expect(noStorage.S3_BUCKET).toBeUndefined();
    const pub = fakeProject('a1');
    if (pub.storage) pub.storage.publicBaseUrl = 'https://a1.web.example.com';
    const env = projectEnv(pub, { ...cfg, tls: 'self-ca', sslCaPem: '-----BEGIN\nabc\n-----END\n' });
    expect(env.S3_PUBLIC_BASE_URL).toBe('https://a1.web.example.com');
    expect(env.DATABASE_SSL_CA).toBe('-----BEGIN\\nabc\\n-----END\\n');
  });
  it('formatEnvBlock is KEY=value per line, sorted as inserted', () => {
    expect(formatEnvBlock({ B: '2', A: '' })).toBe('B=2\nA=\n');
  });
});
```

`test/unit/cron.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { PGBOUNCER_RELOAD_CRON, STORAGE_SYNC_CRON, backupCron } from '../../src/core/cron.js';

describe('cron', () => {
  it('jitters the minute deterministically within 0-24 at 06:00 UTC', () => {
    const a = backupCron('my-app');
    expect(a).toMatch(/^\d{1,2} 6 \* \* \*$/);
    expect(Number(a.split(' ')[0])).toBeLessThan(25);
    expect(backupCron('my-app')).toBe(a);
    expect(backupCron('other')).not.toBe(a);
  });
  it('fixed schedules', () => {
    expect(STORAGE_SYNC_CRON).toBe('30 6 * * *');
    expect(PGBOUNCER_RELOAD_CRON).toBe('10 4 * * *');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/unit/sql.test.ts test/unit/env.test.ts test/unit/cron.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/core/sql.ts`:
```ts
import { userError } from './exit.js';

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createRoleSql(appRole: string, scramVerifier: string): string {
  return `CREATE ROLE ${quoteIdent(appRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${quoteLiteral(scramVerifier)};`;
}

export function createDatabaseSql(database: string, owner: string): string {
  return `CREATE DATABASE ${quoteIdent(database)} OWNER ${quoteIdent(owner)};`;
}

const EXTENSION_RE = /^[a-z_][a-z0-9_-]*$/;

export function validateExtensions(exts: string[]): string[] {
  for (const e of exts) {
    if (!EXTENSION_RE.test(e)) throw userError(`invalid extension name ${JSON.stringify(e)}`, 'extensions');
  }
  return exts;
}

export function extensionsSql(exts: string[]): string {
  return validateExtensions(exts)
    .map((e) => `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(e)};\n`)
    .join('');
}

/** ALTER SYSTEM tuning for a container with `memoryBytes` limit. shared_buffers needs a restart. */
export function tuningSql(memoryBytes: number): string {
  const mib = 1024 ** 2;
  const sharedBuffers = Math.floor(memoryBytes / 4 / mib);
  const effectiveCache = Math.floor((memoryBytes * 3) / 4 / mib);
  const settings: Array<[string, string]> = [
    ['max_connections', '50'],
    ['shared_buffers', `${sharedBuffers}MB`],
    ['effective_cache_size', `${effectiveCache}MB`],
    ['work_mem', '4MB'],
    ['maintenance_work_mem', '64MB'],
    ['random_page_cost', '1.1'],
    ['huge_pages', 'off'],
  ];
  return settings.map(([k, v]) => `ALTER SYSTEM SET ${k} = ${quoteLiteral(v)};\n`).join('');
}
```

`src/core/env.ts`:
```ts
import type { Config } from './config.js';
import type { Project } from './state.js';

function dbUrl(p: Project, cfg: Config, dbname: string): string {
  const user = encodeURIComponent(p.postgres.appRole);
  const pw = encodeURIComponent(p.postgres.appPassword);
  return `postgresql://${user}:${pw}@${cfg.dbHost}:${cfg.remote.dbPort}/${dbname}?sslmode=verify-full`;
}

/** Everything a Next.js project needs. Never includes the superuser password. */
export function projectEnv(p: Project, cfg: Config): Record<string, string> {
  const env: Record<string, string> = {
    DATABASE_URL: dbUrl(p, cfg, p.slug),
    DATABASE_URL_SESSION: dbUrl(p, cfg, `${p.slug}_session`),
  };
  if (p.storage) {
    env.S3_ENDPOINT = `https://${cfg.s3Host}`;
    env.S3_REGION = 'garage';
    env.S3_BUCKET = p.storage.bucket;
    env.S3_ACCESS_KEY_ID = p.storage.keyId;
    env.S3_SECRET_ACCESS_KEY = p.storage.keySecret;
    if (p.storage.publicBaseUrl) env.S3_PUBLIC_BASE_URL = p.storage.publicBaseUrl;
  }
  env.BETTER_AUTH_SECRET = p.betterAuthSecret;
  env.BETTER_AUTH_URL = '';
  if (cfg.tls === 'self-ca' && cfg.sslCaPem) env.DATABASE_SSL_CA = cfg.sslCaPem.replaceAll('\n', '\\n');
  return env;
}

export function formatEnvBlock(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}\n`)
    .join('');
}
```

`src/core/cron.ts`:
```ts
/** Nightly dumps at 06:xx UTC (03:xx in Argentina), minute jittered per slug in 0-24. */
export function backupCron(slug: string): string {
  let h = 0x811c9dc5;
  for (const ch of slug) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h % 25} 6 * * *`;
}

export const STORAGE_SYNC_CRON = '30 6 * * *';
export const PGBOUNCER_RELOAD_CRON = '10 4 * * *';
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run --project unit test/unit/sql.test.ts test/unit/env.test.ts test/unit/cron.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/sql.ts src/core/env.ts src/core/cron.ts test/unit/sql.test.ts test/unit/env.test.ts test/unit/cron.test.ts
git commit -m "feat(core): SQL builders, project env rendering, backup cron jitter"
```

### Task 7: Garage, compose, Traefik, rclone and host-cron renderers

**Spec:** 5.3, 5.4, 5.5, 6. **Research:** `garage-s3.md` §"Recommended garage.toml", `pgbouncer-postgres-tls.md` §TLS delivery, `dokploy.md` (Traefik file provider, acme.json path).

Deviation recorded here: the storage mirror runs as a **host cron** invoking `docker run --rm rclone/rclone:1` rather than a long-running compose service. Same behaviour, one less container. The certificate directory is a **host bind mount** (`/etc/dokploy/dbm/certs`) shared by the dumper and PgBouncer; the daily host cron `chown`s it to uid 70 before the SIGHUP, so no post-hook shell is needed inside the dumper image.

**Files:**
- Create: `src/core/garage-config.ts`, `src/core/compose.ts`, `src/core/traefik.ts`, `src/core/host-files.ts`, `test/unit/renderers.test.ts`

**Interfaces:**
- Produces:
  - `renderGarageToml({ webDomain }): string`
  - `renderGarageCompose({ network, garageConfDir, adminPort }): string`
  - `renderPgbouncerCompose({ network, pgbouncerConfDir, certsDir, traefikDynamicDir, tls }): string`
  - `renderHttpRouter({ name, hosts, serviceUrl }): string` (rule `Host(\`a\`) || Host(\`b\`)`), `renderDbCertRouter(host): string`
  - `renderRcloneConf({ garage: { keyId, keySecret, endpoint }, b2: { endpoint, region, keyId, keySecret } }): string`
  - `renderPgbouncerReloadCron({ certsDir, pgbouncerContainer }): string` (content of `/etc/cron.d/dbm-pgbouncer-reload`)
  - `renderStorageSyncCron({ network, rcloneConfDir, storageBucket }): string` (content of `/etc/cron.d/dbm-storage-sync`)
  - Image constants: `IMAGES = { postgres18, postgres17, pgbouncer, garage, certsDumper, rclone }`.

- [ ] **Step 1: Write the failing tests**

`test/unit/renderers.test.ts`:
```ts
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
    const y = renderGarageCompose({ network: 'dokploy-network', garageConfDir: '/etc/dokploy/dbm/garage', adminPort: 3903 });
    expect(y).toContain(`image: ${IMAGES.garage}`);
    expect(IMAGES.garage).toBe('dxflrs/garage:v2.4.1');
    expect(y).toContain('container_name: dbm-garage');
    expect(y).toContain('"127.0.0.1:3903:3903"');
    expect(y).toContain('/etc/dokploy/dbm/garage/garage.toml:/etc/garage.toml:ro');
    expect(y).toContain('GARAGE_RPC_SECRET: ${GARAGE_RPC_SECRET}');
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
    const y = renderHttpRouter({ name: 'dbm-s3', hosts: ['s3.example.com'], serviceUrl: 'http://dbm-garage:3900' });
    expect(y).toContain('rule: Host(`s3.example.com`)');
    expect(renderHttpRouter({ name: 'x', hosts: ['a.b', 'c.d'], serviceUrl: 'http://x' })).toContain('rule: Host(`a.b`) || Host(`c.d`)');
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
      b2: { endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004', keyId: 'K', keySecret: 'S2' },
    });
    expect(c).toContain('[garage]');
    expect(c).toContain('[b2]');
    expect(c).toContain('provider = Other');
    expect(c).toContain('force_path_style = true');
    expect(c).toContain('no_check_bucket = true');
    expect(c).toContain('region = garage');
  });
  it('cron files', () => {
    const r = renderPgbouncerReloadCron({ certsDir: '/etc/dokploy/dbm/certs', pgbouncerContainer: 'dbm-pgbouncer' });
    expect(r).toMatch(/^10 4 \* \* \* root /m);
    expect(r).toContain('chown -R 70:70 /etc/dokploy/dbm/certs');
    expect(r).toContain('docker kill -s HUP dbm-pgbouncer');
    const s = renderStorageSyncCron({ network: 'dokploy-network', rcloneConfDir: '/etc/dokploy/dbm/rclone', storageBucket: 'dbm-storage' });
    expect(s).toMatch(/^30 6 \* \* \* root /m);
    expect(s).toContain(IMAGES.rclone);
    expect(s).toContain('sync garage: b2:dbm-storage/storage');
    expect(s).toContain('copy /snapshots b2:dbm-storage/garage-meta');
    expect(s).toContain('--network dokploy-network');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/unit/renderers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/core/garage-config.ts`:
```ts
export interface GarageTomlOptions {
  webDomain: string;
}

/** Secrets come from env (GARAGE_RPC_SECRET, GARAGE_ADMIN_TOKEN); the file has none. */
export function renderGarageToml(o: GarageTomlOptions): string {
  return `# Garage v2.4.x single-node configuration, generated by dbm.
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
metadata_snapshots_dir = "/var/lib/garage/snapshots"

replication_factor = 1
consistency_mode = "consistent"

db_engine = "lmdb"
metadata_fsync = true
data_fsync = false
metadata_auto_snapshot_interval = "6h"

block_size = "1M"
compression_level = 1

rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"

[s3_web]
bind_addr = "[::]:3902"
root_domain = ".${o.webDomain}"
index = "index.html"
add_host_to_metrics = false

[admin]
api_bind_addr = "[::]:3903"
metrics_require_token = true
`;
}
```

`src/core/compose.ts`:
```ts
export const IMAGES = {
  postgres18: 'postgres:18',
  postgres17: 'postgres:17',
  pgbouncer: 'edoburu/pgbouncer:v1.26.0-p0',
  garage: 'dxflrs/garage:v2.4.1',
  certsDumper: 'ldez/traefik-certs-dumper:v2.11.4',
  rclone: 'rclone/rclone:1',
} as const;

export function postgresImage(major: 17 | 18): string {
  return major === 18 ? IMAGES.postgres18 : IMAGES.postgres17;
}

export interface GarageComposeOptions {
  network: string;
  garageConfDir: string;
  adminPort: number;
}

export function renderGarageCompose(o: GarageComposeOptions): string {
  return `services:
  garage:
    image: ${IMAGES.garage}
    container_name: dbm-garage
    restart: unless-stopped
    entrypoint: ["/garage"]
    command: ["server", "--single-node"]
    environment:
      GARAGE_RPC_SECRET: \${GARAGE_RPC_SECRET}
      GARAGE_ADMIN_TOKEN: \${GARAGE_ADMIN_TOKEN}
    ports:
      - "127.0.0.1:${o.adminPort}:3903"
    volumes:
      - ${o.garageConfDir}/garage.toml:/etc/garage.toml:ro
      - dbm-garage-meta:/var/lib/garage/meta
      - dbm-garage-data:/var/lib/garage/data
      - dbm-garage-snapshots:/var/lib/garage/snapshots
    networks:
      - ${o.network}
volumes:
  dbm-garage-meta:
    name: dbm-garage-meta
  dbm-garage-data:
    name: dbm-garage-data
  dbm-garage-snapshots:
    name: dbm-garage-snapshots
networks:
  ${o.network}:
    external: true
`;
}

export interface PgbouncerComposeOptions {
  network: string;
  pgbouncerConfDir: string;
  certsDir: string;
  traefikDynamicDir: string;
  tls: 'letsencrypt' | 'self-ca';
}

export function renderPgbouncerCompose(o: PgbouncerComposeOptions): string {
  const dumper =
    o.tls === 'letsencrypt'
      ? `
  certs-dumper:
    image: ${IMAGES.certsDumper}
    container_name: dbm-certs-dumper
    restart: unless-stopped
    command:
      - file
      - --version
      - v3
      - --watch
      - --domain-subdir
      - --source
      - /acme/acme.json
      - --dest
      - /certs
    volumes:
      - ${o.traefikDynamicDir}:/acme:ro
      - ${o.certsDir}:/certs
`
      : '';
  return `services:
  pgbouncer:
    image: ${IMAGES.pgbouncer}
    container_name: dbm-pgbouncer
    restart: unless-stopped
    ports:
      - "6432:6432"
    volumes:
      # Mount the directory, not the files: dbm replaces files with rename(), which a single-file bind mount would not see.
      - ${o.pgbouncerConfDir}:/etc/pgbouncer:ro
      - ${o.certsDir}:/certs:ro
    networks:
      - ${o.network}
    healthcheck:
      test: ["CMD-SHELL", "nc -z 127.0.0.1 6432 || exit 1"]
      interval: 10s
      timeout: 3s
      retries: 5
${dumper}networks:
  ${o.network}:
    external: true
`;
}
```

`src/core/traefik.ts`:
```ts
export interface HttpRouterOptions {
  name: string;
  hosts: string[];
  serviceUrl: string;
}

/** Traefik v3 file-provider fragment; Dokploy watches /etc/dokploy/traefik/dynamic and hot-reloads. */
export function renderHttpRouter(o: HttpRouterOptions): string {
  const rule = o.hosts.map((h) => `Host(\`${h}\`)`).join(' || ');
  return `http:
  routers:
    ${o.name}:
      rule: ${rule}
      entryPoints:
        - websecure
      service: ${o.name}
      tls:
        certResolver: letsencrypt
  services:
    ${o.name}:
      loadBalancer:
        servers:
          - url: ${o.serviceUrl}
`;
}

/** Exists only so Traefik requests a certificate for the PgBouncer hostname. Traffic never uses it. */
export function renderDbCertRouter(host: string): string {
  return renderHttpRouter({ name: 'dbm-db-cert', hosts: [host], serviceUrl: 'http://127.0.0.1:9' });
}
```

`src/core/host-files.ts`:
```ts
import { IMAGES } from './compose.js';
import { PGBOUNCER_RELOAD_CRON, STORAGE_SYNC_CRON } from './cron.js';

export interface RcloneConfOptions {
  garage: { keyId: string; keySecret: string; endpoint: string };
  b2: { endpoint: string; region: string; keyId: string; keySecret: string };
}

export function renderRcloneConf(o: RcloneConfOptions): string {
  return `[garage]
type = s3
provider = Other
env_auth = false
access_key_id = ${o.garage.keyId}
secret_access_key = ${o.garage.keySecret}
endpoint = ${o.garage.endpoint}
region = garage
force_path_style = true
no_check_bucket = true

[b2]
type = s3
provider = Other
env_auth = false
access_key_id = ${o.b2.keyId}
secret_access_key = ${o.b2.keySecret}
endpoint = ${o.b2.endpoint}
region = ${o.b2.region}
force_path_style = true
no_check_bucket = true
`;
}

export interface ReloadCronOptions {
  certsDir: string;
  pgbouncerContainer: string;
}

/** /etc/cron.d/dbm-pgbouncer-reload: fix cert ownership for uid 70 (pgbouncer) and reload. RELOAD is non-disruptive. */
export function renderPgbouncerReloadCron(o: ReloadCronOptions): string {
  return `SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
${PGBOUNCER_RELOAD_CRON} root chown -R 70:70 ${o.certsDir} 2>/dev/null; chmod -R go-rwx ${o.certsDir} 2>/dev/null; docker kill -s HUP ${o.pgbouncerContainer} >/dev/null 2>&1
`;
}

export interface StorageSyncCronOptions {
  network: string;
  rcloneConfDir: string;
  storageBucket: string;
}

/** /etc/cron.d/dbm-storage-sync: mirror every Garage bucket the read-only key can see, plus metadata snapshots. */
export function renderStorageSyncCron(o: StorageSyncCronOptions): string {
  const run = `docker run --rm --network ${o.network} -v ${o.rcloneConfDir}/rclone.conf:/config/rclone/rclone.conf:ro -v dbm-garage-snapshots:/snapshots:ro ${IMAGES.rclone}`;
  return `SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
${STORAGE_SYNC_CRON} root ${run} sync garage: b2:${o.storageBucket}/storage --fast-list --transfers 4 >>/var/log/dbm-storage-sync.log 2>&1; ${run} copy /snapshots b2:${o.storageBucket}/garage-meta >>/var/log/dbm-storage-sync.log 2>&1
`;
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run --project unit test/unit/renderers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/garage-config.ts src/core/compose.ts src/core/traefik.ts src/core/host-files.ts test/unit/renderers.test.ts
git commit -m "feat(core): renderers for garage.toml, compose, traefik routers, rclone and host crons"
```

### Task 8: Host hardening script renderer

**Spec:** 7 (`init` step 1), 9. **Research:** `vps-hardening-tailscale-backups.md` §"Hardening script" (the script below is that one, parameterised).

**Files:**
- Create: `src/core/harden.ts`, `test/unit/harden.test.ts`

**Interfaces:**
- Produces: `renderHardenScript(o: HardenOptions): string`; `HardenOptions { sshPort: number; publicTcpPorts: number[]; publicUdpPorts: number[]; timezone: string; rebootTime: string }`; `DEFAULT_HARDEN: HardenOptions`.

- [ ] **Step 1: Write the failing test**

`test/unit/harden.test.ts`:
```ts
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HARDEN, renderHardenScript } from '../../src/core/harden.js';

describe('renderHardenScript', () => {
  const script = renderHardenScript(DEFAULT_HARDEN);
  it('is syntactically valid bash', async () => {
    const r = await execa('bash', ['-n'], { input: script, reject: false });
    expect(r.exitCode, r.stderr).toBe(0);
  });
  it('contains the controls the spec requires', () => {
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('rm -f /etc/ssh/sshd_config.d/50-cloud-init.conf');
    expect(script).toContain('/etc/ssh/sshd_config.d/00-dbm.conf');
    expect(script).toContain('PasswordAuthentication no');
    expect(script).toContain('KbdInteractiveAuthentication no');
    expect(script).toContain('PermitRootLogin prohibit-password');
    expect(script).toContain('authorized_keys is empty');
    expect(script).toContain('Unattended-Upgrade::Automatic-Reboot "true"');
    expect(script).toContain('Automatic-Reboot-Time "04:30"');
    expect(script).toContain('/etc/docker/daemon.json');
    expect(script).toContain('ufw default deny incoming');
    expect(script).toContain('ufw allow 22/tcp');
    expect(script).toContain('ufw allow in on tailscale0');
    expect(script).toContain(':DOCKER-USER - [0:0]');
    expect(script).toContain('--ctorigdstport 6432 -j RETURN');
    expect(script).toContain('--ctorigdstport 443 -j RETURN');
    expect(script).toContain('-p udp -m conntrack --ctstate NEW --ctorigdstport 443 -j RETURN');
    expect(script).toContain('-i tailscale0 -j RETURN');
    expect(script).toContain('/etc/fail2ban/jail.d/dbm-sshd.local');
    expect(script).toContain('100.64.0.0/10');
    expect(script).toContain('timedatectl set-timezone "America/Argentina/Buenos_Aires"');
    expect(script).not.toContain('--ctorigdstport 3000');
  });
  it('parameterises ports', () => {
    const s = renderHardenScript({ ...DEFAULT_HARDEN, sshPort: 2222, publicTcpPorts: [443] });
    expect(s).toContain('ufw allow 2222/tcp');
    expect(s).not.toContain('--ctorigdstport 6432');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/unit/harden.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/core/harden.ts` (the body is the research script with the tunables substituted; keep it byte-for-byte except for the substitutions):
```ts
export interface HardenOptions {
  sshPort: number;
  publicTcpPorts: number[];
  publicUdpPorts: number[];
  timezone: string;
  rebootTime: string;
}

export const DEFAULT_HARDEN: HardenOptions = {
  sshPort: 22,
  publicTcpPorts: [80, 443, 6432],
  publicUdpPorts: [443],
  timezone: 'America/Argentina/Buenos_Aires',
  rebootTime: '04:30',
};

export function renderHardenScript(o: HardenOptions): string {
  const allowTcp = o.publicTcpPorts
    .map((p) => `-A DOCKER-USER -p tcp -m conntrack --ctstate NEW --ctorigdstport ${p} -j RETURN`)
    .join('\n');
  const allowUdp = o.publicUdpPorts
    .map((p) => `-A DOCKER-USER -p udp -m conntrack --ctstate NEW --ctorigdstport ${p} -j RETURN`)
    .join('\n');
  const ufwTcp = o.publicTcpPorts.map((p) => `ufw allow ${p}/tcp >/dev/null`).join('\n  ');
  const ufwUdp = o.publicUdpPorts.map((p) => `ufw allow ${p}/udp >/dev/null`).join('\n  ');
  return `#!/usr/bin/env bash
# dbm init: host hardening for Ubuntu 24.04 (Docker/Dokploy host). Idempotent. Run as root.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

log(){ printf '[dbm] %s\\n' "$*"; }
write_if_changed(){ # write_if_changed <path> <mode>  (content on stdin) -> 0 if changed
  local path="$1" mode="$2" tmp; tmp="$(mktemp)"; cat >"$tmp"
  if [[ -f "$path" ]] && cmp -s "$tmp" "$path"; then rm -f "$tmp"; return 1; fi
  install -m "$mode" -D "$tmp" "$path"; rm -f "$tmp"; return 0
}

require_ubuntu(){
  . /etc/os-release
  [[ "$ID" == "ubuntu" ]] || { echo "Ubuntu required, got $ID" >&2; exit 1; }
  [[ "$VERSION_ID" == "24.04" ]] || log "WARN: Ubuntu $VERSION_ID is not the tested release (24.04)"
}

step_packages(){
  log "apt: base packages"
  apt-get update -qq
  apt-get install -y -qq ufw fail2ban unattended-upgrades apt-listchanges ca-certificates curl gnupg jq iptables netcat-openbsd >/dev/null
  timedatectl set-timezone "${o.timezone}" || true
}

step_sshd(){
  log "sshd: key-only, no passwords, root via key only"
  if [[ ! -s /root/.ssh/authorized_keys ]]; then
    echo "refusing: /root/.ssh/authorized_keys is empty; you would be locked out" >&2; exit 1
  fi
  rm -f /etc/ssh/sshd_config.d/50-cloud-init.conf
  local changed=0
  write_if_changed /etc/ssh/sshd_config.d/00-dbm.conf 0644 <<EOT && changed=1
# Managed by dbm init. Sorts first => wins (sshd uses the first value seen).
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PermitEmptyPasswords no
X11Forwarding no
MaxAuthTries 4
LoginGraceTime 30
EOT
  sshd -t
  if (( changed )); then systemctl reload ssh 2>/dev/null || systemctl restart ssh; fi
  sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '
}

step_unattended_upgrades(){
  log "unattended-upgrades: security-only + reboot window ${o.rebootTime}"
  write_if_changed /etc/apt/apt.conf.d/52dbm-unattended-upgrades 0644 <<EOT || true
// Managed by dbm init
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "${o.rebootTime}";
Unattended-Upgrade::SyslogEnable "true";
EOT
  write_if_changed /etc/apt/apt.conf.d/20auto-upgrades 0644 <<'EOT' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOT
  systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null
}

step_docker_daemon_json(){
  log "docker: daemon.json log rotation (before Dokploy installs Docker)"
  mkdir -p /etc/docker
  local cur='{}'; [[ -s /etc/docker/daemon.json ]] && cur="$(cat /etc/docker/daemon.json)"
  local new
  new="$(jq -S '. + {"log-driver":"json-file","log-opts":((."log-opts"//{}) + {"max-size":"10m","max-file":"3"})}' <<<"$cur")"
  if printf '%s\\n' "$new" | write_if_changed /etc/docker/daemon.json 0644; then
    if systemctl is-active --quiet docker; then
      log "docker: config changed, restarting dockerd"
      systemctl restart docker
    fi
  fi
}

step_docker_user_rules(){
  # Docker DNATs published ports before ufw's INPUT chain. FORWARD -> DOCKER-USER is ours.
  # Shipped through ufw's after.rules so ufw re-applies it on reload/boot (ufw-docker pattern).
  local block
  block="$(cat <<EOT
# BEGIN DBM DOCKER-USER
*filter
:ufw-user-forward - [0:0]
:DOCKER-USER - [0:0]
:dbm-docker-deny - [0:0]
-A DOCKER-USER -j ufw-user-forward
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -m conntrack --ctstate INVALID -j DROP
-A DOCKER-USER -i tailscale0 -j RETURN
-A DOCKER-USER -i docker0 -j RETURN
-A DOCKER-USER -i docker_gwbridge -j RETURN
-A DOCKER-USER -s 10.0.0.0/8 -j RETURN
-A DOCKER-USER -s 172.16.0.0/12 -j RETURN
-A DOCKER-USER -s 192.168.0.0/16 -j RETURN
${allowTcp}
${allowUdp}
-A DOCKER-USER -m conntrack --ctstate NEW -j dbm-docker-deny
-A DOCKER-USER -j RETURN
-A dbm-docker-deny -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[DBM DOCKER BLOCK] "
-A dbm-docker-deny -j DROP
COMMIT
# END DBM DOCKER-USER
EOT
)"
  local f=/etc/ufw/after.rules tmp; tmp="$(mktemp)"
  awk '/^# BEGIN DBM DOCKER-USER/{skip=1} !skip{print} /^# END DBM DOCKER-USER/{skip=0}' "$f" >"$tmp"
  printf '\\n%s\\n' "$block" >>"$tmp"
  if ! cmp -s "$tmp" "$f"; then install -m 0640 "$tmp" "$f"; log "after.rules: DOCKER-USER block updated"; fi
  rm -f "$tmp"
}

step_ufw(){
  log "ufw: default deny in; allow ${o.sshPort}/tcp, 41641/udp, tailscale0"
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow ${o.sshPort}/tcp >/dev/null
  ufw allow 41641/udp >/dev/null
  ufw allow in on tailscale0 >/dev/null
  ${ufwTcp}
  ${ufwUdp}
  step_docker_user_rules
  ufw --force enable >/dev/null
  ufw reload >/dev/null
}

step_fail2ban(){
  log "fail2ban: sshd jail"
  write_if_changed /etc/fail2ban/jail.d/dbm-sshd.local 0644 <<EOT || true
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 100.64.0.0/10
bantime  = 1h
findtime = 10m
maxretry = 5
bantime.increment = true

[sshd]
enabled = true
port    = ${o.sshPort}
mode    = normal
EOT
  systemctl enable --now fail2ban >/dev/null
  systemctl restart fail2ban
}

require_ubuntu
step_packages
step_sshd
step_unattended_upgrades
step_docker_daemon_json
step_ufw
step_fail2ban
log "host hardening converged"
`;
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run --project unit test/unit/harden.test.ts`
Expected: PASS (the `bash -n` check must exit 0; fix any template-literal escaping until it does).

- [ ] **Step 5: Commit**

```bash
git add src/core/harden.ts test/unit/harden.test.ts
git commit -m "feat(core): idempotent Ubuntu 24.04 hardening script renderer"
```

---

## Phase C — Adapters

### Task 9: Adapter interfaces, SSH runner, local runner

**Spec:** 5.6 (remote execution model). **Research:** `cli-tooling.md` §"Code patterns" 5.

**Files:**
- Create: `src/adapters/types.ts`, `src/adapters/ssh.ts`, `test/adapters/ssh.test.ts`

**Interfaces:**
- Produces (`types.ts`), used by every later task:

```ts
export interface RunResult { stdout: string; stderr: string }
export interface RunOptions { input?: string; timeoutMs?: number }
export interface SshRunner {
  run(argv: string[], opts?: RunOptions): Promise<RunResult>;
  /** Atomic write (mktemp + mv) of content to remotePath; parent dir created; default mode 0600. */
  upload(remotePath: string, content: string, opts?: { mode?: string }): Promise<void>;
  /** ssh -t with inherited stdio; resolves with the remote exit code. */
  interactive(argv: string[]): Promise<number>;
}
export interface PgTarget { appName: string; role: string; database: string }
export interface PostgresAdmin {
  runSql(target: PgTarget, sql: string, opts?: RunOptions): Promise<string>;
  ping(target: PgTarget): Promise<boolean>;
  /** psql from a throwaway container on the docker network; proves PgBouncer routing + SCRAM. */
  pingViaPgbouncer(url: string): Promise<boolean>;
  findContainer(appName: string): Promise<string>;
}
export interface GarageBucketInfo {
  id: string; globalAliases: string[]; bytes: number; objects: number; unfinishedUploads: number; websiteAccess: boolean;
}
export interface GaragePermissions { read?: boolean; write?: boolean; owner?: boolean }
export interface GarageCorsRule {
  allowedOrigins: string[]; allowedMethods: string[]; allowedHeaders: string[]; exposeHeaders: string[]; maxAgeSeconds: number;
}
export interface GarageAdmin {
  health(): Promise<boolean>;
  createBucket(globalAlias: string): Promise<GarageBucketInfo>;
  getBucket(q: { id?: string; globalAlias?: string }): Promise<GarageBucketInfo | undefined>;
  listBuckets(): Promise<Array<{ id: string; globalAliases: string[] }>>;
  createKey(name: string): Promise<{ accessKeyId: string; secretAccessKey: string }>;
  allowBucketKey(bucketId: string, accessKeyId: string, perms: GaragePermissions): Promise<void>;
  denyBucketKey(bucketId: string, accessKeyId: string, perms: GaragePermissions): Promise<void>;
  updateBucket(bucketId: string, patch: {
    corsRules?: GarageCorsRule[];
    websiteAccess?: { enabled: boolean; indexDocument?: string; errorDocument?: string };
  }): Promise<void>;
  addBucketAlias(bucketId: string, globalAlias: string): Promise<void>;
  removeBucketAlias(bucketId: string, globalAlias: string): Promise<void>;
  deleteKey(accessKeyId: string): Promise<void>;
  deleteBucket(bucketId: string): Promise<void>;
  cleanupIncompleteUploads(bucketId: string): Promise<void>;
  createAdminToken(name: string, scope: string[]): Promise<{ secretToken: string }>;
}
export type PostgresStatus = 'idle' | 'running' | 'done' | 'error';
export interface DokployPostgres {
  postgresId: string; appName: string; applicationStatus: PostgresStatus; databaseName: string; databaseUser: string;
}
export interface DokployProject {
  projectId: string; name: string;
  environments: Array<{ environmentId: string; name: string;
    postgres: Array<{ postgresId: string; appName: string; name: string }>;
    compose: Array<{ composeId: string; appName: string; name: string }>;
  }>;
}
export interface DestinationInput {
  name: string; provider: string | null; accessKey: string; secretAccessKey: string;
  bucket: string; region: string; endpoint: string; additionalFlags: string[] | null;
}
export interface BackupInput {
  schedule: string; prefix: string; destinationId: string; database: string;
  databaseType: 'postgres'; postgresId: string; enabled: boolean; keepLatestCount: number;
}
export interface BackupFile { Path: string; Name: string; Size: number; ModTime: string }
export interface DokployClient {
  getVersion(): Promise<string>;
  listOrganizations(): Promise<Array<{ id: string; name: string }>>;
  listProjects(): Promise<Array<{ projectId: string; name: string; environments: Array<{ environmentId: string; name: string }> }>>;
  createApiKey(input: { name: string; organizationId: string }): Promise<string>;
  createProject(name: string): Promise<{ projectId: string; environmentId: string }>;
  getProject(projectId: string): Promise<DokployProject>;
  createPostgres(input: {
    name: string; appName: string; databaseName: string; databaseUser: string; databasePassword: string;
    environmentId: string; dockerImage: string;
  }): Promise<DokployPostgres>;
  updatePostgres(input: { postgresId: string; memoryLimit?: string; cpuLimit?: string }): Promise<void>;
  deployPostgres(postgresId: string): Promise<void>;
  getPostgres(postgresId: string): Promise<DokployPostgres>;
  stopPostgres(postgresId: string): Promise<void>;
  startPostgres(postgresId: string): Promise<void>;
  removePostgres(postgresId: string): Promise<void>;
  createCompose(input: { name: string; appName: string; environmentId: string; composeFile: string; env: string })
    : Promise<{ composeId: string; appName: string }>;
  updateCompose(input: { composeId: string; composeFile: string; env: string }): Promise<void>;
  deployCompose(composeId: string): Promise<void>;
  getCompose(composeId: string): Promise<{ composeId: string; appName: string; composeStatus: string }>;
  createDestination(input: DestinationInput): Promise<{ destinationId: string }>;
  testDestination(input: DestinationInput): Promise<void>;
  getDestination(destinationId: string): Promise<DestinationInput & { destinationId: string }>;
  createBackup(input: BackupInput): Promise<{ backupId: string }>;
  updateBackup(input: BackupInput & { backupId: string }): Promise<void>;
  removeBackup(backupId: string): Promise<void>;
  manualBackup(backupId: string): Promise<void>;
  listBackupFiles(destinationId: string, search: string): Promise<BackupFile[]>;
}
```

- `ssh.ts` produces `makeSshRunner({ host, user?, exec? })`, `makeLocalRunner({ exec?, mapPath? })`, `ExecFn`, `SSH_OPTS`.

- [ ] **Step 1: Write types.ts** exactly as above (copy the block into `src/adapters/types.ts`).

- [ ] **Step 2: Write the failing tests**

`test/adapters/ssh.test.ts`:
```ts
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
    const out = await r.run(['docker', 'exec', '-i', 'pg-my app', 'psql', '-c', "select 'x'"], { input: 'sql' });
    expect(out.stdout).toBe('ok');
    const call = f.calls[0];
    expect(call?.file).toBe('ssh');
    expect(call?.args).toContain('BatchMode=yes');
    expect(call?.args).toContain('StrictHostKeyChecking=accept-new');
    expect(call?.args).toContain('root@1.2.3.4');
    expect(call?.args.at(-1)).toBe(`docker exec -i 'pg-my app' psql -c 'select '"'"'x'"'"''`);
    expect(call?.input).toBe('sql');
  });
  it('maps non-zero exit to DbmError exit 2 with stderr', async () => {
    const f = fakeExec({ exitCode: 1, stderr: 'boom' });
    const r = makeSshRunner({ host: 'h', user: 'ubuntu', exec: f.exec });
    await expect(r.run(['false'])).rejects.toMatchObject({ exitCode: 2, step: 'ssh', message: /boom/ });
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
    const r = makeLocalRunner({ mapPath: (p) => join(dir, p.replace(/^\/etc\/dokploy\/dbm\//, '')) });
    expect((await r.run(['echo', 'hi'])).stdout).toBe('hi');
    await r.upload('/etc/dokploy/dbm/pgbouncer/pgbouncer.ini', 'x=1\n', { mode: '0644' });
    const file = join(dir, 'pgbouncer/pgbouncer.ini');
    expect(await readFile(file, 'utf8')).toBe('x=1\n');
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    await expect(r.run(['sh', '-c', 'echo bad >&2; exit 3'])).rejects.toBeInstanceOf(DbmError);
  });
  it('is not affected by DbmError import cycles', () => {
    expect(vi.isMockFunction(makeLocalRunner)).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run --project unit test/adapters/ssh.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `src/adapters/ssh.ts`**

```ts
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { join as shJoin, quote as shQuote } from 'shlex';
import { DbmError, ExitCode, remoteError } from '../core/exit.js';
import type { RunOptions, RunResult, SshRunner } from './types.js';

export interface ExecResult {
  exitCode?: number | undefined;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  shortMessage?: string;
}
export type ExecFn = (
  file: string,
  args: string[],
  opts: { input?: string; timeout: number; stdin: 'pipe' | 'ignore' },
) => Promise<ExecResult>;

const defaultExec: ExecFn = async (file, args, opts) => {
  const r = await execa(file, args, {
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    stdin: opts.stdin,
    timeout: opts.timeout,
    reject: false,
    stripFinalNewline: true,
  });
  return {
    exitCode: r.exitCode,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    timedOut: r.timedOut,
    shortMessage: r.shortMessage,
  };
};

export const SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'LogLevel=ERROR',
];

const DEFAULT_TIMEOUT_MS = 60_000;

function timeoutMultiplier(): number {
  const m = Number(process.env.DBM_TIMEOUT_MULTIPLIER ?? '1');
  return Number.isFinite(m) && m > 0 ? m : 1;
}

function checkResult(r: ExecResult, what: string, timeoutMs: number): RunResult {
  if (r.timedOut) throw remoteError(`command timed out after ${timeoutMs}ms: ${what}`, 'ssh');
  if (r.exitCode !== 0) {
    throw new DbmError(`${what}\n${r.stderr || r.shortMessage || `exit ${r.exitCode}`}`, ExitCode.RemoteFailure, 'ssh');
  }
  return { stdout: r.stdout, stderr: r.stderr };
}

/** POSIX script: create parent, write to a temp file in the same dir, chmod, rename over the target. */
export function atomicUploadScript(remotePath: string, mode: string): string {
  const dir = shQuote(dirname(remotePath));
  const target = shQuote(remotePath);
  return `set -e; d=${dir}; mkdir -p "$d"; umask 077; t=$(mktemp "$d/.tmp.XXXXXX"); cat > "$t"; chmod ${mode} "$t"; mv -f "$t" ${target}`;
}

export function makeSshRunner(o: { host: string; user?: string; exec?: ExecFn }): SshRunner {
  const exec = o.exec ?? defaultExec;
  const target = `${o.user ?? 'root'}@${o.host}`;
  async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
    const remote = shJoin(argv);
    const timeout = (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) * timeoutMultiplier();
    const r = await exec('ssh', [...SSH_OPTS, target, remote], {
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      timeout,
      stdin: opts.input === undefined ? 'ignore' : 'pipe',
    });
    return checkResult(r, `ssh ${target} ${remote}`, timeout);
  }
  return {
    run,
    async upload(remotePath, content, opts = {}) {
      await run(['sh', '-c', atomicUploadScript(remotePath, opts.mode ?? '0600')], { input: content });
    },
    async interactive(argv) {
      const r = await execa('ssh', ['-t', ...SSH_OPTS, target, shJoin(argv)], { stdio: 'inherit', reject: false });
      return r.exitCode ?? 1;
    },
  };
}

/** Runs the same argv on this machine (integration tests, or dbm running on the VPS itself). */
export function makeLocalRunner(o: { exec?: ExecFn; mapPath?: (remotePath: string) => string } = {}): SshRunner {
  const exec = o.exec ?? defaultExec;
  const mapPath = o.mapPath ?? ((p: string) => p);
  return {
    async run(argv, opts = {}) {
      const [file, ...args] = argv;
      if (!file) throw remoteError('empty argv', 'local');
      const timeout = (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) * timeoutMultiplier();
      const r = await exec(file, args, {
        ...(opts.input !== undefined ? { input: opts.input } : {}),
        timeout,
        stdin: opts.input === undefined ? 'ignore' : 'pipe',
      });
      return checkResult(r, shJoin(argv), timeout);
    },
    async upload(remotePath, content, opts = {}) {
      const file = mapPath(remotePath);
      await mkdir(dirname(file), { recursive: true });
      const tmp = join(dirname(file), `.tmp.${process.pid}.${Date.now()}`);
      await writeFile(tmp, content, 'utf8');
      await chmod(tmp, Number.parseInt(opts.mode ?? '0600', 8));
      await rename(tmp, file);
    },
    async interactive(argv) {
      const [file, ...args] = argv;
      if (!file) return 1;
      const r = await execa(file, args, { stdio: 'inherit', reject: false });
      return r.exitCode ?? 1;
    },
  };
}
```

- [ ] **Step 5: Run tests, expect pass**

Run: `npx vitest run --project unit test/adapters/ssh.test.ts`
Expected: PASS. If the shlex expectation for the quoted remote string differs in escaping, check the actual output of `shlex.join` and keep the test asserting the exact string it produces (the invariant is: quoted, and `input` on stdin).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/types.ts src/adapters/ssh.ts test/adapters/ssh.test.ts
git commit -m "feat(adapters): interfaces, ssh runner via system ssh, local runner"
```

### Task 10: Postgres admin and Garage admin adapters

**Spec:** 5.2, 5.4, 5.6. **Research:** `garage-s3.md` §"Admin API reference".

**Files:**
- Create: `src/adapters/postgres.ts`, `src/adapters/garage.ts`, `test/adapters/postgres.test.ts`, `test/adapters/garage.test.ts`, `test/helpers/fake-runner.ts`

**Interfaces:**
- Produces: `makePostgresAdmin(runner, { network, clientImage }): PostgresAdmin`, `makeGarageAdmin(runner, { port, token }): GarageAdmin`, `curlConfig(...)` (exported for tests), `GARAGE_CLI_SCOPE: string[]`.

- [ ] **Step 1: Write the fake runner helper**

`test/helpers/fake-runner.ts`:
```ts
import type { RunOptions, RunResult, SshRunner } from '../../src/adapters/types.js';

export interface RecordedCall {
  argv: string[];
  input?: string;
}

/** Scripted SshRunner: responders are matched in order against argv joined by spaces. */
export function makeFakeRunner(
  responders: Array<{ match: RegExp; stdout?: string; stderr?: string; fail?: boolean }> = [],
) {
  const calls: RecordedCall[] = [];
  const uploads: Array<{ path: string; content: string; mode: string }> = [];
  const runner: SshRunner = {
    async run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
      calls.push({ argv, ...(opts.input !== undefined ? { input: opts.input } : {}) });
      const line = argv.join(' ');
      const r = responders.find((x) => x.match.test(line));
      if (r?.fail) {
        const { DbmError, ExitCode } = await import('../../src/core/exit.js');
        throw new DbmError(`${line}\n${r.stderr ?? 'failed'}`, ExitCode.RemoteFailure, 'ssh');
      }
      return { stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
    },
    async upload(path, content, opts = {}) {
      uploads.push({ path, content, mode: opts.mode ?? '0600' });
    },
    async interactive() {
      return 0;
    },
  };
  return { runner, calls, uploads };
}
```

- [ ] **Step 2: Write the failing tests**

`test/adapters/postgres.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { makePostgresAdmin } from '../../src/adapters/postgres.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';

const target = { appName: 'pg-my-app-abc123', role: 'my_app_admin', database: 'my_app' };

describe('PostgresAdmin', () => {
  it('resolves the swarm task container by service label, then runs psql with SQL on stdin', async () => {
    const f = makeFakeRunner([
      { match: /docker ps -q --filter label=com\.docker\.swarm\.service\.name=pg-my-app-abc123/, stdout: 'c0ffee' },
      { match: /docker exec -i c0ffee psql/, stdout: '1' },
    ]);
    const pg = makePostgresAdmin(f.runner, { network: 'dokploy-network', clientImage: 'postgres:18' });
    expect(await pg.runSql(target, 'select 1;')).toBe('1');
    const exec = f.calls[1];
    expect(exec?.argv).toEqual([
      'docker', 'exec', '-i', 'c0ffee', 'psql', '-U', 'my_app_admin', '-d', 'my_app',
      '-v', 'ON_ERROR_STOP=1', '-qAt', '-f', '-',
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
      { match: /docker run --rm --network dokploy-network postgres:18 psql postgresql:\/\/u:p@dbm-pgbouncer:6432\/my-app -Atc select 1/, stdout: '1' },
    ]);
    const pg = makePostgresAdmin(f.runner, { network: 'dokploy-network', clientImage: 'postgres:18' });
    expect(await pg.ping(target)).toBe(false);
    expect(await pg.pingViaPgbouncer('postgresql://u:p@dbm-pgbouncer:6432/my-app')).toBe(true);
  });
  it('throws a remote error naming the container when none is found', async () => {
    const f = makeFakeRunner([{ match: /docker ps/, stdout: '' }]);
    const pg = makePostgresAdmin(f.runner, { network: 'n', clientImage: 'postgres:18' });
    await expect(pg.runSql(target, 'x')).rejects.toThrow(/no running container for pg-my-app-abc123/);
  });
});
```

`test/adapters/garage.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { curlConfig, makeGarageAdmin } from '../../src/adapters/garage.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';

describe('curlConfig', () => {
  it('escapes quotes and backslashes and never puts the token in argv', () => {
    const cfg = curlConfig({
      url: 'http://127.0.0.1:3903/v2/CreateBucket',
      method: 'POST',
      token: 'tok"en',
      body: { globalAlias: 'a"b\\c' },
    });
    expect(cfg).toContain('url = "http://127.0.0.1:3903/v2/CreateBucket"');
    expect(cfg).toContain('request = "POST"');
    expect(cfg).toContain('header = "Authorization: Bearer tok\\"en"');
    expect(cfg).toContain('data = "{\\"globalAlias\\":\\"a\\"b\\\\c\\"}"');
    expect(cfg).toContain('fail-with-body');
  });
});

describe('GarageAdmin', () => {
  const info = JSON.stringify({ id: 'b1', globalAliases: ['my-app'], bytes: 0, objects: 0, unfinishedUploads: 0, websiteAccess: false });
  it('createBucket posts JSON via curl -K - and parses the response', async () => {
    const f = makeFakeRunner([{ match: /^curl -K -$/, stdout: info }]);
    const g = makeGarageAdmin(f.runner, { port: 3903, token: 'T' });
    const b = await g.createBucket('my-app');
    expect(b.id).toBe('b1');
    expect(f.calls[0]?.argv).toEqual(['curl', '-K', '-']);
    expect(f.calls[0]?.input).toContain('/v2/CreateBucket');
    expect(f.calls[0]?.input).toContain('header = "Authorization: Bearer T"');
  });
  it('getBucket returns undefined on 404-style failure and health uses the unauthenticated endpoint', async () => {
    const f = makeFakeRunner([
      { match: /curl/, fail: true, stderr: 'curl: (22) The requested URL returned error: 404' },
    ]);
    const g = makeGarageAdmin(f.runner, { port: 3903, token: 'T' });
    expect(await g.getBucket({ globalAlias: 'nope' })).toBeUndefined();
    expect(await g.health()).toBe(false);
  });
  it('allowBucketKey / updateBucket / deleteBucket build the right operations', async () => {
    const f = makeFakeRunner([{ match: /curl/, stdout: '{}' }]);
    const g = makeGarageAdmin(f.runner, { port: 3903, token: 'T' });
    await g.allowBucketKey('b1', 'GK', { read: true, write: true });
    await g.updateBucket('b1', { websiteAccess: { enabled: true, indexDocument: 'index.html' } });
    await g.deleteBucket('b1');
    await g.deleteKey('GK');
    const inputs = f.calls.map((c) => c.input ?? '');
    expect(inputs[0]).toContain('/v2/AllowBucketKey');
    expect(inputs[0]).toContain('\\"permissions\\":{\\"read\\":true,\\"write\\":true}');
    expect(inputs[1]).toContain('/v2/UpdateBucket?id=b1');
    expect(inputs[2]).toContain('/v2/DeleteBucket?id=b1');
    expect(inputs[3]).toContain('/v2/DeleteKey?id=GK');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run --project unit test/adapters/postgres.test.ts test/adapters/garage.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

`src/adapters/postgres.ts`:
```ts
import { remoteError } from '../core/exit.js';
import type { PgTarget, PostgresAdmin, RunOptions, SshRunner } from './types.js';

export interface PostgresAdminOptions {
  network: string;
  clientImage: string;
}

export function makePostgresAdmin(runner: SshRunner, o: PostgresAdminOptions): PostgresAdmin {
  async function findContainer(appName: string): Promise<string> {
    const byLabel = await runner.run([
      'docker', 'ps', '-q', '--filter', `label=com.docker.swarm.service.name=${appName}`,
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
      ['docker', 'exec', '-i', container, 'psql', '-U', t.role, '-d', t.database, '-v', 'ON_ERROR_STOP=1', '-qAt', '-f', '-'],
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
          ['docker', 'run', '--rm', '--network', o.network, o.clientImage, 'psql', url, '-Atc', 'select 1'],
          { timeoutMs: 90_000 },
        );
        return r.stdout.trim() === '1';
      } catch {
        return false;
      }
    },
  };
}
```

`src/adapters/garage.ts`:
```ts
import { z } from 'zod';
import { DbmError, remoteError } from '../core/exit.js';
import type { GarageAdmin, GarageBucketInfo, GaragePermissions, SshRunner } from './types.js';

export interface GarageAdminOptions {
  port: number;
  token: string;
}

/** Operations the CLI's scoped admin token needs (Garage admin API v2). */
export const GARAGE_CLI_SCOPE = [
  'GetClusterHealth', 'GetClusterStatus', 'ListBuckets', 'GetBucketInfo', 'CreateBucket', 'UpdateBucket',
  'DeleteBucket', 'AddBucketAlias', 'RemoveBucketAlias', 'CleanupIncompleteUploads', 'ListKeys', 'GetKeyInfo',
  'CreateKey', 'DeleteKey', 'AllowBucketKey', 'DenyBucketKey',
];

function esc(s: string): string {
  return s.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export interface CurlConfigInput {
  url: string;
  method: 'GET' | 'POST';
  token?: string;
  body?: unknown;
}

/** curl -K - config: token and body travel on stdin, never in argv. */
export function curlConfig(i: CurlConfigInput): string {
  const lines = [`url = "${esc(i.url)}"`, `request = "${i.method}"`, 'silent', 'show-error', 'fail-with-body', 'max-time = 15'];
  if (i.token) lines.push(`header = "Authorization: Bearer ${esc(i.token)}"`);
  if (i.body !== undefined) {
    lines.push('header = "Content-Type: application/json"');
    lines.push(`data = "${esc(JSON.stringify(i.body))}"`);
  }
  return `${lines.join('\n')}\n`;
}

const BucketInfo = z.looseObject({
  id: z.string(),
  globalAliases: z.array(z.string()).default([]),
  bytes: z.number().default(0),
  objects: z.number().default(0),
  unfinishedUploads: z.number().default(0),
  websiteAccess: z.boolean().default(false),
});

export function makeGarageAdmin(runner: SshRunner, o: GarageAdminOptions): GarageAdmin {
  const base = `http://127.0.0.1:${o.port}`;

  async function call(op: string, opts: { method?: 'GET' | 'POST'; query?: Record<string, string>; body?: unknown } = {}): Promise<unknown> {
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
    const cfg = curlConfig({ url: `${base}/v2/${op}${qs}`, method: opts.method ?? 'POST', token: o.token, ...(opts.body !== undefined ? { body: opts.body } : {}) });
    try {
      const r = await runner.run(['curl', '-K', '-'], { input: cfg, timeoutMs: 20_000 });
      return r.stdout ? JSON.parse(r.stdout) : {};
    } catch (e) {
      if (e instanceof DbmError) throw remoteError(`garage ${op}: ${e.message}`, `garage.${op}`);
      throw e;
    }
  }

  async function perms(op: 'AllowBucketKey' | 'DenyBucketKey', bucketId: string, accessKeyId: string, p: GaragePermissions) {
    const permissions: Record<string, boolean> = {};
    if (p.read) permissions.read = true;
    if (p.write) permissions.write = true;
    if (p.owner) permissions.owner = true;
    await call(op, { body: { bucketId, accessKeyId, permissions } });
  }

  return {
    async health() {
      try {
        await runner.run(['curl', '-K', '-'], { input: curlConfig({ url: `${base}/health`, method: 'GET' }), timeoutMs: 10_000 });
        return true;
      } catch {
        return false;
      }
    },
    async createBucket(globalAlias) {
      return BucketInfo.parse(await call('CreateBucket', { body: { globalAlias } })) as GarageBucketInfo;
    },
    async getBucket(q) {
      try {
        const query: Record<string, string> = q.id ? { id: q.id } : { globalAlias: q.globalAlias ?? '' };
        return BucketInfo.parse(await call('GetBucketInfo', { method: 'GET', query })) as GarageBucketInfo;
      } catch (e) {
        if (e instanceof DbmError && /404|NoSuchBucket|not found/i.test(e.message)) return undefined;
        throw e;
      }
    },
    async listBuckets() {
      return z.array(z.looseObject({ id: z.string(), globalAliases: z.array(z.string()).default([]) })).parse(
        await call('ListBuckets', { method: 'GET' }),
      );
    },
    async createKey(name) {
      return z.looseObject({ accessKeyId: z.string(), secretAccessKey: z.string() }).parse(
        await call('CreateKey', { body: { name, neverExpires: true, allow: { createBucket: false } } }),
      );
    },
    allowBucketKey: (b, k, p) => perms('AllowBucketKey', b, k, p),
    denyBucketKey: (b, k, p) => perms('DenyBucketKey', b, k, p),
    async updateBucket(bucketId, patch) {
      await call('UpdateBucket', { query: { id: bucketId }, body: patch });
    },
    async addBucketAlias(bucketId, globalAlias) {
      await call('AddBucketAlias', { body: { bucketId, globalAlias } });
    },
    async removeBucketAlias(bucketId, globalAlias) {
      await call('RemoveBucketAlias', { body: { bucketId, globalAlias } });
    },
    async deleteKey(accessKeyId) {
      await call('DeleteKey', { query: { id: accessKeyId } });
    },
    async deleteBucket(bucketId) {
      await call('DeleteBucket', { query: { id: bucketId } });
    },
    async cleanupIncompleteUploads(bucketId) {
      await call('CleanupIncompleteUploads', { body: { bucketId, olderThanSecs: 0 } });
    },
    async createAdminToken(name, scope) {
      return z.looseObject({ secretToken: z.string() }).parse(
        await call('CreateAdminToken', { body: { name, scope, neverExpires: true } }),
      );
    },
  };
}
```

- [ ] **Step 5: Run tests, expect pass**

Run: `npx vitest run --project unit test/adapters/postgres.test.ts test/adapters/garage.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/postgres.ts src/adapters/garage.ts test/adapters test/helpers
git commit -m "feat(adapters): postgres admin over docker exec, garage admin v2 over curl"
```

### Task 11: Dokploy REST client with MSW fixtures

**Spec:** 5.1. **Research:** `dokploy.md` §"Endpoint reference". Response bodies are untyped in Dokploy's OpenAPI; the fixtures below are derived from the Drizzle schemas in the research. **Section 19 item 1: re-record them against a live instance (`GET /api/settings.getOpenApiDocument` plus real calls) before the first e2e run and commit the recordings.**

**Files:**
- Create: `src/adapters/dokploy.ts`, `test/adapters/dokploy.test.ts`, `test/fixtures/dokploy/README.md`

**Interfaces:**
- Produces: `makeDokployClient({ baseUrl, apiKey, fetchFn? }): DokployClient`.

- [ ] **Step 1: Write the failing tests**

`test/adapters/dokploy.test.ts`:
```ts
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeDokployClient } from '../../src/adapters/dokploy.js';

const BASE = 'https://dokploy.test';
const auth = (req: Request) => req.headers.get('x-api-key') === 'tok';

const pgRow = {
  postgresId: 'pg_1', name: 'pg-my-app', appName: 'pg-my-app-k3j9dq', databaseName: 'my_app',
  databaseUser: 'my_app_admin', databasePassword: 'x', applicationStatus: 'idle', dockerImage: 'postgres:18',
};

const server = setupServer(
  http.get(`${BASE}/api/settings.getDokployVersion`, ({ request }) =>
    auth(request) ? HttpResponse.json('v0.30.8') : new HttpResponse(null, { status: 401 })),
  http.post(`${BASE}/api/project.create`, async ({ request }) => {
    const body = (await request.json()) as { name: string };
    return HttpResponse.json({ project: { projectId: 'proj_1', name: body.name }, environment: { environmentId: 'env_1', name: 'production' } });
  }),
  http.get(`${BASE}/api/project.all`, () => HttpResponse.json([{ projectId: 'proj_1', name: 'dbm', environments: [{ environmentId: 'env_1', name: 'production' }] }])),
  http.get(`${BASE}/api/project.one`, ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get('projectId') !== 'proj_1') return HttpResponse.json({ message: 'Project not found', code: 'NOT_FOUND' }, { status: 404 });
    return HttpResponse.json({ projectId: 'proj_1', name: 'dbm', environments: [{ environmentId: 'env_1', name: 'production', postgres: [pgRow], compose: [] }] });
  }),
  http.post(`${BASE}/api/postgres.create`, async ({ request }) => {
    const body = (await request.json()) as Record<string, string>;
    if (!/^[a-zA-Z0-9]+$/.test(body.databasePassword ?? '')) return HttpResponse.json({ message: 'Invalid password', code: 'BAD_REQUEST' }, { status: 400 });
    if (body.appName === 'pg-taken') return HttpResponse.json({ message: 'Service with this appName already exists', code: 'CONFLICT' }, { status: 409 });
    return HttpResponse.json({ ...pgRow, appName: `${body.appName}-k3j9dq` });
  }),
  http.post(`${BASE}/api/postgres.update`, () => HttpResponse.json(true)),
  http.post(`${BASE}/api/postgres.deploy`, () => HttpResponse.json(pgRow)),
  http.get(`${BASE}/api/postgres.one`, () => HttpResponse.json({ ...pgRow, applicationStatus: 'done' })),
  http.post(`${BASE}/api/postgres.stop`, () => HttpResponse.json(pgRow)),
  http.post(`${BASE}/api/postgres.start`, () => HttpResponse.json(pgRow)),
  http.post(`${BASE}/api/postgres.remove`, () => HttpResponse.json(pgRow)),
  http.post(`${BASE}/api/backup.create`, () => HttpResponse.json({ backupId: 'bk_1', appName: pgRow.appName })),
  http.post(`${BASE}/api/backup.manualBackupPostgres`, () => HttpResponse.json(true)),
  http.get(`${BASE}/api/backup.listBackupFiles`, () =>
    HttpResponse.json([{ Path: 'pg-my-app-k3j9dq/db/my-app/2026-09-30T06-03-00-000Z.sql.gz', Name: '2026-09-30T06-03-00-000Z.sql.gz', Size: 1234, ModTime: '2026-09-30T06:03:01Z', IsDir: false }])),
  http.get(`${BASE}/api/organization.all`, () => HttpResponse.json([{ id: 'org_1', name: 'Personal' }])),
  http.post(`${BASE}/api/user.createApiKey`, async ({ request }) => {
    const body = (await request.json()) as { rateLimitEnabled?: boolean };
    return HttpResponse.json({ id: 'key_1', key: body.rateLimitEnabled === false ? 'dbm_key' : 'limited' });
  }),
);

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const client = makeDokployClient({ baseUrl: `${BASE}/`, apiKey: 'tok' });

describe('DokployClient', () => {
  it('sends x-api-key and parses version', async () => {
    expect(await client.getVersion()).toBe('0.30.8');
    await expect(makeDokployClient({ baseUrl: BASE, apiKey: 'bad' }).getVersion()).rejects.toMatchObject({ exitCode: 2, step: 'dokploy.settings.getDokployVersion' });
  });
  it('creates a project and reads it back', async () => {
    expect((await client.listProjects())[0]?.name).toBe('dbm');
    expect(await client.createProject('dbm')).toEqual({ projectId: 'proj_1', environmentId: 'env_1' });
    const p = await client.getProject('proj_1');
    expect(p.environments[0]?.postgres[0]?.appName).toBe('pg-my-app-k3j9dq');
    await expect(client.getProject('nope')).rejects.toThrow(/Project not found/);
  });
  it('creates postgres and returns the suffixed appName; surfaces 409 and 400 messages', async () => {
    const input = { name: 'pg-my-app', appName: 'pg-my-app', databaseName: 'my_app', databaseUser: 'my_app_admin', databasePassword: 'Abc123', environmentId: 'env_1', dockerImage: 'postgres:18' };
    expect((await client.createPostgres(input)).appName).toBe('pg-my-app-k3j9dq');
    await expect(client.createPostgres({ ...input, appName: 'pg-taken' })).rejects.toThrow(/already exists/);
    await expect(client.createPostgres({ ...input, databasePassword: 'bad$pw' })).rejects.toThrow(/Invalid password/);
  });
  it('deploy is fire-and-confirm: getPostgres reports done', async () => {
    await client.updatePostgres({ postgresId: 'pg_1', memoryLimit: '536870912' });
    await client.deployPostgres('pg_1');
    expect((await client.getPostgres('pg_1')).applicationStatus).toBe('done');
  });
  it('backups', async () => {
    const b = await client.createBackup({ schedule: '3 6 * * *', prefix: 'db/my-app', destinationId: 'd1', database: 'my_app', databaseType: 'postgres', postgresId: 'pg_1', enabled: true, keepLatestCount: 35 });
    expect(b.backupId).toBe('bk_1');
    await client.manualBackup('bk_1');
    const files = await client.listBackupFiles('d1', 'pg-my-app-k3j9dq/db/my-app/');
    expect(files[0]?.ModTime).toBe('2026-09-30T06:03:01Z');
  });
  it('mints an unlimited api key', async () => {
    expect((await client.listOrganizations())[0]?.id).toBe('org_1');
    expect(await client.createApiKey({ name: 'dbm', organizationId: 'org_1' })).toBe('dbm_key');
  });
});
```

`test/fixtures/dokploy/README.md`:
```
Recorded Dokploy responses. Re-record against a live Dokploy >= 0.30 before the first e2e:
1. GET /api/settings.getOpenApiDocument  -> openapi.json (for path/param names)
2. Run each call once with curl -H 'x-api-key: ...' and save the JSON here as <router>.<procedure>.json
3. Update the MSW handlers in test/adapters/dokploy.test.ts to serve these files.
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/adapters/dokploy.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/adapters/dokploy.ts`**

```ts
import { z } from 'zod';
import { remoteError } from '../core/exit.js';
import type {
  BackupFile, BackupInput, DestinationInput, DokployClient, DokployPostgres, DokployProject,
} from './types.js';

export interface DokployClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}

const PostgresRow = z.looseObject({
  postgresId: z.string(),
  appName: z.string(),
  applicationStatus: z.enum(['idle', 'running', 'done', 'error']),
  databaseName: z.string(),
  databaseUser: z.string(),
});

const ProjectRow = z.looseObject({
  projectId: z.string(),
  name: z.string(),
  environments: z.array(
    z.looseObject({
      environmentId: z.string(),
      name: z.string(),
      postgres: z.array(z.looseObject({ postgresId: z.string(), appName: z.string(), name: z.string() })).default([]),
      compose: z.array(z.looseObject({ composeId: z.string(), appName: z.string(), name: z.string() })).default([]),
    }),
  ),
});

const DestinationRow = z.looseObject({
  destinationId: z.string(),
  name: z.string(),
  provider: z.string().nullable().default(null),
  accessKey: z.string(),
  secretAccessKey: z.string(),
  bucket: z.string(),
  region: z.string(),
  endpoint: z.string(),
  additionalFlags: z.array(z.string()).nullable().default(null),
});

const DEFAULT_TIMEOUT_MS = 30_000;
const DEPLOY_TIMEOUT_MS = 120_000;

export function makeDokployClient(o: DokployClientOptions): DokployClient {
  const fetchFn = o.fetchFn ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, '');

  async function call(proc: string, opts: { method?: 'GET' | 'POST'; query?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<unknown> {
    const method = opts.method ?? 'POST';
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
    const mult = Number(process.env.DBM_TIMEOUT_MULTIPLIER ?? '1') || 1;
    let res: Response;
    try {
      res = await fetchFn(`${base}/api/${proc}${qs}`, {
        method,
        headers: { 'x-api-key': o.apiKey, accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) * mult),
      });
    } catch (e) {
      throw remoteError(`dokploy ${proc}: ${e instanceof Error ? e.message : String(e)}`, `dokploy.${proc}`);
    }
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const msg = (json as { message?: string } | undefined)?.message ?? text || res.statusText;
      throw remoteError(`dokploy ${proc} -> HTTP ${res.status}: ${msg}`, `dokploy.${proc}`);
    }
    return json;
  }

  return {
    async getVersion() {
      const v = z.string().parse(await call('settings.getDokployVersion', { method: 'GET' }));
      return v.replace(/^v/, '');
    },
    async listOrganizations() {
      return z.array(z.looseObject({ id: z.string(), name: z.string() })).parse(await call('organization.all', { method: 'GET' }));
    },
    async createApiKey(input) {
      const r = z.looseObject({ key: z.string() }).parse(
        await call('user.createApiKey', { body: { name: input.name, metadata: { organizationId: input.organizationId }, rateLimitEnabled: false, expiresIn: null } }),
      );
      return r.key;
    },
    async listProjects() {
      return z.array(z.looseObject({ projectId: z.string(), name: z.string(), environments: z.array(z.looseObject({ environmentId: z.string(), name: z.string() })).default([]) })).parse(
        await call('project.all', { method: 'GET' }),
      );
    },
    async createProject(name) {
      const r = z.looseObject({ project: z.looseObject({ projectId: z.string() }), environment: z.looseObject({ environmentId: z.string() }) }).parse(
        await call('project.create', { body: { name, description: 'Managed by dbm' } }),
      );
      return { projectId: r.project.projectId, environmentId: r.environment.environmentId };
    },
    async getProject(projectId) {
      return ProjectRow.parse(await call('project.one', { method: 'GET', query: { projectId } })) as DokployProject;
    },
    async createPostgres(input) {
      return PostgresRow.parse(await call('postgres.create', { body: input })) as DokployPostgres;
    },
    async updatePostgres(input) {
      await call('postgres.update', { body: input });
    },
    async deployPostgres(postgresId) {
      await call('postgres.deploy', { body: { postgresId }, timeoutMs: DEPLOY_TIMEOUT_MS });
    },
    async getPostgres(postgresId) {
      return PostgresRow.parse(await call('postgres.one', { method: 'GET', query: { postgresId } })) as DokployPostgres;
    },
    async stopPostgres(postgresId) {
      await call('postgres.stop', { body: { postgresId } });
    },
    async startPostgres(postgresId) {
      await call('postgres.start', { body: { postgresId } });
    },
    async removePostgres(postgresId) {
      await call('postgres.remove', { body: { postgresId } });
    },
    async createCompose(input) {
      return z.looseObject({ composeId: z.string(), appName: z.string() }).parse(
        await call('compose.create', { body: { ...input, composeType: 'docker-compose', sourceType: 'raw' } }),
      );
    },
    async updateCompose(input) {
      await call('compose.update', { body: { ...input, sourceType: 'raw', composeType: 'docker-compose' } });
    },
    async deployCompose(composeId) {
      await call('compose.deploy', { body: { composeId }, timeoutMs: DEPLOY_TIMEOUT_MS });
    },
    async getCompose(composeId) {
      return z.looseObject({ composeId: z.string(), appName: z.string(), composeStatus: z.string().default('idle') }).parse(
        await call('compose.one', { method: 'GET', query: { composeId } }),
      );
    },
    async createDestination(input: DestinationInput) {
      return z.looseObject({ destinationId: z.string() }).parse(await call('destination.create', { body: input }));
    },
    async testDestination(input: DestinationInput) {
      await call('destination.testConnection', { body: input, timeoutMs: 60_000 });
    },
    async getDestination(destinationId) {
      return DestinationRow.parse(await call('destination.one', { method: 'GET', query: { destinationId } }));
    },
    async createBackup(input: BackupInput) {
      return z.looseObject({ backupId: z.string() }).parse(await call('backup.create', { body: { ...input, backupType: 'database' } }));
    },
    async updateBackup(input) {
      await call('backup.update', { body: { ...input, backupType: 'database' } });
    },
    async removeBackup(backupId) {
      await call('backup.remove', { body: { backupId } });
    },
    async manualBackup(backupId) {
      await call('backup.manualBackupPostgres', { body: { backupId }, timeoutMs: 30 * 60_000 });
    },
    async listBackupFiles(destinationId, search) {
      return z.array(z.looseObject({ Path: z.string(), Name: z.string(), Size: z.number(), ModTime: z.string() })).parse(
        await call('backup.listBackupFiles', { method: 'GET', query: { destinationId, search } }),
      ) as BackupFile[];
    },
  };
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run --project unit test/adapters/dokploy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/dokploy.ts test/adapters/dokploy.test.ts test/fixtures/dokploy/README.md
git commit -m "feat(adapters): dokploy REST client with zod-validated responses and MSW tests"
```

---

## Phase D — Integration harness

### Task 12: docker compose stack and the integration test that proves the design

**Spec:** 15 (integration row), 19 (items 6 and 7). This test is the acceptance check for the two assumptions the architecture rests on: prepared statements and `drizzle-kit push` through PgBouncer, and Garage's admin v2 + presigned URLs with the template `S3Client` config.

**Files:**
- Create: `test/compose/compose.yaml`, `test/compose/garage/garage.toml` (rendered at setup), `test/compose/pgbouncer/` (rendered at setup), `test/compose/certs/` (generated at setup), `test/integration/global-setup.ts`, `test/integration/stack.test.ts`, `test/integration/testcfg.ts`
- Modify: `.gitignore` (add `test/compose/pgbouncer/`, `test/compose/certs/`, `test/compose/garage/garage.toml`)

- [ ] **Step 1: Write compose.yaml**

`test/compose/compose.yaml`:
```yaml
services:
  pg:
    image: postgres:18
    container_name: dbm-test-pg
    environment:
      POSTGRES_USER: test_admin
      POSTGRES_PASSWORD: adminpw
      POSTGRES_DB: test_db
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U test_admin -d test_db"]
      interval: 2s
      timeout: 3s
      retries: 30
    networks: [dbmtest]
  pgbouncer:
    image: edoburu/pgbouncer:v1.26.0-p0
    container_name: dbm-test-pgbouncer
    ports: ["127.0.0.1:56432:6432"]
    volumes:
      - ./pgbouncer:/etc/pgbouncer:ro
      - ./certs:/certs:ro
    depends_on:
      pg: { condition: service_healthy }
    networks: [dbmtest]
  garage:
    image: dxflrs/garage:v2.4.1
    container_name: dbm-test-garage
    entrypoint: ["/garage"]
    command: ["server", "--single-node"]
    environment:
      GARAGE_RPC_SECRET: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      GARAGE_ADMIN_TOKEN: testadmintoken
    ports:
      - "127.0.0.1:53900:3900"
      - "127.0.0.1:53903:3903"
    volumes:
      - ./garage/garage.toml:/etc/garage.toml:ro
    networks: [dbmtest]
networks:
  dbmtest:
    name: dbmtest
```

- [ ] **Step 2: Write testcfg.ts and global-setup.ts**

`test/integration/testcfg.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLocalRunner } from '../../src/adapters/ssh.js';
import { type Config, ConfigSchema } from '../../src/core/config.js';

export const COMPOSE_DIR = join(process.cwd(), 'test', 'compose');
export const CERT_DIR = join(COMPOSE_DIR, 'certs', 'db.test.local');

export const testConfig: Config = ConfigSchema.parse({
  sshHost: 'localhost',
  dokployUrl: 'https://dokploy.test',
  dokployApiKey: 'tok',
  dokployProjectId: 'proj_1',
  dokployEnvironmentId: 'env_1',
  domain: 'test.local',
  dbHost: 'localhost',
  s3Host: 'localhost:53900',
  webDomain: 'web.test.local',
  garageAdminToken: 'testadmintoken',
  garageBackupKeyId: 'GKbackup',
  dumpsDestinationId: 'd1',
  tls: 'self-ca',
  remote: {
    pgbouncerConfDir: '/etc/dokploy/dbm/pgbouncer',
    certsDir: '/etc/dokploy/dbm/certs',
    garageConfDir: '/etc/dokploy/dbm/garage',
    rcloneConfDir: '/etc/dokploy/dbm/rclone',
    traefikDynamicDir: '/etc/dokploy/traefik/dynamic',
    dockerNetwork: 'dbmtest',
    pgbouncerContainer: 'dbm-test-pgbouncer',
    garageContainer: 'dbm-test-garage',
    garageAdminPort: 53903,
    dbPort: 56432,
  },
});

/** Maps the spec's remote paths onto test/compose so the real upload code writes where compose mounts. */
export function mapTestPath(remote: string): string {
  return remote.replace(/^\/etc\/dokploy\/dbm\//, `${COMPOSE_DIR}/`).replace(/^\/etc\/dokploy\/traefik\/dynamic\//, `${COMPOSE_DIR}/traefik/`);
}

export const testRunner = makeLocalRunner({ mapPath: mapTestPath });

export function caPem(): string {
  return readFileSync(join(CERT_DIR, 'certificate.crt'), 'utf8');
}
```

`test/integration/global-setup.ts`:
```ts
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
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
    '-keyout', join(CERT_DIR, 'privatekey.key'), '-out', join(CERT_DIR, 'certificate.crt'),
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  await execa('chmod', ['644', join(CERT_DIR, 'privatekey.key'), join(CERT_DIR, 'certificate.crt')]);
  await writeFile(join(COMPOSE_DIR, 'pgbouncer', 'pgbouncer.ini'), renderPgbouncerIni([], { certDir: '/certs/db.test.local' }));
  await writeFile(join(COMPOSE_DIR, 'pgbouncer', 'userlist.txt'), renderUserlist([]));
  await writeFile(join(COMPOSE_DIR, 'garage', 'garage.toml'), renderGarageToml({ webDomain: 'web.test.local' }));
  await execa('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '180'], { stdio: 'inherit' });
  return async () => {
    if (process.env.DBM_TEST_KEEP !== '1') {
      await execa('docker', [...compose, 'down', '-v', '--remove-orphans', '-t', '5'], { stdio: 'inherit' });
    }
  };
}
```

- [ ] **Step 3: Write the integration test**

`test/integration/stack.test.ts`:
```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { execa } from 'execa';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeGarageAdmin } from '../../src/adapters/garage.js';
import { makePostgresAdmin } from '../../src/adapters/postgres.js';
import { renderPgbouncerIni, renderUserlist } from '../../src/core/pgbouncer.js';
import { scramSha256Verifier } from '../../src/core/scram.js';
import { createDatabaseSql, createRoleSql, extensionsSql } from '../../src/core/sql.js';
import type { Project } from '../../src/core/state.js';
import { caPem, testConfig, testRunner } from './testcfg.js';

const admin = { appName: 'dbm-test-pg', role: 'test_admin', database: 'test_db' };
const APP_PW = 'correct-horse-battery-staple';
const pgAdmin = makePostgresAdmin(testRunner, { network: 'dbmtest', clientImage: 'postgres:18' });
const garage = makeGarageAdmin(testRunner, { port: 53903, token: 'testadmintoken' });

function project(verifier: string): Project {
  return {
    slug: 'my-app', createdAt: new Date().toISOString(), status: 'running', pgMajor: 18,
    dokploy: { postgresId: 'pg_1', appName: 'dbm-test-pg' },
    postgres: { database: 'my_app', appRole: 'my_app_app', appPassword: APP_PW, appScramVerifier: verifier, adminRole: 'test_admin', adminPassword: 'adminpw', extensions: ['pgcrypto', 'uuid-ossp'], memoryBytes: 536870912 },
    betterAuthSecret: 'x',
  };
}

async function client(database: string) {
  const c = new pg.Client({ host: '127.0.0.1', port: 56432, user: 'my_app_app', password: APP_PW, database, ssl: { ca: caPem(), servername: 'localhost' } });
  await c.connect();
  return c;
}

async function waitFor(fn: () => Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('timeout waiting');
}

describe('postgres + pgbouncer', () => {
  let verifier: string;
  beforeAll(async () => {
    await waitFor(() => pgAdmin.ping(admin));
    verifier = scramSha256Verifier(APP_PW);
    await pgAdmin.runSql(admin, `${createRoleSql('my_app_app', verifier)}\n${createDatabaseSql('my_app', 'my_app_app')}`);
    await pgAdmin.runSql({ ...admin, database: 'my_app' }, extensionsSql(['pgcrypto', 'uuid-ossp']));
    const p = project(verifier);
    await testRunner.upload(`${testConfig.remote.pgbouncerConfDir}/pgbouncer.ini`, renderPgbouncerIni([p], { certDir: '/certs/db.test.local' }), { mode: '0644' });
    await testRunner.upload(`${testConfig.remote.pgbouncerConfDir}/userlist.txt`, renderUserlist([p]), { mode: '0644' });
    await testRunner.run(['docker', 'kill', '-s', 'HUP', testConfig.remote.pgbouncerContainer]);
    await new Promise((r) => setTimeout(r, 500));
  });

  it('logs in through PgBouncer with SCRAM + TLS using the locally computed verifier, transaction mode', async () => {
    const c = await client('my-app');
    expect((await c.query('select 1 as n')).rows[0]).toEqual({ n: 1 });
    expect((await c.query("select current_database() as d")).rows[0]).toEqual({ d: 'my_app' });
    await c.end();
  });

  it('protocol-level prepared statements work in transaction mode (max_prepared_statements=200)', async () => {
    const c = await client('my-app');
    for (let i = 0; i < 5; i++) {
      const r = await c.query({ name: 'q1', text: 'select $1::int as n', values: [i] });
      expect(r.rows[0]).toEqual({ n: i });
    }
    await c.end();
  });

  it('session alias routes to the same database in session mode', async () => {
    const c = await client('my-app_session');
    expect((await c.query("select current_database() as d")).rows[0]).toEqual({ d: 'my_app' });
    await c.end();
  });

  it('pingViaPgbouncer from inside the docker network', async () => {
    expect(await pgAdmin.pingViaPgbouncer(`postgresql://my_app_app:${APP_PW}@dbm-test-pgbouncer:6432/my-app?sslmode=require`)).toBe(true);
  });

  it('drizzle-kit push works through the session alias', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dbm-drizzle-'));
    await writeFile(join(dir, 'schema.ts'), `import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
export const notes = pgTable('notes', { id: uuid('id').primaryKey().defaultRandom(), body: text('body').notNull() });
`);
    await writeFile(join(dir, 'ca.pem'), caPem());
    await writeFile(join(dir, 'drizzle.config.ts'), `import { readFileSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: '${join(dir, 'schema.ts')}',
  out: '${join(dir, 'out')}',
  dbCredentials: { host: '127.0.0.1', port: 56432, user: 'my_app_app', password: '${APP_PW}', database: 'my-app_session',
    ssl: { ca: readFileSync('${join(dir, 'ca.pem')}', 'utf8'), servername: 'localhost' } },
});
`);
    const r = await execa('npx', ['drizzle-kit', 'push', '--force', '--config', join(dir, 'drizzle.config.ts')], { reject: false, cwd: process.cwd() });
    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
    const c = await client('my-app');
    expect((await c.query("select to_regclass('public.notes') as t")).rows[0]).toEqual({ t: 'notes' });
    await c.end();
  });
});

describe('garage', () => {
  let s3: S3Client;
  let bucketId = '';
  let keyId = '';

  beforeAll(async () => {
    await waitFor(() => garage.health(), 120_000);
  });

  it('creates bucket, key, permissions and CORS through admin v2', async () => {
    const b = await garage.createBucket('my-app');
    bucketId = b.id;
    const k = await garage.createKey('my-app-key');
    keyId = k.accessKeyId;
    await garage.allowBucketKey(bucketId, keyId, { read: true, write: true });
    // Section 19 item 7: if this call fails with a schema error, read components.schemas in
    // https://garagehq.deuxfleurs.fr/api/garage-admin-v2.json and fix the key casing in GarageCorsRule.
    await garage.updateBucket(bucketId, { corsRules: [{ allowedOrigins: ['*'], allowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'], allowedHeaders: ['*'], exposeHeaders: ['ETag'], maxAgeSeconds: 3600 }] });
    const info = await garage.getBucket({ globalAlias: 'my-app' });
    expect(info?.id).toBe(bucketId);
    // Same settings as templates/nextjs/lib/s3.ts, constructed once the key exists.
    s3 = new S3Client({
      endpoint: 'http://127.0.0.1:53900', region: 'garage', forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: { accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey },
    });
  });

  it('presigned PUT and GET with the template S3Client settings', async () => {
    const put = await getSignedUrl(s3, new PutObjectCommand({ Bucket: 'my-app', Key: 'hello.txt', ContentType: 'text/plain' }), { expiresIn: 300 });
    const r1 = await fetch(put, { method: 'PUT', body: 'hello garage', headers: { 'content-type': 'text/plain' } });
    expect(r1.status, await r1.text()).toBe(200);
    const get = await getSignedUrl(s3, new GetObjectCommand({ Bucket: 'my-app', Key: 'hello.txt' }), { expiresIn: 300 });
    const r2 = await fetch(get);
    expect(await r2.text()).toBe('hello garage');
    const pre = await fetch(put, { method: 'OPTIONS', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'PUT' } });
    expect(pre.headers.get('access-control-allow-origin')).toBeTruthy();
  });

  it('empties and deletes the bucket, then the key', async () => {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: 'my-app' }));
    for (const o of list.Contents ?? []) await s3.send(new DeleteObjectCommand({ Bucket: 'my-app', Key: o.Key ?? '' }));
    await garage.cleanupIncompleteUploads(bucketId);
    await garage.deleteBucket(bucketId);
    await garage.deleteKey(keyId);
    expect(await garage.getBucket({ globalAlias: 'my-app' })).toBeUndefined();
  });
});
```

- [ ] **Step 4: Add generated paths to .gitignore and run**

Append to `.gitignore`:
```
test/compose/pgbouncer/
test/compose/certs/
test/compose/garage/garage.toml
test/compose/traefik/
```

Run: `npm run test:integration`
Expected: all tests pass. Known places that may need adjustment on first run, each is a Section 19 verification, not a plan defect:
- Garage `corsRules` casing → fix `GarageCorsRule` in `types.ts` and the adapter, re-run.
- If `drizzle-kit push` fails through the session alias, capture the error in `docs/runbook.md` and open the `dbm tunnel` future-work item; do not weaken the test.
- `pingViaPgbouncer` uses `sslmode=require` only because the throwaway psql container has no CA; production connection strings still use `verify-full`.

- [ ] **Step 5: Commit**

```bash
git add test/compose/compose.yaml test/integration .gitignore
git commit -m "test: integration stack (postgres 18, pgbouncer 1.26, garage 2.4.1) proving SCRAM, prepared statements, drizzle-kit push, presigned URLs"
```

---

## Phase E — Commands

Every command in this phase is a plain async function `xCommand(deps: Deps, options): Promise<Result>` in `src/commands/<x>.ts`, registered in `src/cli.ts`. Human progress lines go to `deps.io.err` (so `--json` stdout stays clean). Unit tests drive commands against the in-memory fakes from Task 13 and assert adapter calls, state changes, rollback, and exit codes.

Deviation recorded here: Dokploy's `databaseName` for every project is `postgres` (the maintenance database created by the image). `dbm` then creates `<slug_db>` itself owned by the app role. This avoids "database already exists" and keeps the superuser's default database separate from app data. The backup schedule still dumps `<slug_db>`.

### Task 13: Deps context, fakes, CLI wiring, `create` with rollback

**Spec:** 5.6, 7 (`create`), 14. **Review Focus 2 and 3.**

**Files:**
- Create: `src/commands/context.ts`, `src/commands/pgbouncer-apply.ts`, `src/commands/create.ts`, `test/helpers/fakes.ts`, `test/commands/create.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces:

```ts
// src/commands/context.ts
export interface Deps {
  cfg: Config; store: StateStore; dokploy: DokployClient; ssh: SshRunner; pg: PostgresAdmin; garage: GarageAdmin;
  io: Io; sleep: (ms: number) => Promise<void>; now: () => Date;
  confirm: (prompt: string, expected: string) => Promise<boolean>;
}
export async function makeDeps(store: StateStore, io: Io): Promise<Deps>;   // real adapters from config
export function adminTarget(p: Project, database?: string): PgTarget;       // { appName, role: adminRole, database: database ?? 'postgres' }
export async function waitUntil(fn, opts: { timeoutMs; intervalMs; sleep; what }): Promise<void>; // throws remoteError on timeout
// src/commands/pgbouncer-apply.ts
export async function applyPgbouncer(deps: Deps, state: State): Promise<void>;
// src/commands/create.ts
export interface CreateOptions { slug: string; memory?: string; pg?: 17 | 18; extensions?: string[]; storage?: boolean; corsOrigins?: string[] }
export interface CreateResult { project: Project; env: Record<string, string>; existed: boolean }
export async function createCommand(deps: Deps, o: CreateOptions): Promise<CreateResult>;
```

- [ ] **Step 1: Write the fakes**

`test/helpers/fakes.ts`:
```ts
import type { Io } from '../../src/cli.js';
import type { InitProgress, StateStore } from '../../src/adapters/store.js';
import type {
  BackupFile, BackupInput, DestinationInput, DokployClient, DokployPostgres, DokployProject, GarageAdmin,
  GarageBucketInfo, PgTarget, PostgresAdmin, PostgresStatus,
} from '../../src/adapters/types.js';
import { type Config, type ConfigInput, ConfigSchema } from '../../src/core/config.js';
import { DbmError, ExitCode } from '../../src/core/exit.js';
import { type State, emptyState } from '../../src/core/state.js';
import type { Deps } from '../../src/commands/context.js';
import { makeFakeRunner } from './fake-runner.js';

export const testConfigInput: ConfigInput = {
  sshHost: 'vps', dokployUrl: 'https://vps.tail.ts.net', dokployApiKey: 'k', dokployProjectId: 'proj_1',
  dokployEnvironmentId: 'env_1', domain: 'example.com', dbHost: 'db.example.com', s3Host: 's3.example.com',
  webDomain: 'web.example.com', garageAdminToken: 't', garageBackupKeyId: 'GKbackup', dumpsDestinationId: 'd1',
};

export function fail(step: string, msg = 'boom'): never {
  throw new DbmError(msg, ExitCode.RemoteFailure, step);
}

export class FakeDokploy implements DokployClient {
  calls: string[] = [];
  postgres = new Map<string, DokployPostgres & { status: PostgresStatus; volumeExists: boolean; running: boolean }>();
  backups = new Map<string, BackupInput>();
  files: BackupFile[] = [];
  existingNames = new Set<string>();
  failAt = new Set<string>();
  deploysUntilDone = 1;
  private n = 0;
  private guard(step: string) {
    this.calls.push(step);
    if (this.failAt.has(step)) fail(`dokploy.${step}`);
  }
  async getVersion() { this.guard('getVersion'); return '0.30.8'; }
  async listOrganizations() { this.guard('listOrganizations'); return [{ id: 'org_1', name: 'Personal' }]; }
  projects: Array<{ projectId: string; name: string; environments: Array<{ environmentId: string; name: string }> }> = [];
  async listProjects() { this.guard('listProjects'); return this.projects; }
  async createApiKey() { this.guard('createApiKey'); return 'newkey'; }
  async createProject() { this.guard('createProject'); return { projectId: 'proj_1', environmentId: 'env_1' }; }
  async getProject(): Promise<DokployProject> {
    this.guard('getProject');
    return { projectId: 'proj_1', name: 'dbm', environments: [{ environmentId: 'env_1', name: 'production',
      postgres: [...this.postgres.values()].map((p) => ({ postgresId: p.postgresId, appName: p.appName, name: p.appName.replace(/-[a-z0-9]{6}$/, '') }))
        .concat([...this.existingNames].map((n) => ({ postgresId: `x_${n}`, appName: `${n}-zzzzzz`, name: n }))),
      compose: [] }] };
  }
  async createPostgres(input: { name: string; appName: string; databaseName: string; databaseUser: string; databasePassword: string }) {
    this.guard('createPostgres');
    if (!/^[A-Za-z0-9]+$/.test(input.databasePassword)) fail('dokploy.createPostgres', 'Invalid password');
    if (this.existingNames.has(input.name)) fail('dokploy.createPostgres', 'CONFLICT: appName exists');
    const row = { postgresId: `pg_${++this.n}`, appName: `${input.appName}-abc123`, applicationStatus: 'idle' as const,
      databaseName: input.databaseName, databaseUser: input.databaseUser, status: 'idle' as PostgresStatus, volumeExists: true, running: true };
    this.postgres.set(row.postgresId, row);
    return row;
  }
  async updatePostgres() { this.guard('updatePostgres'); }
  async deployPostgres(id: string) { this.guard('deployPostgres'); const p = this.postgres.get(id); if (p) p.status = 'done'; }
  async getPostgres(id: string) { this.guard('getPostgres'); const p = this.postgres.get(id); if (!p) fail('dokploy.getPostgres', 'not found'); return { ...p, applicationStatus: p.status }; }
  async stopPostgres(id: string) { this.guard('stopPostgres'); const p = this.postgres.get(id); if (p) p.running = false; }
  async startPostgres(id: string) { this.guard('startPostgres'); const p = this.postgres.get(id); if (p) p.running = true; }
  async removePostgres(id: string) { this.guard('removePostgres'); this.postgres.delete(id); }
  async createCompose() { this.guard('createCompose'); return { composeId: 'c1', appName: 'dbm-x' }; }
  async updateCompose() { this.guard('updateCompose'); }
  async deployCompose() { this.guard('deployCompose'); }
  async getCompose() { this.guard('getCompose'); return { composeId: 'c1', appName: 'dbm-x', composeStatus: 'done' }; }
  async createDestination() { this.guard('createDestination'); return { destinationId: 'd1' }; }
  async testDestination() { this.guard('testDestination'); }
  async getDestination(): Promise<DestinationInput & { destinationId: string }> {
    this.guard('getDestination');
    return { destinationId: 'd1', name: 'dumps', provider: 'Other', accessKey: 'AK', secretAccessKey: 'SK', bucket: 'dumps', region: 'us-west-004', endpoint: 'https://s3.us-west-004.backblazeb2.com', additionalFlags: null };
  }
  async createBackup(input: BackupInput) { this.guard('createBackup'); const id = `bk_${this.backups.size + 1}`; this.backups.set(id, input); return { backupId: id }; }
  async updateBackup(input: BackupInput & { backupId: string }) { this.guard('updateBackup'); this.backups.set(input.backupId, input); }
  async removeBackup(id: string) { this.guard('removeBackup'); this.backups.delete(id); }
  async manualBackup() { this.guard('manualBackup'); }
  async listBackupFiles() { this.guard('listBackupFiles'); return this.files; }
}

export class FakePg implements PostgresAdmin {
  sql: Array<{ target: PgTarget; sql: string }> = [];
  pingResults: boolean[] = [];
  pgbouncerPing = true;
  failAt = new Set<string>();
  async findContainer(appName: string) { return `c_${appName}`; }
  async runSql(target: PgTarget, sql: string) {
    if (this.failAt.has('runSql')) fail('postgres.runSql');
    this.sql.push({ target, sql });
    return '';
  }
  async ping() { return this.pingResults.length ? (this.pingResults.shift() as boolean) : true; }
  async pingViaPgbouncer() { return this.pgbouncerPing; }
}

export class FakeGarage implements GarageAdmin {
  calls: string[] = [];
  buckets = new Map<string, GarageBucketInfo & { objects: number }>();
  keys = new Map<string, { name: string }>();
  failAt = new Set<string>();
  private n = 0;
  private guard(step: string) { this.calls.push(step); if (this.failAt.has(step)) fail(`garage.${step}`); }
  async health() { this.guard('health'); return true; }
  async createBucket(alias: string) {
    this.guard('createBucket');
    const b = { id: `b_${++this.n}`, globalAliases: [alias], bytes: 0, objects: 0, unfinishedUploads: 0, websiteAccess: false };
    this.buckets.set(b.id, b);
    return b;
  }
  async getBucket(q: { id?: string; globalAlias?: string }) {
    this.guard('getBucket');
    return [...this.buckets.values()].find((b) => b.id === q.id || b.globalAliases.includes(q.globalAlias ?? '\0'));
  }
  async listBuckets() { this.guard('listBuckets'); return [...this.buckets.values()]; }
  async createKey(name: string) { this.guard('createKey'); const id = `GK${++this.n}`; this.keys.set(id, { name }); return { accessKeyId: id, secretAccessKey: `S${id}` }; }
  async allowBucketKey() { this.guard('allowBucketKey'); }
  async denyBucketKey() { this.guard('denyBucketKey'); }
  async updateBucket(id: string, patch: { websiteAccess?: { enabled: boolean } }) {
    this.guard('updateBucket');
    const b = this.buckets.get(id);
    if (b && patch.websiteAccess) b.websiteAccess = patch.websiteAccess.enabled;
  }
  async addBucketAlias() { this.guard('addBucketAlias'); }
  async removeBucketAlias() { this.guard('removeBucketAlias'); }
  async deleteKey(id: string) { this.guard('deleteKey'); this.keys.delete(id); }
  async deleteBucket(id: string) {
    this.guard('deleteBucket');
    const b = this.buckets.get(id);
    if (b && b.objects > 0) fail('garage.deleteBucket', 'Bucket is not empty');
    this.buckets.delete(id);
  }
  async cleanupIncompleteUploads() { this.guard('cleanupIncompleteUploads'); }
  async createAdminToken() { this.guard('createAdminToken'); return { secretToken: 'scoped' }; }
}

export class MemoryStore implements StateStore {
  readonly dir = '/mem/.dbm';
  config: Config | undefined;
  state: State = emptyState();
  saves = 0;
  progress: InitProgress = { done: {}, values: {} };
  constructor(cfg?: ConfigInput) { if (cfg) this.config = ConfigSchema.parse(cfg); }
  async loadConfig() { return this.config; }
  async saveConfig(c: ConfigInput) { this.config = ConfigSchema.parse(c); return this.config; }
  async requireConfig() { if (!this.config) throw new DbmError('no config', ExitCode.UserError, 'config'); return this.config; }
  async loadState() { return structuredClone(this.state); }
  async saveState(s: State) { this.saves++; this.state = structuredClone(s); }
  async loadInitProgress() { return structuredClone(this.progress); }
  async saveInitProgress(p: InitProgress) { this.progress = structuredClone(p); }
}

export function makeTestDeps(over: Partial<Deps> & { runner?: ReturnType<typeof makeFakeRunner> } = {}) {
  const store = (over.store as MemoryStore | undefined) ?? new MemoryStore(testConfigInput);
  const dokploy = (over.dokploy as FakeDokploy | undefined) ?? new FakeDokploy();
  const pg = (over.pg as FakePg | undefined) ?? new FakePg();
  const garage = (over.garage as FakeGarage | undefined) ?? new FakeGarage();
  const runner = over.runner ?? makeFakeRunner([]);
  const outLines: string[] = [];
  const errLines: string[] = [];
  const io: Io = { out: (s) => { outLines.push(s); }, err: (s) => { errLines.push(s); } };
  const deps: Deps = {
    cfg: ConfigSchema.parse(testConfigInput), store, dokploy, ssh: runner.runner, pg, garage, io,
    sleep: async () => {}, now: () => new Date('2026-09-30T12:00:00.000Z'), confirm: async () => true,
    ...over,
  };
  return { deps, store, dokploy, pg, garage, runner, outLines, errLines };
}
```

- [ ] **Step 2: Write the failing tests for create**

`test/commands/create.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createCommand } from '../../src/commands/create.js';
import { DbmError } from '../../src/core/exit.js';
import { upsertProject } from '../../src/core/state.js';
import { fakeProject } from '../unit/state.test.js';
import { FakeDokploy, FakeGarage, makeTestDeps } from '../helpers/fakes.js';

describe('createCommand', () => {
  it('provisions postgres, pgbouncer, garage, backup; prints env; saves running state', async () => {
    const t = makeTestDeps();
    const r = await createCommand(t.deps, { slug: 'my-app', memory: '512m' });
    expect(r.existed).toBe(false);
    expect(r.env.DATABASE_URL).toMatch(/^postgresql:\/\/my_app_app:[A-Za-z0-9_-]{43}@db\.example\.com:6432\/my-app\?sslmode=verify-full$/);
    expect(r.env.S3_BUCKET).toBe('my-app');
    expect(t.dokploy.calls).toEqual([
      'getProject', 'createPostgres', 'updatePostgres', 'deployPostgres', 'getPostgres',
      'deployPostgres', 'getPostgres', 'createBackup',
    ]);
    const created = [...t.dokploy.postgres.values()][0];
    expect(created?.databaseName).toBe('postgres');
    expect(created?.databaseUser).toBe('my_app_admin');
    expect(t.pg.sql.map((s) => s.sql).join('\n')).toMatch(/CREATE ROLE "my_app_app" LOGIN NOSUPERUSER .* PASSWORD 'SCRAM-SHA-256\$4096:/);
    expect(t.pg.sql.map((s) => s.sql).join('\n')).toContain('CREATE DATABASE "my_app" OWNER "my_app_app";');
    expect(t.pg.sql.map((s) => s.sql).join('\n')).toContain('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
    expect(t.pg.sql.map((s) => s.sql).join('\n')).toContain("ALTER SYSTEM SET shared_buffers = '128MB';");
    expect(t.runner.uploads.map((u) => u.path)).toEqual([
      '/etc/dokploy/dbm/pgbouncer/pgbouncer.ini', '/etc/dokploy/dbm/pgbouncer/userlist.txt',
    ]);
    expect(t.runner.uploads[0]?.content).toContain('my-app = host=pg-my-app-abc123 port=5432 dbname=my_app');
    expect(t.runner.calls.map((c) => c.argv.join(' '))).toContain('docker kill -s HUP dbm-pgbouncer');
    expect(t.garage.calls).toEqual(['createBucket', 'createKey', 'allowBucketKey', 'allowBucketKey', 'updateBucket']);
    const backup = [...t.dokploy.backups.values()][0];
    expect(backup).toMatchObject({ prefix: 'db/my-app', database: 'my_app', keepLatestCount: 35, enabled: true, databaseType: 'postgres' });
    expect(backup?.schedule).toMatch(/^\d+ 6 \* \* \*$/);
    const saved = t.store.state.projects['my-app'];
    expect(saved?.status).toBe('running');
    expect(saved?.postgres.memoryBytes).toBe(536870912);
    expect(saved?.dokploy.backupId).toBe('bk_1');
    expect(saved?.storage?.bucketId).toBe('b_1');
    expect(t.outLines.join('')).toBe('');
  });

  it('re-running on an existing slug is a no-op with zero adapter calls (Review Focus 2)', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    const r = await createCommand(t.deps, { slug: 'my-app' });
    expect(r.existed).toBe(true);
    expect(t.dokploy.calls).toEqual([]);
    expect(t.garage.calls).toEqual([]);
    expect(t.store.saves).toBe(0);
  });

  it('refuses when the service exists in Dokploy but not in state', async () => {
    const t = makeTestDeps();
    t.dokploy.existingNames.add('pg-my-app');
    await expect(createCommand(t.deps, { slug: 'my-app' })).rejects.toMatchObject({ exitCode: 1, message: /exists in Dokploy/ });
    expect(t.dokploy.calls).toEqual(['getProject']);
  });

  it('a 409 on createPostgres fails cleanly with no rollback work (Review Focus 3)', async () => {
    const dokploy = new FakeDokploy();
    dokploy.failAt.add('createPostgres');
    const t = makeTestDeps({ dokploy });
    await expect(createCommand(t.deps, { slug: 'my-app' })).rejects.toMatchObject({ exitCode: 2, step: 'dokploy.createPostgres' });
    expect(t.dokploy.calls).toEqual(['getProject', 'createPostgres']);
    expect(t.runner.uploads).toEqual([]);
    expect(t.store.state.projects['my-app']).toBeUndefined();
  });

  it('a failure at garage.createKey rolls back postgres, volume, pgbouncer entry and bucket', async () => {
    const garage = new FakeGarage();
    garage.failAt.add('createKey');
    const t = makeTestDeps({ garage });
    await expect(createCommand(t.deps, { slug: 'my-app' })).rejects.toMatchObject({ exitCode: 2, step: 'garage.createKey' });
    expect(t.dokploy.calls).toContain('removePostgres');
    expect(t.runner.calls.map((c) => c.argv.join(' '))).toContain('docker volume rm pg-my-app-abc123-data');
    expect(t.garage.calls.filter((c) => c === 'deleteBucket')).toHaveLength(1);
    expect(t.garage.buckets.size).toBe(0);
    // pgbouncer re-rendered without the project
    const lastIni = t.runner.uploads.filter((u) => u.path.endsWith('pgbouncer.ini')).at(-1);
    expect(lastIni?.content).not.toContain('my-app');
    expect(t.store.state.projects['my-app']).toBeUndefined();
  });

  it('if rollback itself fails, exit code is 3 and leftovers are listed', async () => {
    const garage = new FakeGarage();
    garage.failAt.add('createKey');
    const dokploy = new FakeDokploy();
    dokploy.failAt.add('removePostgres');
    const t = makeTestDeps({ garage, dokploy });
    const err = await createCommand(t.deps, { slug: 'my-app' }).catch((e: unknown) => e as DbmError);
    expect(err).toBeInstanceOf(DbmError);
    expect((err as DbmError).exitCode).toBe(3);
    expect((err as DbmError).message).toMatch(/leftover/i);
    expect((err as DbmError).message).toContain('pg-my-app-abc123');
  });

  it('--no-storage skips garage, --pg 17 pins the image, invalid extension is a user error', async () => {
    const t = makeTestDeps();
    const r = await createCommand(t.deps, { slug: 'a1', storage: false, pg: 17 });
    expect(r.env.S3_BUCKET).toBeUndefined();
    expect(t.garage.calls).toEqual([]);
    expect(t.store.state.projects.a1?.pgMajor).toBe(17);
    await expect(createCommand(t.deps, { slug: 'a2', extensions: ['x;y'] })).rejects.toMatchObject({ exitCode: 1 });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run --project unit test/commands/create.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement context, pgbouncer-apply, create**

`src/commands/context.ts`:
```ts
import type { Io } from '../cli.js';
import { makeDokployClient } from '../adapters/dokploy.js';
import { makeGarageAdmin } from '../adapters/garage.js';
import { makePostgresAdmin } from '../adapters/postgres.js';
import { makeSshRunner } from '../adapters/ssh.js';
import type { StateStore } from '../adapters/store.js';
import type { DokployClient, GarageAdmin, PgTarget, PostgresAdmin, SshRunner } from '../adapters/types.js';
import { IMAGES } from '../core/compose.js';
import type { Config } from '../core/config.js';
import { remoteError } from '../core/exit.js';
import type { Project } from '../core/state.js';

export interface Deps {
  cfg: Config;
  store: StateStore;
  dokploy: DokployClient;
  ssh: SshRunner;
  pg: PostgresAdmin;
  garage: GarageAdmin;
  io: Io;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  confirm: (prompt: string, expected: string) => Promise<boolean>;
}

export async function confirmOnTty(prompt: string, expected: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${prompt} Type ${expected} to continue: `);
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}

export function makeDepsFromConfig(cfg: Config, store: StateStore, io: Io): Deps {
  const ssh = makeSshRunner({ host: cfg.sshHost, user: cfg.sshUser });
  return {
    cfg,
    store,
    dokploy: makeDokployClient({ baseUrl: cfg.dokployUrl, apiKey: cfg.dokployApiKey }),
    ssh,
    pg: makePostgresAdmin(ssh, { network: cfg.remote.dockerNetwork, clientImage: IMAGES.postgres18 }),
    garage: makeGarageAdmin(ssh, { port: cfg.remote.garageAdminPort, token: cfg.garageAdminToken }),
    io,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    confirm: confirmOnTty,
  };
}

export async function makeDeps(store: StateStore, io: Io): Promise<Deps> {
  return makeDepsFromConfig(await store.requireConfig(), store, io);
}

export function adminTarget(p: Project, database = 'postgres'): PgTarget {
  return { appName: p.dokploy.appName, role: p.postgres.adminRole, database };
}

export function appTarget(p: Project): PgTarget {
  return { appName: p.dokploy.appName, role: p.postgres.appRole, database: p.postgres.database };
}

export async function waitUntil(
  fn: () => Promise<boolean>,
  o: { timeoutMs: number; intervalMs: number; sleep: (ms: number) => Promise<void>; what: string; step: string },
): Promise<void> {
  const mult = Number(process.env.DBM_TIMEOUT_MULTIPLIER ?? '1') || 1;
  const deadline = Date.now() + o.timeoutMs * mult;
  let attempts = 0;
  for (;;) {
    attempts++;
    if (await fn()) return;
    if (Date.now() >= deadline) throw remoteError(`timed out after ${o.timeoutMs * mult}ms waiting for ${o.what} (${attempts} attempts)`, o.step);
    await o.sleep(o.intervalMs);
  }
}
```

`src/commands/pgbouncer-apply.ts`:
```ts
import { renderPgbouncerIni, renderUserlist } from '../core/pgbouncer.js';
import { type State, listProjects } from '../core/state.js';
import type { Deps } from './context.js';

/** Render both PgBouncer files from state, upload atomically, SIGHUP. Files are 0644: the userlist holds SCRAM verifiers, not passwords, and PgBouncer runs as uid 70. */
export async function applyPgbouncer(deps: Deps, state: State): Promise<void> {
  const projects = listProjects(state);
  const dir = deps.cfg.remote.pgbouncerConfDir;
  const certDir = `/certs/${deps.cfg.dbHost}`;
  await deps.ssh.upload(`${dir}/pgbouncer.ini`, renderPgbouncerIni(projects, { certDir }), { mode: '0644' });
  await deps.ssh.upload(`${dir}/userlist.txt`, renderUserlist(projects), { mode: '0644' });
  await deps.ssh.run(['docker', 'kill', '-s', 'HUP', deps.cfg.remote.pgbouncerContainer]);
}
```

`src/commands/create.ts`:
```ts
import { postgresImage } from '../core/compose.js';
import { backupCron } from '../core/cron.js';
import { projectEnv } from '../core/env.js';
import { DbmError, ExitCode, userError } from '../core/exit.js';
import { deriveNames, validateSlug } from '../core/naming.js';
import { scramSha256Verifier } from '../core/scram.js';
import { dokployPassword, randomSecret } from '../core/secrets.js';
import { createDatabaseSql, createRoleSql, extensionsSql, tuningSql, validateExtensions } from '../core/sql.js';
import { type Project, removeProject, upsertProject } from '../core/state.js';
import { parseMemory } from '../core/units.js';
import { type Deps, adminTarget, waitUntil } from './context.js';
import { applyPgbouncer } from './pgbouncer-apply.js';

export interface CreateOptions {
  slug: string;
  memory?: string;
  pg?: 17 | 18;
  extensions?: string[];
  storage?: boolean;
  corsOrigins?: string[];
}

export interface CreateResult {
  project: Project;
  env: Record<string, string>;
  existed: boolean;
}

const DEFAULT_EXTENSIONS = ['pgcrypto', 'uuid-ossp'];

type Undo = { what: string; run: () => Promise<void> };

async function rollback(deps: Deps, undos: Undo[], cause: DbmError): Promise<never> {
  const leftovers: string[] = [];
  for (const u of [...undos].reverse()) {
    try {
      deps.io.err(`  rollback: ${u.what}\n`);
      await u.run();
    } catch (e) {
      leftovers.push(`${u.what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (leftovers.length) {
    throw new DbmError(
      `${cause.message}\nrollback failed; leftover resources need manual cleanup:\n  - ${leftovers.join('\n  - ')}`,
      ExitCode.RollbackFailed,
      cause.step,
    );
  }
  throw cause;
}

async function waitDeployed(deps: Deps, postgresId: string): Promise<void> {
  await deps.dokploy.deployPostgres(postgresId);
  await waitUntil(
    async () => {
      const row = await deps.dokploy.getPostgres(postgresId);
      if (row.applicationStatus === 'error') throw userError(`Dokploy reports deploy error for ${postgresId}; check its logs in the dashboard`, 'dokploy.deploy');
      return row.applicationStatus === 'done';
    },
    { timeoutMs: 120_000, intervalMs: 2_000, sleep: deps.sleep, what: 'postgres deploy', step: 'dokploy.deploy' },
  );
}

export async function createCommand(deps: Deps, o: CreateOptions): Promise<CreateResult> {
  const slug = validateSlug(o.slug);
  const names = deriveNames(slug);
  const extensions = validateExtensions([...new Set([...DEFAULT_EXTENSIONS, ...(o.extensions ?? [])])]);
  const memoryBytes = parseMemory(o.memory ?? '512m');
  const pgMajor = o.pg ?? 18;
  const withStorage = o.storage !== false;
  const corsOrigins = o.corsOrigins?.length ? o.corsOrigins : ['*'];

  let state = await deps.store.loadState();
  const existing = state.projects[slug];
  if (existing) {
    deps.io.err(`project ${slug} already exists (status: ${existing.status}); nothing to do\n`);
    return { project: existing, env: projectEnv(existing, deps.cfg), existed: true };
  }

  const dk = await deps.dokploy.getProject(deps.cfg.dokployProjectId);
  const clash = dk.environments.flatMap((e) => e.postgres).find((p) => p.name === names.serviceName || p.appName.startsWith(`${names.serviceName}-`));
  if (clash) {
    throw userError(`service ${names.serviceName} exists in Dokploy (${clash.appName}) but not in dbm state; \`dbm adopt\` is future work, remove it in Dokploy or pick another slug`, 'create.precheck');
  }

  const undos: Undo[] = [];
  const appPassword = randomSecret(32);
  const adminPassword = dokployPassword(32);
  const appScramVerifier = scramSha256Verifier(appPassword);

  try {
    deps.io.err(`creating ${slug}: postgres ${pgMajor} (${memoryBytes} bytes)\n`);
    const row = await deps.dokploy.createPostgres({
      name: names.serviceName,
      appName: names.serviceName,
      databaseName: 'postgres',
      databaseUser: names.adminRole,
      databasePassword: adminPassword,
      environmentId: deps.cfg.dokployEnvironmentId,
      dockerImage: postgresImage(pgMajor),
    });
    const appName = row.appName;
    undos.push({ what: `remove Dokploy service ${appName}`, run: () => deps.dokploy.removePostgres(row.postgresId) });
    undos.push({ what: `remove volume ${appName}-data`, run: async () => { await deps.ssh.run(['docker', 'volume', 'rm', `${appName}-data`]); } });

    await deps.dokploy.updatePostgres({ postgresId: row.postgresId, memoryLimit: String(memoryBytes) });
    await waitDeployed(deps, row.postgresId);

    const project: Project = {
      slug,
      createdAt: deps.now().toISOString(),
      status: 'provisioning',
      pgMajor,
      dokploy: { postgresId: row.postgresId, appName },
      postgres: {
        database: names.database,
        appRole: names.appRole,
        appPassword,
        appScramVerifier,
        adminRole: names.adminRole,
        adminPassword,
        extensions,
        memoryBytes,
      },
      betterAuthSecret: randomSecret(32),
    };

    await waitUntil(() => deps.pg.ping(adminTarget(project)), { timeoutMs: 60_000, intervalMs: 2_000, sleep: deps.sleep, what: 'postgres to accept connections', step: 'postgres.ready' });
    await deps.pg.runSql(adminTarget(project), `${createRoleSql(names.appRole, appScramVerifier)}\n${createDatabaseSql(names.database, names.appRole)}\n`);
    await deps.pg.runSql(adminTarget(project, names.database), extensionsSql(extensions));
    await deps.pg.runSql(adminTarget(project), tuningSql(memoryBytes));
    await waitDeployed(deps, row.postgresId); // restart to apply shared_buffers
    await waitUntil(() => deps.pg.ping(adminTarget(project)), { timeoutMs: 60_000, intervalMs: 2_000, sleep: deps.sleep, what: 'postgres after restart', step: 'postgres.ready' });

    state = upsertProject(state, project);
    await deps.store.saveState(state);
    undos.push({ what: 'remove project from state and re-render PgBouncer', run: async () => {
      const s = removeProject(await deps.store.loadState(), slug);
      await deps.store.saveState(s);
      await applyPgbouncer(deps, s);
    } });
    await applyPgbouncer(deps, state);
    const viaBouncer = `postgresql://${names.appRole}:${appPassword}@${deps.cfg.remote.pgbouncerContainer}:6432/${names.pgbouncerDb}?sslmode=require`;
    if (!(await deps.pg.pingViaPgbouncer(viaBouncer))) {
      throw new DbmError('could not connect through PgBouncer after reload (check userlist.txt and [databases] on the VPS)', ExitCode.RemoteFailure, 'pgbouncer.verify');
    }

    if (withStorage) {
      deps.io.err('  storage: bucket, key, CORS\n');
      const bucket = await deps.garage.createBucket(names.bucket);
      undos.push({ what: `delete bucket ${names.bucket}`, run: async () => { await deps.garage.cleanupIncompleteUploads(bucket.id); await deps.garage.deleteBucket(bucket.id); } });
      const key = await deps.garage.createKey(names.keyName);
      undos.push({ what: `delete key ${key.accessKeyId}`, run: () => deps.garage.deleteKey(key.accessKeyId) });
      await deps.garage.allowBucketKey(bucket.id, key.accessKeyId, { read: true, write: true });
      await deps.garage.allowBucketKey(bucket.id, deps.cfg.garageBackupKeyId, { read: true });
      await deps.garage.updateBucket(bucket.id, {
        corsRules: [{ allowedOrigins: corsOrigins, allowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'], allowedHeaders: ['*'], exposeHeaders: ['ETag'], maxAgeSeconds: 3600 }],
      });
      project.storage = { bucketId: bucket.id, bucket: names.bucket, keyId: key.accessKeyId, keySecret: key.secretAccessKey, corsOrigins, aliases: [] };
    }

    deps.io.err('  backup schedule\n');
    const backup = await deps.dokploy.createBackup({
      schedule: backupCron(slug),
      prefix: names.backupPrefix,
      destinationId: deps.cfg.dumpsDestinationId,
      database: names.database,
      databaseType: 'postgres',
      postgresId: row.postgresId,
      enabled: true,
      keepLatestCount: 35,
    });
    undos.push({ what: `remove backup schedule ${backup.backupId}`, run: () => deps.dokploy.removeBackup(backup.backupId) });
    project.dokploy.backupId = backup.backupId;

    project.status = 'running';
    state = upsertProject(state, project);
    await deps.store.saveState(state);
    deps.io.err(`created ${slug}\n`);
    return { project, env: projectEnv(project, deps.cfg), existed: false };
  } catch (e) {
    const cause = e instanceof DbmError ? e : new DbmError(e instanceof Error ? e.message : String(e), ExitCode.RemoteFailure, 'create');
    deps.io.err(`create failed at [${cause.step ?? 'unknown'}]: ${cause.message}\n`);
    return rollback(deps, undos, cause);
  }
}
```

- [ ] **Step 5: Register `create` in `src/cli.ts`**

Replace the body of `buildProgram` so it accepts a deps factory and adds the command. Later tasks add more commands in the same style.

```ts
import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import { makeFileStore } from './adapters/store.js';
import { type Deps, makeDeps } from './commands/context.js';
import { createCommand } from './commands/create.js';
import { formatEnvBlock } from './core/env.js';
import { DbmError, ExitCode, userError } from './core/exit.js';
import { VERSION } from './version.js';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}
export const stdIo: Io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };

export interface GlobalOpts {
  json: boolean;
  yes: boolean;
}

export type DepsFactory = (io: Io) => Promise<Deps>;

export const defaultDepsFactory: DepsFactory = (io) => makeDeps(makeFileStore(), io);

function globals(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals<GlobalOpts>();
}

function emit(io: Io, g: GlobalOpts, json: unknown, human: string): void {
  io.out(g.json ? `${JSON.stringify(json, null, 2)}\n` : human);
}

export function buildProgram(io: Io, depsFactory: DepsFactory = defaultDepsFactory): Command {
  const program = new Command('dbm')
    .version(VERSION)
    .description('Personal database platform on one VPS')
    .option('--json', 'machine-readable output', false)
    .option('--yes', 'skip confirmations (destructive commands then need --confirm <slug>)', false)
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: io.out, writeErr: io.err });

  program
    .command('create')
    .description('Create a project: Postgres container, PgBouncer entries, S3 bucket, nightly backup')
    .argument('<slug>')
    .option('--memory <size>', 'container memory limit', '512m')
    .option('--pg <major>', 'Postgres major version (17|18)', '18')
    .option('--extensions <list>', 'comma-separated extra extensions')
    .option('--no-storage', 'skip the S3 bucket')
    .option('--cors-origin <origin...>', 'allowed CORS origins for browser uploads (default *)')
    .action(async function (this: Command, slug: string, opts: { memory: string; pg: string; extensions?: string; storage: boolean; corsOrigin?: string[] }) {
      const g = globals(this);
      const pg = Number(opts.pg);
      if (pg !== 17 && pg !== 18) throw userError('--pg must be 17 or 18', 'create');
      const deps = await depsFactory(io);
      const r = await createCommand(deps, {
        slug,
        memory: opts.memory,
        pg,
        ...(opts.extensions ? { extensions: opts.extensions.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        storage: opts.storage,
        ...(opts.corsOrigin ? { corsOrigins: opts.corsOrigin } : {}),
      });
      emit(io, g, { slug: r.project.slug, existed: r.existed, env: r.env },
        `${formatEnvBlock(r.env)}\n# Pin Vercel functions to gru1 (templates/nextjs/vercel.json).\n`);
    });

  return program;
}

export async function run(argv: string[], io: Io = stdIo, depsFactory?: DepsFactory): Promise<number> {
  const program = buildProgram(io, depsFactory);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return ExitCode.Ok;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? ExitCode.Ok : ExitCode.UserError;
    if (e instanceof DbmError) {
      io.err(`${pc.red('error')}${e.step ? ` [${e.step}]` : ''}: ${e.message}\n`);
      return e.exitCode;
    }
    io.err(`unexpected: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return ExitCode.RemoteFailure;
  }
}
```

- [ ] **Step 6: Run tests, expect pass; lint; typecheck**

Run: `npx vitest run --project unit && npm run typecheck && npm run lint`
Expected: PASS everywhere. `test/unit/exit.test.ts` still passes because `--version` never calls the deps factory.

- [ ] **Step 7: Commit**

```bash
git add src/commands src/cli.ts test/helpers/fakes.ts test/commands/create.test.ts
git commit -m "feat: create command with rollback, deps context, pgbouncer apply, CLI wiring"
```

### Task 14: `list` and `env`

**Spec:** 7 (`list`, `env`).

**Files:**
- Create: `src/commands/list.ts`, `src/commands/env.ts`, `test/commands/list-env.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `listCommand(deps): Promise<ListRow[]>` with `ListRow { slug; status; pgMajor; memory: string; volume: string; storage: string; lastBackup: string; createdAt }`; `envCommand(deps, slug): Promise<Record<string,string>>`; `formatTable(rows: string[][]): string`.

- [ ] **Step 1: Write the failing tests**

`test/commands/list-env.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { envCommand } from '../../src/commands/env.js';
import { formatTable, listCommand } from '../../src/commands/list.js';
import { upsertProject } from '../../src/core/state.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../unit/state.test.js';

describe('list', () => {
  it('collects memory, volume, storage and last backup per project', async () => {
    const runner = makeFakeRunner([
      { match: /docker stats --no-stream --format/, stdout: 'pg-my-app-abc123.1.xyz\t45.2MiB / 512MiB\n' },
      { match: /docker system df -v --format/, stdout: '[{"Name":"pg-my-app-abc123-data","Size":"120.3MB"}]' },
    ]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    t.garage.buckets.set('b1', { id: 'b1', globalAliases: ['my-app'], bytes: 2048, objects: 3, unfinishedUploads: 0, websiteAccess: false });
    t.dokploy.files = [{ Path: 'pg-my-app-abc123/db/my-app/2026-09-30T06-03-00-000Z.sql.gz', Name: 'x', Size: 1, ModTime: '2026-09-30T06:03:01Z' }];
    const rows = await listCommand(t.deps);
    expect(rows).toEqual([{
      slug: 'my-app', status: 'running', pgMajor: 18, memory: '45.2MiB / 512MiB', volume: '120.3MB',
      storage: '2.0 KiB (3 objects)', lastBackup: '2026-09-30T06:03:01Z', createdAt: '2026-09-30T00:00:00.000Z',
    }]);
  });
  it('degrades gracefully when the VPS is unreachable', async () => {
    const runner = makeFakeRunner([{ match: /docker/, fail: true }]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    const rows = await listCommand(t.deps);
    expect(rows[0]?.memory).toBe('?');
  });
  it('formatTable pads columns', () => {
    expect(formatTable([['a', 'bbb'], ['cc', 'd']])).toBe('a   bbb\ncc  d\n');
  });
});

describe('env', () => {
  it('prints env without the admin password and errors on unknown slug', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    const env = await envCommand(t.deps, 'my-app');
    expect(env.DATABASE_URL).toContain('/my-app?sslmode=verify-full');
    expect(JSON.stringify(env)).not.toContain('adminpw');
    await expect(envCommand(t.deps, 'nope')).rejects.toMatchObject({ exitCode: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/commands/list-env.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/commands/list.ts`:
```ts
import { deriveNames } from '../core/naming.js';
import { listProjects } from '../core/state.js';
import { formatBytes } from '../core/units.js';
import type { Deps } from './context.js';

export interface ListRow {
  slug: string;
  status: string;
  pgMajor: number;
  memory: string;
  volume: string;
  storage: string;
  lastBackup: string;
  createdAt: string;
}

export function formatTable(rows: string[][]): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, c.length); });
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join('  ')).join('\n') + '\n';
}

async function dockerStats(deps: Deps): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const r = await deps.ssh.run(['docker', 'stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}']);
    for (const line of r.stdout.split('\n')) {
      const [name, mem] = line.split('\t');
      if (name && mem) out.set(name, mem);
    }
  } catch {
    /* unreachable VPS: leave empty */
  }
  return out;
}

async function volumeSizes(deps: Deps): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const r = await deps.ssh.run(['docker', 'system', 'df', '-v', '--format', '{{json .Volumes}}']);
    const vols = JSON.parse(r.stdout || '[]') as Array<{ Name: string; Size: string }>;
    for (const v of vols) out.set(v.Name, v.Size);
  } catch {
    /* ignore */
  }
  return out;
}

export async function listCommand(deps: Deps): Promise<ListRow[]> {
  const state = await deps.store.loadState();
  const [stats, vols] = await Promise.all([dockerStats(deps), volumeSizes(deps)]);
  const rows: ListRow[] = [];
  for (const p of listProjects(state)) {
    const names = deriveNames(p.slug);
    const memKey = [...stats.keys()].find((k) => k.startsWith(`${p.dokploy.appName}.`) || k === p.dokploy.appName);
    let storage = '-';
    if (p.storage) {
      try {
        const b = await deps.garage.getBucket({ id: p.storage.bucketId });
        storage = b ? `${formatBytes(b.bytes)} (${b.objects} objects)` : '?';
      } catch {
        storage = '?';
      }
    }
    let lastBackup = '-';
    try {
      const files = await deps.dokploy.listBackupFiles(deps.cfg.dumpsDestinationId, `${p.dokploy.appName}/${names.backupPrefix}/`);
      const newest = files.map((f) => f.ModTime).sort().at(-1);
      if (newest) lastBackup = newest;
    } catch {
      lastBackup = '?';
    }
    rows.push({
      slug: p.slug,
      status: p.status,
      pgMajor: p.pgMajor,
      memory: memKey ? (stats.get(memKey) ?? '?') : stats.size ? '-' : '?',
      volume: vols.get(`${p.dokploy.appName}-data`) ?? (vols.size ? '-' : '?'),
      storage,
      lastBackup,
      createdAt: p.createdAt,
    });
  }
  return rows;
}
```

`src/commands/env.ts`:
```ts
import { projectEnv } from '../core/env.js';
import { getProject } from '../core/state.js';
import type { Deps } from './context.js';

export async function envCommand(deps: Deps, slug: string): Promise<Record<string, string>> {
  const state = await deps.store.loadState();
  return projectEnv(getProject(state, slug), deps.cfg);
}
```

Register in `src/cli.ts` (inside `buildProgram`, after `create`):
```ts
  program.command('list').description('List projects with memory, disk, storage and last backup').action(async function (this: Command) {
    const g = globals(this);
    const deps = await depsFactory(io);
    const rows = await listCommand(deps);
    const table = [['SLUG', 'STATUS', 'PG', 'MEMORY', 'VOLUME', 'STORAGE', 'LAST BACKUP', 'CREATED'],
      ...rows.map((r) => [r.slug, r.status, String(r.pgMajor), r.memory, r.volume, r.storage, r.lastBackup, r.createdAt.slice(0, 10)])];
    emit(io, g, rows, rows.length ? formatTable(table) : 'no projects\n');
  });

  program.command('env').description('Print the env block for a project').argument('<slug>').action(async function (this: Command, slug: string) {
    const g = globals(this);
    const deps = await depsFactory(io);
    const env = await envCommand(deps, slug);
    emit(io, g, env, formatEnvBlock(env));
  });
```
(Add the imports for `listCommand`, `formatTable`, `envCommand`.)

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run --project unit test/commands/list-env.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/list.ts src/commands/env.ts src/cli.ts test/commands/list-env.test.ts
git commit -m "feat: list and env commands"
```

### Task 15: `pause` and `resume`

**Spec:** 7 (`pause`/`resume`).

**Files:**
- Create: `src/commands/pause.ts`, `test/commands/pause.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `pauseCommand(deps, slug): Promise<Project>`, `resumeCommand(deps, slug): Promise<Project>`, `backupInputFor(deps, p): BackupInput` (shared by destroy/pause).

- [ ] **Step 1: Write the failing tests**

`test/commands/pause.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { pauseCommand, resumeCommand } from '../../src/commands/pause.js';
import { upsertProject } from '../../src/core/state.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../unit/state.test.js';

describe('pause/resume', () => {
  it('stops the service and disables the backup schedule, then reverses', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    t.dokploy.backups.set('bk_1', { schedule: '3 6 * * *', prefix: 'db/my-app', destinationId: 'd1', database: 'my_app', databaseType: 'postgres', postgresId: 'pg_1', enabled: true, keepLatestCount: 35 });
    const p = await pauseCommand(t.deps, 'my-app');
    expect(p.status).toBe('paused');
    expect(t.dokploy.calls).toEqual(['stopPostgres', 'updateBackup']);
    expect(t.dokploy.backups.get('bk_1')?.enabled).toBe(false);
    expect(t.store.state.projects['my-app']?.status).toBe('paused');
    const r = await resumeCommand(t.deps, 'my-app');
    expect(r.status).toBe('running');
    expect(t.dokploy.calls.slice(2)).toEqual(['startPostgres', 'updateBackup']);
    expect(t.dokploy.backups.get('bk_1')?.enabled).toBe(true);
  });
  it('pausing an already paused project is a no-op', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app', { status: 'paused' }));
    await pauseCommand(t.deps, 'my-app');
    expect(t.dokploy.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/commands/pause.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/commands/pause.ts`**

```ts
import type { BackupInput } from '../adapters/types.js';
import { backupCron } from '../core/cron.js';
import { deriveNames } from '../core/naming.js';
import { type Project, getProject, upsertProject } from '../core/state.js';
import type { Deps } from './context.js';

/** Dokploy's backup.update requires every field; rebuild them from state. */
export function backupInputFor(deps: Deps, p: Project, enabled: boolean): BackupInput {
  return {
    schedule: backupCron(p.slug),
    prefix: deriveNames(p.slug).backupPrefix,
    destinationId: deps.cfg.dumpsDestinationId,
    database: p.postgres.database,
    databaseType: 'postgres',
    postgresId: p.dokploy.postgresId,
    enabled,
    keepLatestCount: 35,
  };
}

async function setRunning(deps: Deps, slug: string, running: boolean): Promise<Project> {
  const state = await deps.store.loadState();
  const p = getProject(state, slug);
  const target = running ? 'running' : 'paused';
  if (p.status === target) {
    deps.io.err(`${slug} is already ${target}\n`);
    return p;
  }
  if (running) await deps.dokploy.startPostgres(p.dokploy.postgresId);
  else await deps.dokploy.stopPostgres(p.dokploy.postgresId);
  if (p.dokploy.backupId) {
    await deps.dokploy.updateBackup({ ...backupInputFor(deps, p, running), backupId: p.dokploy.backupId });
  }
  const next: Project = { ...p, status: target };
  await deps.store.saveState(upsertProject(state, next));
  deps.io.err(`${slug} ${target}\n`);
  return next;
}

export const pauseCommand = (deps: Deps, slug: string) => setRunning(deps, slug, false);
export const resumeCommand = (deps: Deps, slug: string) => setRunning(deps, slug, true);
```

Register in `src/cli.ts`:
```ts
  for (const [name, fn] of [['pause', pauseCommand], ['resume', resumeCommand]] as const) {
    program.command(name).description(`${name} a project's Postgres container and its backup schedule`).argument('<slug>')
      .action(async function (this: Command, slug: string) {
        const g = globals(this);
        const p = await fn(await depsFactory(io), slug);
        emit(io, g, { slug: p.slug, status: p.status }, `${p.slug}: ${p.status}\n`);
      });
  }
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run --project unit test/commands/pause.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/pause.ts src/cli.ts test/commands/pause.test.ts
git commit -m "feat: pause and resume commands"
```

### Task 16: `destroy`

**Spec:** 7 (`destroy`). **Review Focus 4.**

**Files:**
- Create: `src/commands/destroy.ts`, `test/commands/destroy.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `destroyCommand(deps, { slug, purgeStorage, yes, confirmSlug }): Promise<{ slug; purgedStorage: boolean; warnings: string[] }>`, `emptyBucket(deps, p): Promise<void>` (uses a throwaway `rclone` container with the project key to delete all objects).

- [ ] **Step 1: Write the failing tests**

`test/commands/destroy.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { destroyCommand } from '../../src/commands/destroy.js';
import { upsertProject } from '../../src/core/state.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../unit/state.test.js';

function seeded(status: 'running' | 'paused' = 'running') {
  const t = makeTestDeps();
  t.store.state = upsertProject(t.store.state, fakeProject('my-app', { status }));
  t.garage.buckets.set('b1', { id: 'b1', globalAliases: ['my-app'], bytes: 10, objects: 2, unfinishedUploads: 0, websiteAccess: false });
  t.garage.keys.set('GK1', { name: 'my-app-key' });
  return t;
}

describe('destroy', () => {
  it('takes a final backup, removes pgbouncer entries, service, volume, key; keeps bucket without --purge-storage', async () => {
    const t = seeded();
    const r = await destroyCommand(t.deps, { slug: 'my-app', purgeStorage: false, yes: true, confirmSlug: 'my-app' });
    expect(r.purgedStorage).toBe(false);
    expect(t.dokploy.calls).toEqual(['manualBackup', 'removeBackup', 'removePostgres']);
    expect(t.runner.calls.map((c) => c.argv.join(' '))).toContain('docker volume rm pg-my-app-abc123-data');
    expect(t.runner.uploads.at(-2)?.content).not.toContain('my-app');
    expect(t.garage.calls).toEqual(['deleteKey']);
    expect(t.garage.buckets.has('b1')).toBe(true);
    expect(t.store.state.projects['my-app']).toBeUndefined();
    expect(t.errLines.join('')).toMatch(/bucket my-app kept/);
  });
  it('--purge-storage empties then deletes the bucket and removes the web router', async () => {
    const t = seeded();
    t.store.state.projects['my-app']!.storage!.publicBaseUrl = 'https://my-app.web.example.com';
    t.garage.buckets.get('b1')!.objects = 0; // emptyBucket is simulated by the runner; the fake bucket must be empty for deleteBucket
    await destroyCommand(t.deps, { slug: 'my-app', purgeStorage: true, yes: true, confirmSlug: 'my-app' });
    const cmds = t.runner.calls.map((c) => c.argv.join(' '));
    expect(cmds.some((c) => c.includes('rclone/rclone') && c.includes('purge') && c.includes('my-app'))).toBe(true);
    expect(cmds).toContain('rm -f /etc/dokploy/traefik/dynamic/dbm-web-my-app.yml');
    expect(t.garage.calls).toEqual(['cleanupIncompleteUploads', 'deleteBucket', 'deleteKey']);
  });
  it('a paused project skips the final backup with a warning (Review Focus 4)', async () => {
    const t = seeded('paused');
    const r = await destroyCommand(t.deps, { slug: 'my-app', purgeStorage: false, yes: true, confirmSlug: 'my-app' });
    expect(t.dokploy.calls[0]).toBe('removeBackup');
    expect(r.warnings.join(' ')).toMatch(/paused.*no final backup/);
  });
  it('requires confirmation: wrong --confirm or declined prompt is a user error with no side effects', async () => {
    const t = seeded();
    await expect(destroyCommand(t.deps, { slug: 'my-app', purgeStorage: false, yes: true, confirmSlug: 'other' })).rejects.toMatchObject({ exitCode: 1 });
    t.deps.confirm = async () => false;
    await expect(destroyCommand(t.deps, { slug: 'my-app', purgeStorage: false, yes: false })).rejects.toMatchObject({ exitCode: 1 });
    expect(t.dokploy.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/commands/destroy.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/commands/destroy.ts`**

```ts
import { IMAGES } from '../core/compose.js';
import { userError } from '../core/exit.js';
import { deriveNames } from '../core/naming.js';
import { type Project, getProject, removeProject } from '../core/state.js';
import type { Deps } from './context.js';
import { applyPgbouncer } from './pgbouncer-apply.js';

export interface DestroyOptions {
  slug: string;
  purgeStorage: boolean;
  yes: boolean;
  confirmSlug?: string;
}

export interface DestroyResult {
  slug: string;
  purgedStorage: boolean;
  warnings: string[];
}

export async function requireConfirmation(deps: Deps, o: { slug: string; yes: boolean; confirmSlug?: string }, action: string): Promise<void> {
  if (o.yes) {
    if (o.confirmSlug !== o.slug) throw userError(`--yes requires --confirm ${o.slug} to ${action}`, 'confirm');
    return;
  }
  if (!(await deps.confirm(`This will ${action} ${o.slug}.`, o.slug))) throw userError('aborted', 'confirm');
}

/** Delete every object with the project's own key from a throwaway rclone container on the docker network. */
export async function emptyBucket(deps: Deps, p: Project): Promise<void> {
  if (!p.storage) return;
  const conf = `[garage]\ntype = s3\nprovider = Other\nenv_auth = false\naccess_key_id = ${p.storage.keyId}\nsecret_access_key = ${p.storage.keySecret}\nendpoint = http://${deps.cfg.remote.garageContainer}:3900\nregion = garage\nforce_path_style = true\nno_check_bucket = true\n`;
  await deps.ssh.run(
    ['docker', 'run', '--rm', '-i', '--network', deps.cfg.remote.dockerNetwork, IMAGES.rclone, '--config', '/dev/stdin', 'purge', `garage:${p.storage.bucket}`],
    { input: conf, timeoutMs: 30 * 60_000 },
  );
}

export async function destroyCommand(deps: Deps, o: DestroyOptions): Promise<DestroyResult> {
  let state = await deps.store.loadState();
  const p = getProject(state, o.slug);
  await requireConfirmation(deps, o, 'permanently destroy');
  const names = deriveNames(p.slug);
  const warnings: string[] = [];

  if (p.status === 'paused') {
    warnings.push(`${p.slug} is paused: no final backup was taken (resume first if you need one)`);
  } else if (p.dokploy.backupId) {
    deps.io.err('final backup...\n');
    await deps.dokploy.manualBackup(p.dokploy.backupId);
  }

  state = removeProject(state, p.slug);
  await deps.store.saveState(state);
  await applyPgbouncer(deps, state);

  if (p.dokploy.backupId) await deps.dokploy.removeBackup(p.dokploy.backupId);
  await deps.dokploy.removePostgres(p.dokploy.postgresId);
  await deps.ssh.run(['docker', 'volume', 'rm', `${p.dokploy.appName}-data`]);

  let purgedStorage = false;
  if (p.storage) {
    if (o.purgeStorage) {
      deps.io.err('emptying and deleting bucket...\n');
      await emptyBucket(deps, p);
      await deps.garage.cleanupIncompleteUploads(p.storage.bucketId);
      await deps.garage.deleteBucket(p.storage.bucketId);
      if (p.storage.publicBaseUrl) {
        await deps.ssh.run(['rm', '-f', `${deps.cfg.remote.traefikDynamicDir}/${names.traefikWebFile}`]);
      }
      purgedStorage = true;
    } else {
      deps.io.err(`bucket ${p.storage.bucket} kept (use --purge-storage to delete it)\n`);
    }
    await deps.garage.deleteKey(p.storage.keyId);
  }

  for (const w of warnings) deps.io.err(`warning: ${w}\n`);
  deps.io.err(`destroyed ${p.slug}; off-site dumps remain for 30 days\n`);
  return { slug: p.slug, purgedStorage, warnings };
}
```

Register in `src/cli.ts`:
```ts
  program.command('destroy').description('Destroy a project (final backup first; off-site dumps kept 30 days)')
    .argument('<slug>').option('--purge-storage', 'also delete the S3 bucket', false).option('--confirm <slug>', 'required with --yes')
    .action(async function (this: Command, slug: string, opts: { purgeStorage: boolean; confirm?: string }) {
      const g = globals(this);
      const r = await destroyCommand(await depsFactory(io), { slug, purgeStorage: opts.purgeStorage, yes: g.yes, ...(opts.confirm ? { confirmSlug: opts.confirm } : {}) });
      emit(io, g, r, `destroyed ${r.slug}\n`);
    });
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run --project unit test/commands/destroy.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/destroy.ts src/cli.ts test/commands/destroy.test.ts
git commit -m "feat: destroy command with final backup, volume removal and optional storage purge"
```

### Task 17: `backup` and `restore`

**Spec:** 7 (`backup`, `restore`), 5.5 (dump format is gzipped `pg_dump -Fc`; restore with `pg_restore`). **Research:** `dokploy.md` (backups section).

The restore pipeline runs on the VPS: an `rclone` container streams the object (destination credentials on stdin as an rclone config), host `gunzip` decompresses, and `docker exec -i <container> pg_restore -U <appRole> -d <db> -O --clean --if-exists` loads it. Running as the app role (the official image's `pg_hba` trusts local socket connections) makes restored objects owned by the app role.

**Files:**
- Create: `src/commands/backup.ts`, `test/commands/backup.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `backupCommand(deps, slug): Promise<{ slug; files: BackupFile[] }>`, `restoreCommand(deps, { slug, backupId, as? }): Promise<{ target: string; file: string }>`, `pickBackup(files, backupId): BackupFile`, `restoreScript(...)`.

- [ ] **Step 1: Write the failing tests**

`test/commands/backup.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { backupCommand, pickBackup, restoreCommand } from '../../src/commands/backup.js';
import { upsertProject } from '../../src/core/state.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../unit/state.test.js';

const files = [
  { Path: 'pg-my-app-abc123/db/my-app/2026-09-29T06-03-00-000Z.sql.gz', Name: '2026-09-29T06-03-00-000Z.sql.gz', Size: 1, ModTime: '2026-09-29T06:03:01Z' },
  { Path: 'pg-my-app-abc123/db/my-app/2026-09-30T06-03-00-000Z.sql.gz', Name: '2026-09-30T06-03-00-000Z.sql.gz', Size: 1, ModTime: '2026-09-30T06:03:01Z' },
];

describe('backup', () => {
  it('triggers a manual backup and lists files', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    t.dokploy.files = files;
    const r = await backupCommand(t.deps, 'my-app');
    expect(t.dokploy.calls).toEqual(['manualBackup', 'listBackupFiles']);
    expect(r.files).toHaveLength(2);
  });
  it('pickBackup: latest by ModTime, or by Name/Path; unknown id is a user error', () => {
    expect(pickBackup(files, 'latest').Name).toBe('2026-09-30T06-03-00-000Z.sql.gz');
    expect(pickBackup(files, '2026-09-29T06-03-00-000Z.sql.gz').ModTime).toBe('2026-09-29T06:03:01Z');
    expect(() => pickBackup(files, 'nope')).toThrow(/not found/);
    expect(() => pickBackup([], 'latest')).toThrow(/no backups/);
  });
});

describe('restore', () => {
  it('streams rclone cat | gunzip | pg_restore as the app role with destination creds on stdin', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    t.dokploy.files = files;
    const r = await restoreCommand(t.deps, { slug: 'my-app', backupId: 'latest' });
    expect(r.target).toBe('my-app');
    const call = t.runner.calls.find((c) => c.argv.join(' ').includes('pg_restore'));
    const cmd = call?.argv.join(' ') ?? '';
    expect(cmd).toContain('rclone/rclone:1 --config /dev/stdin cat dst:dumps/pg-my-app-abc123/db/my-app/2026-09-30T06-03-00-000Z.sql.gz');
    expect(cmd).toContain('gunzip');
    expect(cmd).toContain('pg_restore -U my_app_app -d my_app -O --clean --if-exists');
    expect(call?.input).toContain('access_key_id = AK');
    expect(call?.input).toContain('secret_access_key = SK');
    expect(cmd).not.toContain('SK');
  });
  it('--as creates the new project first and restores into it', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    t.dokploy.files = files;
    const r = await restoreCommand(t.deps, { slug: 'my-app', backupId: 'latest', as: 'staging' });
    expect(r.target).toBe('staging');
    expect(t.store.state.projects.staging?.status).toBe('running');
    expect(t.dokploy.calls).toContain('createPostgres');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/commands/backup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/commands/backup.ts`**

```ts
import type { BackupFile } from '../adapters/types.js';
import { IMAGES } from '../core/compose.js';
import { userError } from '../core/exit.js';
import { deriveNames } from '../core/naming.js';
import { type Project, getProject } from '../core/state.js';
import type { Deps } from './context.js';
import { createCommand } from './create.js';

export function pickBackup(files: BackupFile[], backupId: string): BackupFile {
  if (!files.length) throw userError('no backups found for this project', 'restore');
  if (backupId === 'latest') {
    return [...files].sort((a, b) => a.ModTime.localeCompare(b.ModTime)).at(-1) as BackupFile;
  }
  const f = files.find((x) => x.Name === backupId || x.Path === backupId || x.Path.endsWith(`/${backupId}`));
  if (!f) throw userError(`backup ${backupId} not found; run \`dbm backup <slug>\` to list`, 'restore');
  return f;
}

async function listFiles(deps: Deps, p: Project): Promise<BackupFile[]> {
  const names = deriveNames(p.slug);
  return deps.dokploy.listBackupFiles(deps.cfg.dumpsDestinationId, `${p.dokploy.appName}/${names.backupPrefix}/`);
}

export async function backupCommand(deps: Deps, slug: string): Promise<{ slug: string; files: BackupFile[] }> {
  const p = getProject(await deps.store.loadState(), slug);
  if (!p.dokploy.backupId) throw userError(`${slug} has no backup schedule`, 'backup');
  if (p.status === 'paused') throw userError(`${slug} is paused; resume before taking a backup`, 'backup');
  deps.io.err('running backup (pg_dump -Fc | gzip -> off-site)...\n');
  await deps.dokploy.manualBackup(p.dokploy.backupId);
  return { slug, files: await listFiles(deps, p) };
}

export interface RestoreOptions {
  slug: string;
  backupId: string;
  as?: string;
}

export async function restoreCommand(deps: Deps, o: RestoreOptions): Promise<{ target: string; file: string }> {
  let state = await deps.store.loadState();
  const source = getProject(state, o.slug);
  const file = pickBackup(await listFiles(deps, source), o.backupId);
  const dest = await deps.dokploy.getDestination(deps.cfg.dumpsDestinationId);

  let target = source;
  if (o.as) {
    deps.io.err(`creating ${o.as} for restore...\n`);
    const created = await createCommand(deps, {
      slug: o.as,
      pg: source.pgMajor,
      extensions: source.postgres.extensions,
      memory: String(source.postgres.memoryBytes),
    });
    target = created.project;
    state = await deps.store.loadState();
  }
  if (target.status === 'paused') throw userError(`${target.slug} is paused; resume before restoring`, 'restore');

  const container = await deps.pg.findContainer(target.dokploy.appName);
  const rcloneConf = `[dst]\ntype = s3\nprovider = ${dest.provider ?? 'Other'}\nenv_auth = false\naccess_key_id = ${dest.accessKey}\nsecret_access_key = ${dest.secretAccessKey}\nendpoint = ${dest.endpoint}\nregion = ${dest.region}\nforce_path_style = true\nno_check_bucket = true\n`;
  const pipeline = [
    `docker run --rm -i --network ${deps.cfg.remote.dockerNetwork} ${IMAGES.rclone} --config /dev/stdin cat dst:${dest.bucket}/${file.Path}`,
    'gunzip',
    `docker exec -i ${container} pg_restore -U ${target.postgres.appRole} -d ${target.postgres.database} -O --clean --if-exists`,
  ].join(' | ');
  deps.io.err(`restoring ${file.Name} into ${target.slug}...\n`);
  await deps.ssh.run(['sh', '-c', `set -o pipefail; ${pipeline}`], { input: rcloneConf, timeoutMs: 30 * 60_000 });
  deps.io.err('restore complete\n');
  return { target: target.slug, file: file.Name };
}
```

Register in `src/cli.ts`:
```ts
  program.command('backup').description('Run an on-demand off-site backup and list dumps').argument('<slug>')
    .action(async function (this: Command, slug: string) {
      const g = globals(this);
      const r = await backupCommand(await depsFactory(io), slug);
      emit(io, g, r, `${r.files.map((f) => `${f.ModTime}  ${f.Name}`).join('\n')}\n`);
    });
  program.command('restore').description('Restore a dump (id or "latest"), optionally into a new project with --as')
    .argument('<slug>').argument('<backup-id>').option('--as <newslug>', 'restore into a freshly created project')
    .action(async function (this: Command, slug: string, backupId: string, opts: { as?: string }) {
      const g = globals(this);
      const r = await restoreCommand(await depsFactory(io), { slug, backupId, ...(opts.as ? { as: opts.as } : {}) });
      emit(io, g, r, `restored ${r.file} into ${r.target}\n`);
    });
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run --project unit test/commands/backup.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/backup.ts src/cli.ts test/commands/backup.test.ts
git commit -m "feat: backup and restore commands (pg_restore from off-site dumps, clone via --as)"
```

### Task 18: `psql` and `sync-pgbouncer`

**Spec:** 7 (`psql`, `sync-pgbouncer`).

**Files:**
- Create: `src/commands/psql.ts`, `test/commands/psql.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write the failing test**

`test/commands/psql.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { psqlArgv } from '../../src/commands/psql.js';
import { syncPgbouncerCommand } from '../../src/commands/sync-pgbouncer.js';
import { upsertProject } from '../../src/core/state.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../unit/state.test.js';

describe('psql', () => {
  it('builds an interactive docker exec as the app role, or admin with --admin', () => {
    const p = fakeProject('my-app');
    expect(psqlArgv('c1', p, false)).toEqual(['docker', 'exec', '-it', 'c1', 'psql', '-U', 'my_app_app', '-d', 'my_app']);
    expect(psqlArgv('c1', p, true)).toEqual(['docker', 'exec', '-it', 'c1', 'psql', '-U', 'my_app_admin', '-d', 'my_app']);
  });
});

describe('sync-pgbouncer', () => {
  it('re-renders both files from state and reloads', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    await syncPgbouncerCommand(t.deps);
    expect(t.runner.uploads.map((u) => u.path)).toEqual(['/etc/dokploy/dbm/pgbouncer/pgbouncer.ini', '/etc/dokploy/dbm/pgbouncer/userlist.txt']);
    expect(t.runner.calls.at(-1)?.argv).toEqual(['docker', 'kill', '-s', 'HUP', 'dbm-pgbouncer']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/commands/psql.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/commands/psql.ts`:
```ts
import { type Project, getProject } from '../core/state.js';
import type { Deps } from './context.js';

export function psqlArgv(container: string, p: Project, admin: boolean): string[] {
  return ['docker', 'exec', '-it', container, 'psql', '-U', admin ? p.postgres.adminRole : p.postgres.appRole, '-d', p.postgres.database];
}

export async function psqlCommand(deps: Deps, slug: string, admin: boolean): Promise<number> {
  const p = getProject(await deps.store.loadState(), slug);
  const container = await deps.pg.findContainer(p.dokploy.appName);
  return deps.ssh.interactive(psqlArgv(container, p, admin));
}
```

`src/commands/sync-pgbouncer.ts`:
```ts
import type { Deps } from './context.js';
import { applyPgbouncer } from './pgbouncer-apply.js';

export async function syncPgbouncerCommand(deps: Deps): Promise<void> {
  await applyPgbouncer(deps, await deps.store.loadState());
  deps.io.err('pgbouncer.ini and userlist.txt re-rendered from state and reloaded\n');
}
```

Register in `src/cli.ts`:
```ts
  program.command('psql').description('Interactive psql in the project container').argument('<slug>').option('--admin', 'connect as the superuser', false)
    .action(async function (this: Command, slug: string, opts: { admin: boolean }) {
      const code = await psqlCommand(await depsFactory(io), slug, opts.admin);
      if (code !== 0) throw new DbmError(`psql exited with ${code}`, ExitCode.RemoteFailure, 'psql');
    });
  program.command('sync-pgbouncer', { hidden: true }).description('Re-render PgBouncer config from state and reload')
    .action(async () => { await syncPgbouncerCommand(await depsFactory(io)); });
```

- [ ] **Step 4: Run tests, expect pass; commit**

Run: `npx vitest run --project unit test/commands/psql.test.ts && npm run typecheck`

```bash
git add src/commands/psql.ts src/commands/sync-pgbouncer.ts src/cli.ts test/commands/psql.test.ts
git commit -m "feat: psql and sync-pgbouncer commands"
```

### Task 19: `storage public` and `storage cors`

**Spec:** 5.4, 7 (`storage`). **Research:** `garage-s3.md` (web endpoint resolves by Host; `AddBucketAlias` for vanity hosts).

**Files:**
- Create: `src/commands/storage.ts`, `test/commands/storage.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `storagePublicCommand(deps, { slug, domain?, off }): Promise<{ publicBaseUrl?: string; hosts: string[] }>`, `storageCorsCommand(deps, { slug, origins }): Promise<string[]>`.

- [ ] **Step 1: Confirm `renderHttpRouter` already takes `hosts: string[]`** (Task 7). Nothing to change.

- [ ] **Step 2: Write the failing tests**

`test/commands/storage.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { storageCorsCommand, storagePublicCommand } from '../../src/commands/storage.js';
import { upsertProject } from '../../src/core/state.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../unit/state.test.js';

function seeded() {
  const t = makeTestDeps();
  t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
  t.garage.buckets.set('b1', { id: 'b1', globalAliases: ['my-app'], bytes: 0, objects: 0, unfinishedUploads: 0, websiteAccess: false });
  return t;
}

describe('storage public', () => {
  it('enables website access, writes a Traefik router for <slug>.web.<domain>, saves publicBaseUrl', async () => {
    const t = seeded();
    const r = await storagePublicCommand(t.deps, { slug: 'my-app', off: false });
    expect(r.publicBaseUrl).toBe('https://my-app.web.example.com');
    expect(t.garage.calls).toEqual(['updateBucket']);
    expect(t.garage.buckets.get('b1')?.websiteAccess).toBe(true);
    const up = t.runner.uploads[0];
    expect(up?.path).toBe('/etc/dokploy/traefik/dynamic/dbm-web-my-app.yml');
    expect(up?.content).toContain('rule: Host(`my-app.web.example.com`)');
    expect(up?.content).toContain('- url: http://dbm-garage:3902');
    expect(t.store.state.projects['my-app']?.storage?.publicBaseUrl).toBe('https://my-app.web.example.com');
  });
  it('--domain adds a bucket alias and routes both hosts; --off reverses everything', async () => {
    const t = seeded();
    await storagePublicCommand(t.deps, { slug: 'my-app', domain: 'assets.myapp.com', off: false });
    expect(t.garage.calls).toEqual(['updateBucket', 'addBucketAlias']);
    expect(t.runner.uploads[0]?.content).toContain('Host(`my-app.web.example.com`) || Host(`assets.myapp.com`)');
    expect(t.store.state.projects['my-app']?.storage?.aliases).toEqual(['assets.myapp.com']);
    const r = await storagePublicCommand(t.deps, { slug: 'my-app', off: true });
    expect(r.publicBaseUrl).toBeUndefined();
    expect(t.garage.calls.slice(2)).toEqual(['removeBucketAlias', 'updateBucket']);
    expect(t.runner.calls.map((c) => c.argv.join(' '))).toContain('rm -f /etc/dokploy/traefik/dynamic/dbm-web-my-app.yml');
    expect(t.store.state.projects['my-app']?.storage?.publicBaseUrl).toBeUndefined();
    expect(t.store.state.projects['my-app']?.storage?.aliases).toEqual([]);
  });
  it('errors for projects without storage', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('a1', { storage: undefined }));
    await expect(storagePublicCommand(t.deps, { slug: 'a1', off: false })).rejects.toMatchObject({ exitCode: 1 });
  });
});

describe('storage cors', () => {
  it('replaces the CORS rule and saves origins', async () => {
    const t = seeded();
    expect(await storageCorsCommand(t.deps, { slug: 'my-app', origins: ['https://app.example.com'] })).toEqual(['https://app.example.com']);
    expect(t.garage.calls).toEqual(['updateBucket']);
    expect(t.store.state.projects['my-app']?.storage?.corsOrigins).toEqual(['https://app.example.com']);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run --project unit test/commands/storage.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `src/commands/storage.ts`**

```ts
import { userError } from '../core/exit.js';
import { deriveNames, webHost } from '../core/naming.js';
import { type Project, getProject, upsertProject } from '../core/state.js';
import { renderHttpRouter } from '../core/traefik.js';
import type { Deps } from './context.js';

function requireStorage(p: Project): NonNullable<Project['storage']> {
  if (!p.storage) throw userError(`${p.slug} was created with --no-storage`, 'storage');
  return p.storage;
}

export async function storagePublicCommand(deps: Deps, o: { slug: string; domain?: string; off: boolean }): Promise<{ publicBaseUrl?: string; hosts: string[] }> {
  const state = await deps.store.loadState();
  const p = getProject(state, o.slug);
  const storage = requireStorage(p);
  const names = deriveNames(p.slug);
  const routerFile = `${deps.cfg.remote.traefikDynamicDir}/${names.traefikWebFile}`;
  const primaryHost = webHost(p.slug, deps.cfg.webDomain);

  if (o.off) {
    for (const alias of storage.aliases) await deps.garage.removeBucketAlias(storage.bucketId, alias);
    await deps.garage.updateBucket(storage.bucketId, { websiteAccess: { enabled: false } });
    await deps.ssh.run(['rm', '-f', routerFile]);
    const { publicBaseUrl: _drop, ...rest } = storage;
    await deps.store.saveState(upsertProject(state, { ...p, storage: { ...rest, aliases: [] } }));
    deps.io.err(`${p.slug} bucket is private again\n`);
    return { hosts: [] };
  }

  await deps.garage.updateBucket(storage.bucketId, { websiteAccess: { enabled: true, indexDocument: 'index.html', errorDocument: '404.html' } });
  const aliases = [...storage.aliases];
  if (o.domain && !aliases.includes(o.domain)) {
    await deps.garage.addBucketAlias(storage.bucketId, o.domain);
    aliases.push(o.domain);
  }
  const hosts = [primaryHost, ...aliases];
  await deps.ssh.upload(routerFile, renderHttpRouter({ name: `dbm-web-${p.slug}`, hosts, serviceUrl: `http://${deps.cfg.remote.garageContainer}:3902` }), { mode: '0644' });
  const publicBaseUrl = `https://${primaryHost}`;
  await deps.store.saveState(upsertProject(state, { ...p, storage: { ...storage, publicBaseUrl, aliases } }));
  deps.io.err(`public at ${publicBaseUrl}${aliases.length ? ` (also ${aliases.join(', ')}; point their DNS at the VPS)` : ''}\n`);
  return { publicBaseUrl, hosts };
}

export async function storageCorsCommand(deps: Deps, o: { slug: string; origins: string[] }): Promise<string[]> {
  if (!o.origins.length) throw userError('at least one --origin is required', 'storage.cors');
  const state = await deps.store.loadState();
  const p = getProject(state, o.slug);
  const storage = requireStorage(p);
  await deps.garage.updateBucket(storage.bucketId, {
    corsRules: [{ allowedOrigins: o.origins, allowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'], allowedHeaders: ['*'], exposeHeaders: ['ETag'], maxAgeSeconds: 3600 }],
  });
  await deps.store.saveState(upsertProject(state, { ...p, storage: { ...storage, corsOrigins: o.origins } }));
  return o.origins;
}
```

Register in `src/cli.ts`:
```ts
  const storage = program.command('storage').description('Bucket visibility and CORS');
  storage.command('public').argument('<slug>').option('--domain <host>', 'also serve on a vanity hostname').option('--off', 'make private again', false)
    .action(async function (this: Command, slug: string, opts: { domain?: string; off: boolean }) {
      const g = globals(this);
      const r = await storagePublicCommand(await depsFactory(io), { slug, off: opts.off, ...(opts.domain ? { domain: opts.domain } : {}) });
      emit(io, g, r, r.publicBaseUrl ? `S3_PUBLIC_BASE_URL=${r.publicBaseUrl}\n` : 'private\n');
    });
  storage.command('cors').argument('<slug>').requiredOption('--origin <origin...>', 'allowed origins')
    .action(async function (this: Command, slug: string, opts: { origin: string[] }) {
      const g = globals(this);
      const origins = await storageCorsCommand(await depsFactory(io), { slug, origins: opts.origin });
      emit(io, g, { origins }, `${origins.join('\n')}\n`);
    });
```

- [ ] **Step 5: Run tests, expect pass; commit**

Run: `npx vitest run --project unit && npm run typecheck && npm run lint`

```bash
git add src/commands/storage.ts src/cli.ts test/commands/storage.test.ts
git commit -m "feat: storage public (web endpoint + traefik router) and storage cors commands"
```

### Task 20: `doctor`

**Spec:** 7 (`doctor`), 3 (minimum versions), 12.

**Files:**
- Create: `src/commands/doctor.ts`, `test/commands/doctor.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `Check { name: string; ok: boolean; level: 'fail' | 'warn'; detail: string }`, `doctorCommand(deps): Promise<{ checks: Check[]; ok: boolean }>`, `versionAtLeast(actual: string, floor: string): boolean`, `MIN_VERSIONS`.

- [ ] **Step 1: Write the failing tests**

`test/commands/doctor.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { doctorCommand, versionAtLeast } from '../../src/commands/doctor.js';
import { renderPgbouncerIni, renderUserlist } from '../../src/core/pgbouncer.js';
import { upsertProject } from '../../src/core/state.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../unit/state.test.js';

const p = fakeProject('my-app');
const ini = renderPgbouncerIni([p], { certDir: '/certs/db.example.com' });
const userlist = renderUserlist([p]);
const in60d = new Date(Date.now() + 60 * 86400_000).toISOString();

function healthyRunner(over: Array<{ match: RegExp; stdout?: string; fail?: boolean }> = []) {
  return makeFakeRunner([
    ...over,
    { match: /^true$/, stdout: '' },
    { match: /pgbouncer --version/, stdout: 'PgBouncer 1.26.0\nlibevent 2.1.12' },
    { match: /cat \/etc\/dokploy\/dbm\/pgbouncer\/pgbouncer\.ini/, stdout: ini },
    { match: /cat \/etc\/dokploy\/dbm\/pgbouncer\/userlist\.txt/, stdout: userlist },
    { match: /openssl s_client/, stdout: 'notAfter=Dec 29 12:00:00 2026 GMT\nsubject=CN = db.example.com' },
    { match: /openssl x509 -in/, stdout: 'notAfter=Dec 29 12:00:00 2026 GMT' },
    { match: /docker info --format/, stdout: 'json-file' },
    { match: /cat \/etc\/docker\/daemon\.json/, stdout: '{"log-opts":{"max-size":"10m"}}' },
    { match: /tailscale status --json/, stdout: JSON.stringify({ BackendState: 'Running', Self: { KeyExpiry: in60d, DNSName: 'vps.tail.ts.net.' } }) },
    { match: /df --output=pcent/, stdout: 'Use%\n 41%' },
    { match: /docker ps -q --filter label=/, stdout: 'c1' },
    { match: /docker inspect --format/, stdout: '[{"Type":"volume","Name":"pg-my-app-abc123-data","Destination":"/var/lib/postgresql"}]' },
    { match: /show server_version/, stdout: '18.6 (Debian 18.6-1.pgdg13+1)' },
    { match: /show data_directory/, stdout: '/var/lib/postgresql/18/docker' },
  ]);
}

describe('doctor', () => {
  it('passes on a healthy stack', async () => {
    const t = makeTestDeps({ runner: healthyRunner() });
    t.store.state = upsertProject(t.store.state, p);
    t.pg.runSql = async (_t, sql) => (sql.includes('server_version') ? '18.6 (Debian)' : '/var/lib/postgresql/18/docker');
    t.garage.buckets.set('b1', { id: 'b1', globalAliases: ['my-app'], bytes: 0, objects: 0, unfinishedUploads: 0, websiteAccess: false });
    t.dokploy.files = [{ Path: 'x', Name: 'x', Size: 1, ModTime: t.deps.now().toISOString() }];
    const r = await doctorCommand(t.deps);
    const failed = r.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual(expect.arrayContaining([
      'ssh', 'dokploy.version', 'pgbouncer.version', 'pgbouncer.drift', 'tls.cert', 'garage.health', 'docker.logging',
      'tailscale', 'disk', 'my-app.postgres.version', 'my-app.postgres.datadir', 'my-app.backup.age', 'my-app.storage.uploads',
    ]));
  });
  it('fails on an old PgBouncer and warns on a stale backup', async () => {
    const t = makeTestDeps({ runner: healthyRunner([{ match: /pgbouncer --version/, stdout: 'PgBouncer 1.25.2' }]) });
    t.store.state = upsertProject(t.store.state, p);
    t.pg.runSql = async (_t, sql) => (sql.includes('server_version') ? '18.6' : '/var/lib/postgresql/18/docker');
    t.dokploy.files = [{ Path: 'x', Name: 'x', Size: 1, ModTime: '2026-09-01T00:00:00Z' }];
    const r = await doctorCommand(t.deps);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'pgbouncer.version')).toMatchObject({ ok: false, level: 'fail' });
    expect(r.checks.find((c) => c.name === 'my-app.backup.age')).toMatchObject({ ok: false, level: 'warn' });
  });
  it('versionAtLeast', () => {
    expect(versionAtLeast('0.30.8', '0.30.0')).toBe(true);
    expect(versionAtLeast('0.29.13', '0.30.0')).toBe(false);
    expect(versionAtLeast('18.6', '18.6')).toBe(true);
    expect(versionAtLeast('17.10', '17.11')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/commands/doctor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/commands/doctor.ts`**

```ts
import { deriveNames } from '../core/naming.js';
import { renderPgbouncerIni, renderUserlist } from '../core/pgbouncer.js';
import { type Project, listProjects } from '../core/state.js';
import { type Deps, adminTarget } from './context.js';

export interface Check {
  name: string;
  ok: boolean;
  level: 'fail' | 'warn';
  detail: string;
}

export const MIN_VERSIONS = { dokploy: '0.30.0', pgbouncer: '1.26.0', pg18: '18.6', pg17: '17.11' } as const;
const DAY = 86_400_000;

export function versionAtLeast(actual: string, floor: string): boolean {
  const a = actual.match(/\d+(\.\d+)*/)?.[0].split('.').map(Number) ?? [];
  const f = floor.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, f.length); i++) {
    const x = a[i] ?? 0;
    const y = f[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function parseNotAfter(out: string): Date | undefined {
  const m = out.match(/notAfter=(.+)/);
  if (!m?.[1]) return undefined;
  const d = new Date(m[1].trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function doctorCommand(deps: Deps): Promise<{ checks: Check[]; ok: boolean }> {
  const checks: Check[] = [];
  const now = deps.now().getTime();
  const add = (name: string, ok: boolean, detail: string, level: 'fail' | 'warn' = 'fail') => {
    checks.push({ name, ok, level, detail });
  };
  const attempt = async (name: string, fn: () => Promise<void>, level: 'fail' | 'warn' = 'fail') => {
    try {
      await fn();
    } catch (e) {
      add(name, false, e instanceof Error ? e.message.split('\n')[0] ?? '' : String(e), level);
    }
  };
  const { remote } = deps.cfg;
  const state = await deps.store.loadState();
  const projects = listProjects(state);

  await attempt('ssh', async () => { await deps.ssh.run(['true']); add('ssh', true, `${deps.cfg.sshUser}@${deps.cfg.sshHost}`); });
  await attempt('dokploy.version', async () => {
    const v = await deps.dokploy.getVersion();
    add('dokploy.version', versionAtLeast(v, MIN_VERSIONS.dokploy), `${v} (min ${MIN_VERSIONS.dokploy})`);
  });
  await attempt('pgbouncer.version', async () => {
    const r = await deps.ssh.run(['docker', 'exec', remote.pgbouncerContainer, 'pgbouncer', '--version']);
    const v = r.stdout.match(/PgBouncer\s+(\S+)/)?.[1] ?? '?';
    add('pgbouncer.version', versionAtLeast(v, MIN_VERSIONS.pgbouncer), `${v} (min ${MIN_VERSIONS.pgbouncer})`);
  });
  await attempt('pgbouncer.drift', async () => {
    const ini = (await deps.ssh.run(['cat', `${remote.pgbouncerConfDir}/pgbouncer.ini`])).stdout;
    const ul = (await deps.ssh.run(['cat', `${remote.pgbouncerConfDir}/userlist.txt`])).stdout;
    const same = ini.trim() === renderPgbouncerIni(projects, { certDir: `/certs/${deps.cfg.dbHost}` }).trim() && ul.trim() === renderUserlist(projects).trim();
    add('pgbouncer.drift', same, same ? 'files match state' : 'files differ from state; run `dbm sync-pgbouncer`');
  });
  await attempt('tls.cert', async () => {
    const served = await deps.ssh.run(['sh', '-c', `openssl s_client -connect 127.0.0.1:6432 -starttls postgres -servername ${deps.cfg.dbHost} </dev/null 2>/dev/null | openssl x509 -noout -enddate -subject`]);
    const onDisk = await deps.ssh.run(['openssl', 'x509', '-in', `${remote.certsDir}/${deps.cfg.dbHost}/certificate.crt`, '-noout', '-enddate']);
    const servedExp = parseNotAfter(served.stdout);
    const diskExp = parseNotAfter(onDisk.stdout);
    if (!servedExp) throw new Error(`could not read served certificate: ${served.stdout}`);
    const daysLeft = Math.floor((servedExp.getTime() - now) / DAY);
    const matchesDisk = diskExp !== undefined && Math.abs(diskExp.getTime() - servedExp.getTime()) < 1000;
    add('tls.cert', daysLeft > 14 && served.stdout.includes(deps.cfg.dbHost) && matchesDisk,
      `${daysLeft} days left; served cert ${matchesDisk ? 'matches' : 'DIFFERS FROM'} file on disk`);
  });
  await attempt('garage.health', async () => { add('garage.health', await deps.garage.health(), '/health'); });
  await attempt('docker.logging', async () => {
    const driver = (await deps.ssh.run(['docker', 'info', '--format', '{{.LoggingDriver}}'])).stdout.trim();
    const daemon = (await deps.ssh.run(['cat', '/etc/docker/daemon.json'])).stdout;
    add('docker.logging', driver === 'json-file' && daemon.includes('max-size'), `${driver}, rotation ${daemon.includes('max-size') ? 'on' : 'OFF'}`);
  }, 'warn');
  await attempt('tailscale', async () => {
    const st = JSON.parse((await deps.ssh.run(['tailscale', 'status', '--json'])).stdout) as { BackendState: string; Self?: { KeyExpiry?: string | null; DNSName?: string } };
    const exp = st.Self?.KeyExpiry ? new Date(st.Self.KeyExpiry).getTime() : undefined;
    const days = exp ? Math.floor((exp - now) / DAY) : undefined;
    add('tailscale', st.BackendState === 'Running' && (days === undefined || days > 14), `${st.BackendState}, key ${days === undefined ? 'never expires' : `expires in ${days}d`}`);
  });
  await attempt('disk', async () => {
    const out = (await deps.ssh.run(['df', '--output=pcent', '/'])).stdout;
    const pct = Number(out.trim().split('\n').at(-1)?.replace('%', '').trim());
    add('disk', pct < 85, `${pct}% used`);
  });

  for (const p of projects) {
    if (p.status !== 'running') { add(`${p.slug}.status`, true, p.status, 'warn'); continue; }
    await attempt(`${p.slug}.postgres.version`, async () => {
      const v = (await deps.pg.runSql(adminTarget(p), 'show server_version;')).trim();
      const floor = p.pgMajor === 18 ? MIN_VERSIONS.pg18 : MIN_VERSIONS.pg17;
      add(`${p.slug}.postgres.version`, versionAtLeast(v, floor), `${v} (min ${floor})`);
    });
    await attempt(`${p.slug}.postgres.datadir`, async () => {
      const dataDir = (await deps.pg.runSql(adminTarget(p), 'show data_directory;')).trim();
      const container = await deps.pg.findContainer(p.dokploy.appName);
      const mounts = JSON.parse((await deps.ssh.run(['docker', 'inspect', '--format', '{{json .Mounts}}', container])).stdout) as Array<{ Destination: string }>;
      const covered = mounts.some((m) => dataDir === m.Destination || dataDir.startsWith(`${m.Destination}/`));
      add(`${p.slug}.postgres.datadir`, covered, covered ? `${dataDir} is on a volume` : `${dataDir} is NOT under any mount: data would be lost on recreate`);
    });
    await attempt(`${p.slug}.backup.age`, async () => {
      const files = await deps.dokploy.listBackupFiles(deps.cfg.dumpsDestinationId, `${p.dokploy.appName}/${deriveNames(p.slug).backupPrefix}/`);
      const newest = files.map((f) => new Date(f.ModTime).getTime()).sort().at(-1);
      const hours = newest ? Math.floor((now - newest) / 3_600_000) : undefined;
      add(`${p.slug}.backup.age`, hours !== undefined && hours < 36, hours === undefined ? 'no backups yet' : `${hours}h ago`, 'warn');
    }, 'warn');
    if (p.storage) {
      await attempt(`${p.slug}.storage.uploads`, async () => {
        const b = await deps.garage.getBucket({ id: p.storage?.bucketId ?? '' });
        add(`${p.slug}.storage.uploads`, (b?.unfinishedUploads ?? 0) < 50, `${b?.unfinishedUploads ?? '?'} unfinished multipart uploads`, 'warn');
      }, 'warn');
    }
  }

  const ok = checks.every((c) => c.ok || c.level === 'warn');
  return { checks, ok };
}

export function externalChecks(cfg: Deps['cfg']): string {
  return [
    'Run from a machine outside the tailnet:',
    `  nc -zv -w3 ${cfg.sshHost} 3000   # must FAIL (dashboard hidden)`,
    `  nc -zv -w3 ${cfg.dbHost} 6432    # must succeed`,
    '',
  ].join('\n');
}
```

Register in `src/cli.ts`:
```ts
  program.command('doctor').description('Check versions, drift, TLS, backups, disk; exit 2 on failure')
    .action(async function (this: Command) {
      const g = globals(this);
      const deps = await depsFactory(io);
      const r = await doctorCommand(deps);
      const lines = r.checks.map((c) => `${c.ok ? pc.green('ok  ') : c.level === 'warn' ? pc.yellow('warn') : pc.red('FAIL')} ${c.name.padEnd(28)} ${c.detail}`).join('\n');
      emit(io, g, r, `${lines}\n\n${externalChecks(deps.cfg)}`);
      if (!r.ok) throw new DbmError('doctor found failures', ExitCode.RemoteFailure, 'doctor');
    });
```

- [ ] **Step 4: Run tests, expect pass; commit**

Run: `npx vitest run --project unit test/commands/doctor.test.ts && npm run typecheck`

```bash
git add src/commands/doctor.ts src/cli.ts test/commands/doctor.test.ts
git commit -m "feat: doctor command (versions, drift, TLS expiry, tailscale, disk, per-project data dir and backup age)"
```

### Task 21: `init`

**Spec:** 7 (`init`), 5.1, 5.3, 5.4, 5.5, 10. **Research:** `vps-hardening-tailscale-backups.md` (Tailscale steps, B2), `dokploy.md` (install, API key, compose, destination), `garage-s3.md` (scoped token).

`init` is a checkpointed sequence. Each step is idempotent and re-runnable; progress and intermediate values live in `~/.dbm/init-progress.json` (`{ done, values }`). External effects go through injectable adapters so the sequence is unit-tested with fakes; the real e2e is `scripts/e2e.sh` (Task 26).

**Files:**
- Create: `src/commands/init.ts`, `test/commands/init.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces:

```ts
export interface InitOptions {
  host: string; user?: string; domain: string; tls?: 'letsencrypt' | 'self-ca';
  hostname?: string; timezone?: string; tailscaleAuthKey?: string; dokployApiKey?: string;
  b2?: { endpoint: string; region: string; keyId: string; keySecret: string; dumpsBucket: string; storageBucket: string };
}
export interface InitAdapters {
  makeRunner: (host: string, user: string) => SshRunner;
  makeDokploy: (url: string, key: string) => DokployClient;
  makeGarage: (runner: SshRunner, port: number, token: string) => GarageAdmin;
  makeDeps: (cfg: Config, store: StateStore, io: Io) => Deps;
  prompt: (question: string, opts?: { secret?: boolean }) => Promise<string>;
  probePostgres: (o: { host: string; port: number; user: string; password: string; database: string; ca?: string }) => Promise<boolean>;
}
export async function initCommand(store: StateStore, io: Io, o: InitOptions, a?: InitAdapters): Promise<Config>;
export const INIT_STEPS = ['harden','tailscale','dokploy','apikey','project','garage','pgbouncer','destination','config','smoke'] as const;
```
- Consumes: `StateStore.loadInitProgress/saveInitProgress` (`InitProgress`), `DokployClient.listProjects`, `createCommand`, `destroyCommand`, `versionAtLeast`.

- [ ] **Step 1: Confirm prerequisites exist** (`InitProgress` in `store.ts` from Task 4, `DokployClient.listProjects` from Tasks 9/11, `FakeDokploy.projects` from Task 13). Nothing to change.

- [ ] **Step 2: Write the failing tests**

`test/commands/init.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Io } from '../../src/cli.js';
import { INIT_STEPS, type InitAdapters, initCommand } from '../../src/commands/init.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';
import { FakeDokploy, FakeGarage, MemoryStore, makeTestDeps } from '../helpers/fakes.js';

function harness() {
  const runner = makeFakeRunner([
    { match: /^bash -s$/, stdout: '[dbm] host hardening converged' },
    { match: /tailscale status --json/, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'dbm-vps.tail1234.ts.net.' } }) },
    { match: /docker service ls/, stdout: 'dokploy' },
    { match: /curl -s -o \/dev\/null -w %\{http_code\} http:\/\/127\.0\.0\.1:3000\//, stdout: '200' },
    { match: /openssl s_client -connect 127\.0\.0\.1:443/, stdout: "issuer=C = US, O = Let's Encrypt, CN = R13" },
    { match: /test -f \/etc\/dokploy\/dbm\/certs\/db\.example\.com\/certificate\.crt/, stdout: '' },
    { match: /pgbouncer --version/, stdout: 'PgBouncer 1.26.0' },
    { match: /--config \/c\.conf cat/, stdout: 'smoke-ok' },
  ]);
  const dokploy = new FakeDokploy();
  dokploy.files = [{ Path: 'pg-dbm-smoke-abc123/db/dbm-smoke/x.sql.gz', Name: 'x.sql.gz', Size: 1, ModTime: '2026-09-30T12:00:00Z' }];
  const garage = new FakeGarage();
  const store = new MemoryStore();
  const prompts: string[] = [];
  const errLines: string[] = [];
  const io: Io = { out: () => {}, err: (s) => { errLines.push(s); } };
  const adapters: InitAdapters = {
    makeRunner: () => runner.runner,
    makeDokploy: () => dokploy,
    makeGarage: () => garage,
    makeDeps: (cfg, st, io2) => makeTestDeps({ cfg, store: st as MemoryStore, dokploy, garage, runner, io: io2 }).deps,
    prompt: async (q) => { prompts.push(q); return q.includes('API') ? 'pasted-key' : 'answer'; },
    probePostgres: async () => true,
  };
  return { runner, dokploy, garage, store, prompts, errLines, io, adapters };
}

const opts = {
  host: '1.2.3.4', domain: 'example.com', tailscaleAuthKey: 'tskey-x',
  b2: { endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004', keyId: 'K', keySecret: 'S', dumpsBucket: 'dbm-dumps', storageBucket: 'dbm-storage' },
};

describe('init', () => {
  it('runs every step in order, persists checkpoints, saves config, and leaves no smoke project', async () => {
    const h = harness();
    const cfg = await initCommand(h.store, h.io, opts, h.adapters);
    expect(Object.keys(h.store.progress.done)).toEqual([...INIT_STEPS]);
    expect(cfg.dokployUrl).toBe('https://dbm-vps.tail1234.ts.net');
    expect(cfg.dokployApiKey).toBe('newkey'); // minted, not the pasted one
    expect(cfg.dbHost).toBe('db.example.com');
    expect(cfg.webDomain).toBe('web.example.com');
    expect(cfg.garageAdminToken).toBe('scoped');
    expect(cfg.dumpsDestinationId).toBe('d1');
    expect(h.prompts.some((q) => q.includes('API'))).toBe(true);
    const uploads = h.runner.uploads.map((u) => u.path);
    expect(uploads).toEqual(expect.arrayContaining([
      '/etc/dokploy/dbm/garage/garage.toml',
      '/etc/dokploy/traefik/dynamic/dbm-s3.yml',
      '/etc/dokploy/traefik/dynamic/dbm-db-cert.yml',
      '/etc/dokploy/dbm/pgbouncer/pgbouncer.ini',
      '/etc/dokploy/dbm/pgbouncer/userlist.txt',
      '/etc/cron.d/dbm-pgbouncer-reload',
      '/etc/dokploy/dbm/rclone/rclone.conf',
      '/etc/cron.d/dbm-storage-sync',
    ]));
    expect(h.dokploy.calls).toEqual(expect.arrayContaining(['createProject', 'createCompose', 'deployCompose', 'testDestination', 'createDestination', 'createApiKey']));
    expect(h.garage.calls).toEqual(expect.arrayContaining(['createAdminToken', 'createKey']));
    // smoke project created and destroyed
    expect(h.dokploy.calls.filter((c) => c === 'createPostgres')).toHaveLength(1);
    expect(h.dokploy.calls).toContain('removePostgres');
    expect(h.store.state.projects['dbm-smoke']).toBeUndefined();
    const harden = h.runner.calls.find((c) => c.argv.join(' ') === 'bash -s');
    expect(harden?.input).toContain('set -euo pipefail');
  });
  it('resumes: completed steps are skipped on re-run', async () => {
    const h = harness();
    h.store.progress = { done: { harden: true, tailscale: true, dokploy: true }, values: { tailnetUrl: 'https://dbm-vps.tail1234.ts.net' } };
    await initCommand(h.store, h.io, opts, h.adapters);
    expect(h.runner.calls.some((c) => c.argv.join(' ') === 'bash -s')).toBe(false);
    expect(h.errLines.join('')).toMatch(/skip harden/);
  });
  it('self-ca generates a CA on the VPS and stores the PEM', async () => {
    const h = harness();
    const runner = makeFakeRunner([
      // every `bash -s` (harden, tailscale install, CA generation) gets the PEM on stdout; only the CA step reads it
      { match: /^bash -s$/, stdout: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n' },
      { match: /tailscale status --json/, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'v.t.ts.net.' } }) },
      { match: /docker service ls/, stdout: 'dokploy' },
      { match: /http_code/, stdout: '200' },
      { match: /pgbouncer --version/, stdout: 'PgBouncer 1.26.0' },
      { match: /--config \/c\.conf cat/, stdout: 'smoke-ok' },
    ]);
    const cfg = await initCommand(h.store, h.io, { ...opts, tls: 'self-ca' }, { ...h.adapters, makeRunner: () => runner.runner, makeDeps: (cfg, st, io2) => makeTestDeps({ cfg, store: st as MemoryStore, dokploy: h.dokploy, garage: h.garage, runner, io: io2 }).deps });
    expect(cfg.tls).toBe('self-ca');
    expect(cfg.sslCaPem).toContain('BEGIN CERTIFICATE');
    expect(runner.uploads.map((u) => u.path)).not.toContain('/etc/dokploy/traefik/dynamic/dbm-db-cert.yml');
  });
  it('rejects a Dokploy older than 0.30.0', async () => {
    const h = harness();
    h.dokploy.getVersion = async () => '0.29.13';
    await expect(initCommand(h.store, h.io, opts, h.adapters)).rejects.toThrow(/0\.30\.0/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run --project unit test/commands/init.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `src/commands/init.ts`**

```ts
import { randomBytes } from 'node:crypto';
import type { Io } from '../cli.js';
import { makeDokployClient } from '../adapters/dokploy.js';
import { GARAGE_CLI_SCOPE, makeGarageAdmin } from '../adapters/garage.js';
import { makeSshRunner } from '../adapters/ssh.js';
import type { InitProgress, StateStore } from '../adapters/store.js';
import type { DokployClient, GarageAdmin, SshRunner } from '../adapters/types.js';
import { renderGarageCompose, renderPgbouncerCompose } from '../core/compose.js';
import type { Config, ConfigInput } from '../core/config.js';
import { userError } from '../core/exit.js';
import { renderGarageToml } from '../core/garage-config.js';
import { DEFAULT_HARDEN, renderHardenScript } from '../core/harden.js';
import { renderPgbouncerReloadCron, renderRcloneConf, renderStorageSyncCron } from '../core/host-files.js';
import { renderPgbouncerIni, renderUserlist } from '../core/pgbouncer.js';
import { randomSecret } from '../core/secrets.js';
import { renderDbCertRouter, renderHttpRouter } from '../core/traefik.js';
import { type Deps, makeDepsFromConfig, waitUntil } from './context.js';
import { createCommand } from './create.js';
import { destroyCommand } from './destroy.js';
import { versionAtLeast, MIN_VERSIONS } from './doctor.js';

export interface InitOptions {
  host: string;
  user?: string;
  domain: string;
  tls?: 'letsencrypt' | 'self-ca';
  hostname?: string;
  timezone?: string;
  tailscaleAuthKey?: string;
  dokployApiKey?: string;
  b2?: { endpoint: string; region: string; keyId: string; keySecret: string; dumpsBucket: string; storageBucket: string };
}

export interface InitAdapters {
  makeRunner: (host: string, user: string) => SshRunner;
  makeDokploy: (url: string, key: string) => DokployClient;
  makeGarage: (runner: SshRunner, port: number, token: string) => GarageAdmin;
  makeDeps: (cfg: Config, store: StateStore, io: Io) => Deps;
  prompt: (question: string, opts?: { secret?: boolean }) => Promise<string>;
  probePostgres: (o: { host: string; port: number; user: string; password: string; database: string; ca?: string }) => Promise<boolean>;
}

export const INIT_STEPS = ['harden', 'tailscale', 'dokploy', 'apikey', 'project', 'garage', 'pgbouncer', 'destination', 'config', 'smoke'] as const;

async function ttyPrompt(question: string, opts: { secret?: boolean } = {}): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: !opts.secret });
  try {
    return (await rl.question(`${question} `)).trim();
  } finally {
    rl.close();
  }
}

async function realProbePostgres(o: { host: string; port: number; user: string; password: string; database: string; ca?: string }): Promise<boolean> {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ host: o.host, port: o.port, user: o.user, password: o.password, database: o.database, ssl: { servername: o.host, ...(o.ca ? { ca: o.ca } : {}) }, connectionTimeoutMillis: 15_000 });
  try {
    await c.connect();
    const r = await c.query('select 1 as n');
    return r.rows[0]?.n === 1;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}

export const realInitAdapters: InitAdapters = {
  makeRunner: (host, user) => makeSshRunner({ host, user }),
  makeDokploy: (url, key) => makeDokployClient({ baseUrl: url, apiKey: key }),
  makeGarage: (runner, port, token) => makeGarageAdmin(runner, { port, token }),
  makeDeps: makeDepsFromConfig,
  prompt: ttyPrompt,
  probePostgres: realProbePostgres,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function initCommand(store: StateStore, io: Io, o: InitOptions, a: InitAdapters = realInitAdapters): Promise<Config> {
  const user = o.user ?? 'root';
  const tls = o.tls ?? 'letsencrypt';
  const hostname = o.hostname ?? 'dbm-vps';
  const timezone = o.timezone ?? DEFAULT_HARDEN.timezone;
  const dbHost = `db.${o.domain}`;
  const s3Host = `s3.${o.domain}`;
  const webDomain = `web.${o.domain}`;
  const remote = {
    pgbouncerConfDir: '/etc/dokploy/dbm/pgbouncer', certsDir: '/etc/dokploy/dbm/certs', garageConfDir: '/etc/dokploy/dbm/garage',
    rcloneConfDir: '/etc/dokploy/dbm/rclone', traefikDynamicDir: '/etc/dokploy/traefik/dynamic', dockerNetwork: 'dokploy-network',
    pgbouncerContainer: 'dbm-pgbouncer', garageContainer: 'dbm-garage', garageAdminPort: 3903, dbPort: 6432,
  };
  const ssh = a.makeRunner(o.host, user);
  const progress: InitProgress = await store.loadInitProgress();
  const v = progress.values;
  const need = (key: string): string => {
    const val = v[key];
    if (!val) throw userError(`init state is missing ${key}; delete ~/.dbm/init-progress.json to start over`, 'init');
    return val;
  };
  const b2 = async () => {
    if (o.b2) return o.b2;
    if (!v.b2Endpoint) {
      v.b2Endpoint = await a.prompt('Backblaze B2 S3 endpoint (https://s3.<region>.backblazeb2.com):');
      v.b2Region = await a.prompt('B2 region (e.g. us-west-004):');
      v.b2KeyId = await a.prompt('B2 application keyID (Read/Write on both buckets):');
      v.b2KeySecret = await a.prompt('B2 applicationKey:', { secret: true });
      v.b2DumpsBucket = await a.prompt('B2 bucket for database dumps (30-day delete rule):');
      v.b2StorageBucket = await a.prompt('B2 bucket for storage mirror (keep versions 30 days):');
    }
    return { endpoint: need('b2Endpoint'), region: need('b2Region'), keyId: need('b2KeyId'), keySecret: need('b2KeySecret'), dumpsBucket: need('b2DumpsBucket'), storageBucket: need('b2StorageBucket') };
  };
  const dokploy = () => a.makeDokploy(need('tailnetUrl'), need('dokployApiKey'));
  const findCompose = async (name: string) => {
    const p = await dokploy().getProject(need('dokployProjectId'));
    return p.environments.flatMap((e) => e.compose).find((c) => c.name === name)?.composeId;
  };
  const upsertCompose = async (name: string, composeFile: string, env: string) => {
    let composeId = await findCompose(name);
    if (!composeId) composeId = (await dokploy().createCompose({ name, appName: name, environmentId: need('dokployEnvironmentId'), composeFile, env })).composeId;
    await dokploy().updateCompose({ composeId, composeFile, env });
    await dokploy().deployCompose(composeId);
    return composeId;
  };

  const steps: Record<(typeof INIT_STEPS)[number], () => Promise<void>> = {
    async harden() {
      await ssh.run(['bash', '-s'], { input: renderHardenScript({ ...DEFAULT_HARDEN, timezone }), timeoutMs: 20 * 60_000 });
    },
    async tailscale() {
      await ssh.run(['bash', '-s'], { input: `set -e
if ! command -v tailscale >/dev/null 2>&1; then
  . /etc/os-release
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/\${VERSION_CODENAME}.noarmor.gpg" | tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/\${VERSION_CODENAME}.tailscale-keyring.list" | tee /etc/apt/sources.list.d/tailscale.list >/dev/null
  apt-get update -qq && apt-get install -y -qq tailscale
fi
systemctl enable --now tailscaled
`, timeoutMs: 10 * 60_000 });
      const status = () => ssh.run(['tailscale', 'status', '--json']).then((r) => JSON.parse(r.stdout) as { BackendState: string; Self?: { DNSName?: string } });
      let st = await status();
      if (st.BackendState !== 'Running') {
        const key = o.tailscaleAuthKey ?? (await a.prompt('Tailscale auth key (non-ephemeral, pre-approved, single-use):', { secret: true }));
        await ssh.upload('/root/.dbm-tskey', key, { mode: '0600' });
        await ssh.run(['sh', '-c', `tailscale up --auth-key=file:/root/.dbm-tskey --hostname=${hostname}; rm -f /root/.dbm-tskey`], { timeoutMs: 120_000 });
        st = await status();
      }
      await ssh.run(['tailscale', 'serve', '--bg', '--https=443', 'http://127.0.0.1:3000']);
      const fqdn = st.Self?.DNSName?.replace(/\.$/, '');
      if (!fqdn) throw userError('tailscale did not report a DNS name; enable MagicDNS in the admin console', 'init.tailscale');
      v.tailnetUrl = `https://${fqdn}`;
    },
    async dokploy() {
      const services = (await ssh.run(['docker', 'service', 'ls', '--format', '{{.Name}}']).catch(() => ({ stdout: '' }))).stdout;
      if (!services.split('\n').includes('dokploy')) {
        io.err('installing Dokploy (this takes a few minutes)...\n');
        await ssh.run(['sh', '-c', 'curl -sSL https://dokploy.com/install.sh | sh'], { timeoutMs: 20 * 60_000 });
      }
      await waitUntil(async () => {
        const code = (await ssh.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:3000/']).catch(() => ({ stdout: '000' }))).stdout.trim();
        return /^[23]\d\d$/.test(code);
      }, { timeoutMs: 300_000, intervalMs: 5_000, sleep, what: 'Dokploy on :3000', step: 'init.dokploy' });
    },
    async apikey() {
      const pasted = o.dokployApiKey ?? (await a.prompt(`Open ${need('tailnetUrl')} , create the admin account, then Settings -> API/CLI -> generate an API key with Rate limit OFF. Paste it:`, { secret: true }));
      const tmp = a.makeDokploy(need('tailnetUrl'), pasted);
      const version = await tmp.getVersion();
      if (!versionAtLeast(version, MIN_VERSIONS.dokploy)) throw userError(`Dokploy ${version} is too old; dbm needs >= ${MIN_VERSIONS.dokploy} (run the installer with 'sh -s update')`, 'init.apikey');
      const org = (await tmp.listOrganizations())[0];
      if (!org) throw userError('no Dokploy organization found for this key', 'init.apikey');
      v.dokployApiKey = await tmp.createApiKey({ name: 'dbm', organizationId: org.id });
      io.err('minted a dedicated "dbm" API key; you may revoke the pasted one in the dashboard\n');
    },
    async project() {
      const existing = (await dokploy().listProjects()).find((p) => p.name === 'dbm');
      if (existing) {
        v.dokployProjectId = existing.projectId;
        v.dokployEnvironmentId = existing.environments.find((e) => e.name === 'production')?.environmentId ?? existing.environments[0]?.environmentId ?? '';
      } else {
        const created = await dokploy().createProject('dbm');
        v.dokployProjectId = created.projectId;
        v.dokployEnvironmentId = created.environmentId;
      }
      need('dokployEnvironmentId');
    },
    async garage() {
      v.garageRpcSecret ??= randomBytes(32).toString('hex');
      v.garageMasterToken ??= randomSecret(32);
      await ssh.upload(`${remote.garageConfDir}/garage.toml`, renderGarageToml({ webDomain }), { mode: '0644' });
      await upsertCompose('dbm-garage', renderGarageCompose({ network: remote.dockerNetwork, garageConfDir: remote.garageConfDir, adminPort: remote.garageAdminPort }),
        `GARAGE_RPC_SECRET=${v.garageRpcSecret}\nGARAGE_ADMIN_TOKEN=${v.garageMasterToken}\n`);
      const master = a.makeGarage(ssh, remote.garageAdminPort, v.garageMasterToken);
      await waitUntil(() => master.health(), { timeoutMs: 180_000, intervalMs: 5_000, sleep, what: 'garage /health', step: 'init.garage' });
      if (!v.garageAdminToken) v.garageAdminToken = (await master.createAdminToken('dbm', GARAGE_CLI_SCOPE)).secretToken;
      if (!v.garageBackupKeyId) {
        const k = await master.createKey('dbm-backup');
        v.garageBackupKeyId = k.accessKeyId;
        v.garageBackupKeySecret = k.secretAccessKey;
      }
      await ssh.upload(`${remote.traefikDynamicDir}/dbm-s3.yml`, renderHttpRouter({ name: 'dbm-s3', hosts: [s3Host], serviceUrl: `http://${remote.garageContainer}:3900` }), { mode: '0644' });
    },
    async pgbouncer() {
      const certDir = `/certs/${dbHost}`;
      await ssh.upload(`${remote.pgbouncerConfDir}/pgbouncer.ini`, renderPgbouncerIni([], { certDir }), { mode: '0644' });
      await ssh.upload(`${remote.pgbouncerConfDir}/userlist.txt`, renderUserlist([]), { mode: '0644' });
      if (tls === 'letsencrypt') {
        await ssh.upload(`${remote.traefikDynamicDir}/dbm-db-cert.yml`, renderDbCertRouter(dbHost), { mode: '0644' });
        io.err(`waiting for Let's Encrypt certificate for ${dbHost} (DNS must already point here)...\n`);
        await waitUntil(async () => {
          const r = await ssh.run(['sh', '-c', `openssl s_client -connect 127.0.0.1:443 -servername ${dbHost} </dev/null 2>/dev/null | openssl x509 -noout -issuer`]).catch(() => ({ stdout: '' }));
          return /Let's Encrypt/.test(r.stdout);
        }, { timeoutMs: 300_000, intervalMs: 10_000, sleep, what: `certificate for ${dbHost}`, step: 'init.pgbouncer.cert' });
      } else {
        const r = await ssh.run(['bash', '-s'], { input: `set -e
d=${remote.certsDir}/${dbHost}; mkdir -p "$d"; cd "$d"
[ -f ca.key ] || openssl req -x509 -newkey rsa:4096 -nodes -days 3650 -keyout ca.key -out ca.crt -subj "/CN=dbm private CA" >/dev/null 2>&1
if [ ! -f privatekey.key ]; then
  openssl req -newkey rsa:2048 -nodes -keyout privatekey.key -out server.csr -subj "/CN=${dbHost}" -addext "subjectAltName=DNS:${dbHost}" >/dev/null 2>&1
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 -copy_extensions copy -out certificate.crt >/dev/null 2>&1
fi
chown -R 70:70 "$d"; chmod 600 privatekey.key
cat ca.crt
` });
        v.sslCaPem = r.stdout.trim().endsWith('-----END CERTIFICATE-----') ? `${r.stdout.trim()}\n` : r.stdout;
      }
      await upsertCompose('dbm-pgbouncer', renderPgbouncerCompose({ network: remote.dockerNetwork, pgbouncerConfDir: remote.pgbouncerConfDir, certsDir: remote.certsDir, traefikDynamicDir: remote.traefikDynamicDir, tls }), '');
      if (tls === 'letsencrypt') {
        await waitUntil(() => ssh.run(['test', '-f', `${remote.certsDir}/${dbHost}/certificate.crt`]).then(() => true, () => false),
          { timeoutMs: 180_000, intervalMs: 5_000, sleep, what: 'certs-dumper output', step: 'init.pgbouncer.dumper' });
      }
      await ssh.upload('/etc/cron.d/dbm-pgbouncer-reload', renderPgbouncerReloadCron({ certsDir: remote.certsDir, pgbouncerContainer: remote.pgbouncerContainer }), { mode: '0644' });
      await ssh.run(['sh', '-c', `chown -R 70:70 ${remote.certsDir}; chmod -R go-rwx ${remote.certsDir}; docker kill -s HUP ${remote.pgbouncerContainer} || true`]);
      await waitUntil(() => ssh.run(['docker', 'exec', remote.pgbouncerContainer, 'pgbouncer', '--version']).then(() => true, () => false),
        { timeoutMs: 120_000, intervalMs: 5_000, sleep, what: 'pgbouncer container', step: 'init.pgbouncer' });
    },
    async destination() {
      const b = await b2();
      const input = { name: 'dbm-dumps', provider: 'Other', accessKey: b.keyId, secretAccessKey: b.keySecret, bucket: b.dumpsBucket, region: b.region, endpoint: b.endpoint, additionalFlags: null };
      await dokploy().testDestination(input);
      if (!v.dumpsDestinationId) v.dumpsDestinationId = (await dokploy().createDestination(input)).destinationId;
      await ssh.upload(`${remote.rcloneConfDir}/rclone.conf`, renderRcloneConf({
        garage: { keyId: need('garageBackupKeyId'), keySecret: need('garageBackupKeySecret'), endpoint: `http://${remote.garageContainer}:3900` },
        b2: { endpoint: b.endpoint, region: b.region, keyId: b.keyId, keySecret: b.keySecret },
      }), { mode: '0600' });
      await ssh.upload('/etc/cron.d/dbm-storage-sync', renderStorageSyncCron({ network: remote.dockerNetwork, rcloneConfDir: remote.rcloneConfDir, storageBucket: b.storageBucket }), { mode: '0644' });
    },
    async config() {
      const cfg: ConfigInput = {
        sshHost: o.host, sshUser: user, dokployUrl: need('tailnetUrl'), dokployApiKey: need('dokployApiKey'),
        dokployProjectId: need('dokployProjectId'), dokployEnvironmentId: need('dokployEnvironmentId'),
        domain: o.domain, dbHost, s3Host, webDomain, garageAdminToken: need('garageAdminToken'), garageBackupKeyId: need('garageBackupKeyId'),
        dumpsDestinationId: need('dumpsDestinationId'), tls, ...(v.sslCaPem ? { sslCaPem: v.sslCaPem } : {}), remote,
      };
      await store.saveConfig(cfg);
    },
    async smoke() {
      const cfg = await store.requireConfig();
      const deps = a.makeDeps(cfg, store, io);
      io.err('smoke test: creating dbm-smoke...\n');
      const created = await createCommand(deps, { slug: 'dbm-smoke' });
      try {
        const p = created.project;
        for (const db of ['dbm-smoke', 'dbm-smoke_session']) {
          const ok = await a.probePostgres({ host: dbHost, port: 6432, user: p.postgres.appRole, password: p.postgres.appPassword, database: db, ...(cfg.sslCaPem ? { ca: cfg.sslCaPem } : {}) });
          if (!ok) throw userError(`could not connect to ${dbHost}:6432/${db} with certificate verification from this machine`, 'init.smoke.postgres');
        }
        if (p.storage) {
          const conf = `[g]\ntype = s3\nprovider = Other\nenv_auth = false\naccess_key_id = ${p.storage.keyId}\nsecret_access_key = ${p.storage.keySecret}\nendpoint = https://${s3Host}\nregion = garage\nforce_path_style = true\nno_check_bucket = true\n`;
          await ssh.upload('/root/.dbm-smoke-rclone.conf', conf, { mode: '0600' });
          await ssh.run(['sh', '-c', `printf smoke-ok | docker run --rm -i -v /root/.dbm-smoke-rclone.conf:/c.conf:ro rclone/rclone:1 --config /c.conf rcat g:${p.storage.bucket}/smoke.txt`]);
          const got = await ssh.run(['sh', '-c', `docker run --rm -v /root/.dbm-smoke-rclone.conf:/c.conf:ro rclone/rclone:1 --config /c.conf cat g:${p.storage.bucket}/smoke.txt; rm -f /root/.dbm-smoke-rclone.conf`]);
          if (got.stdout.trim() !== 'smoke-ok') throw userError(`S3 round-trip through https://${s3Host} failed: got ${JSON.stringify(got.stdout)}`, 'init.smoke.s3');
        }
        if (p.dokploy.backupId) {
          await deps.dokploy.manualBackup(p.dokploy.backupId);
          const files = await deps.dokploy.listBackupFiles(cfg.dumpsDestinationId, `${p.dokploy.appName}/db/dbm-smoke/`);
          if (!files.length) throw userError('manual backup ran but no object appeared in the dumps bucket', 'init.smoke.backup');
        }
      } finally {
        await destroyCommand(deps, { slug: 'dbm-smoke', purgeStorage: true, yes: true, confirmSlug: 'dbm-smoke' });
      }
    },
  };

  for (const name of INIT_STEPS) {
    if (progress.done[name]) {
      io.err(`skip ${name} (done)\n`);
      continue;
    }
    io.err(`== ${name}\n`);
    await steps[name]();
    progress.done[name] = true;
    await store.saveInitProgress(progress);
  }
  const cfg = await store.requireConfig();
  io.err(`\ninit complete.\n  dashboard: ${cfg.dokployUrl}\n  database:  ${cfg.dbHost}:6432 (TLS, ${cfg.tls})\n  storage:   https://${cfg.s3Host}\n\nFrom a machine outside the tailnet verify:\n  nc -zv -w3 ${o.host} 3000   # must FAIL\n  nc -zv -w3 ${cfg.dbHost} 6432  # must succeed\n`);
  return cfg;
}
```

Register in `src/cli.ts`:
```ts
  program.command('init').description('Bootstrap a fresh Ubuntu 24.04 VPS (hardening, Tailscale, Dokploy, Garage, PgBouncer, backups, smoke test)')
    .argument('<ssh-host>').requiredOption('--domain <domain>', 'base domain; needs db., s3., *.web. A records')
    .option('--user <user>', 'ssh user', 'root').option('--tls <mode>', 'letsencrypt|self-ca', 'letsencrypt')
    .option('--hostname <name>', 'tailscale machine name', 'dbm-vps').option('--timezone <tz>', 'server timezone', 'America/Argentina/Buenos_Aires')
    .option('--tailscale-auth-key <key>').option('--dokploy-api-key <key>')
    .option('--b2-endpoint <url>').option('--b2-region <region>').option('--b2-key-id <id>').option('--b2-key-secret <secret>')
    .option('--b2-dumps-bucket <name>').option('--b2-storage-bucket <name>')
    .action(async (host: string, opts: Record<string, string | undefined>) => {
      const tls = opts.tls === 'self-ca' ? 'self-ca' : 'letsencrypt';
      const b2 = opts.b2Endpoint && opts.b2Region && opts.b2KeyId && opts.b2KeySecret && opts.b2DumpsBucket && opts.b2StorageBucket
        ? { endpoint: opts.b2Endpoint, region: opts.b2Region, keyId: opts.b2KeyId, keySecret: opts.b2KeySecret, dumpsBucket: opts.b2DumpsBucket, storageBucket: opts.b2StorageBucket }
        : undefined;
      await initCommand(makeFileStore(), io, {
        host, domain: opts.domain ?? '', tls, user: opts.user ?? 'root', hostname: opts.hostname ?? 'dbm-vps', timezone: opts.timezone ?? 'America/Argentina/Buenos_Aires',
        ...(opts.tailscaleAuthKey ? { tailscaleAuthKey: opts.tailscaleAuthKey } : {}),
        ...(opts.dokployApiKey ? { dokployApiKey: opts.dokployApiKey } : {}),
        ...(b2 ? { b2 } : {}),
      });
    });
```

- [ ] **Step 5: Run tests, expect pass; lint; typecheck; commit**

Run: `npx vitest run --project unit && npm run typecheck && npm run lint`

```bash
git add src/commands/init.ts src/cli.ts test/commands/init.test.ts
git commit -m "feat: checkpointed init (harden, tailscale, dokploy, api key, garage, pgbouncer+TLS, destinations, smoke test)"
```

### Task 22: `import`

**Spec:** 7 (`import`), 13. **Research:** `app-stack-and-supabase-export.md` §"Supabase export procedure".

**Files:**
- Create: `src/commands/import.ts`, `test/commands/import.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `importCommand(deps, o: ImportOptions): Promise<ImportReport>`, `classifyErrors(stderr: string): ImportReport['errors']`, `importScript(o): string`.

```ts
export interface ImportOptions {
  slug: string; from: string; schemas?: string[];
  storage?: { endpoint: string; region: string; keyId: string; keySecret: string; bucket: string };
}
export interface ImportReport {
  slug: string; schemas: string[];
  errors: { authUsers: string[]; authUid: string[]; storageObjects: string[]; extensions: string[]; other: string[] };
  storageSynced: boolean;
}
```

- [ ] **Step 1: Write the failing tests**

`test/commands/import.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { classifyErrors, importCommand, importScript } from '../../src/commands/import.js';
import { upsertProject } from '../../src/core/state.js';
import { makeFakeRunner } from '../helpers/fake-runner.js';
import { makeTestDeps } from '../helpers/fakes.js';
import { fakeProject } from '../unit/state.test.js';

describe('classifyErrors', () => {
  it('groups psql errors by Supabase-specific cause', () => {
    const stderr = [
      'psql:/tmp/schema.sql:12: ERROR:  relation "auth.users" does not exist',
      'psql:/tmp/schema.sql:30: ERROR:  function auth.uid() does not exist',
      'psql:/tmp/schema.sql:44: ERROR:  relation "storage.objects" does not exist',
      'psql:/tmp/schema.sql:50: ERROR:  schema "extensions" does not exist',
      'psql:/tmp/schema.sql:60: ERROR:  type "vector" does not exist',
    ].join('\n');
    const e = classifyErrors(stderr);
    expect(e.authUsers).toHaveLength(1);
    expect(e.authUid).toHaveLength(1);
    expect(e.storageObjects).toHaveLength(1);
    expect(e.extensions).toHaveLength(1);
    expect(e.other).toEqual(['psql:/tmp/schema.sql:60: ERROR:  type "vector" does not exist']);
  });
});

describe('importScript', () => {
  it('dumps schema and data separately with the right flags and restores as the app role', () => {
    const s = importScript({ src: 'postgresql://postgres:pw@db.ref.supabase.co:5432/postgres', dst: 'postgresql://my_app_app:pw@pg-my-app-abc123:5432/my_app', schemas: ['public', 'extra'] });
    expect(s).toContain('--schema-only --no-owner --no-privileges --no-comments --no-publications --no-subscriptions --schema=public --schema=extra');
    expect(s).toContain('--data-only --no-owner --no-privileges --schema=public --schema=extra');
    expect(s).toContain("SET session_replication_role = replica");
    expect(s).toContain('---SCHEMA-ERRORS---');
    expect(s).toContain('---DATA-ERRORS---');
    expect(s).not.toContain('6543');
  });
});

describe('importCommand', () => {
  it('runs the script in a throwaway postgres:18 container with URLs on stdin and parses the report', async () => {
    const runner = makeFakeRunner([
      { match: /docker run --rm -i --network dokploy-network postgres:18 bash -s/, stdout: '---SCHEMA-ERRORS---\npsql:x: ERROR:  relation "auth.users" does not exist\n---DATA-ERRORS---\n---END---' },
      { match: /rclone\/rclone:1 --config \/dev\/stdin sync src:avatars dst:my-app/, stdout: '' },
    ]);
    const t = makeTestDeps({ runner });
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    const r = await importCommand(t.deps, {
      slug: 'my-app', from: 'postgresql://postgres:pw@db.ref.supabase.co:5432/postgres',
      storage: { endpoint: 'https://ref.storage.supabase.co/storage/v1/s3', region: 'us-east-1', keyId: 'K', keySecret: 'S', bucket: 'avatars' },
    });
    expect(r.errors.authUsers).toHaveLength(1);
    expect(r.storageSynced).toBe(true);
    const dump = t.runner.calls.find((c) => c.argv.join(' ').includes('bash -s'));
    expect(dump?.argv.join(' ')).not.toContain('pw@');
    expect(dump?.input).toContain('db.ref.supabase.co');
    expect(dump?.input).toContain('postgresql://my_app_app:apppw@pg-my-app-abc123:5432/my_app');
  });
  it('rejects the transaction pooler port', async () => {
    const t = makeTestDeps();
    t.store.state = upsertProject(t.store.state, fakeProject('my-app'));
    await expect(importCommand(t.deps, { slug: 'my-app', from: 'postgresql://u:p@aws-0-x.pooler.supabase.com:6543/postgres' })).rejects.toThrow(/6543/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit test/commands/import.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/commands/import.ts`**

```ts
import { IMAGES } from '../core/compose.js';
import { userError } from '../core/exit.js';
import { getProject } from '../core/state.js';
import type { Deps } from './context.js';

export interface ImportOptions {
  slug: string;
  from: string;
  schemas?: string[];
  storage?: { endpoint: string; region: string; keyId: string; keySecret: string; bucket: string };
}

export interface ImportReport {
  slug: string;
  schemas: string[];
  errors: { authUsers: string[]; authUid: string[]; storageObjects: string[]; extensions: string[]; other: string[] };
  storageSynced: boolean;
}

export function classifyErrors(stderr: string): ImportReport['errors'] {
  const e: ImportReport['errors'] = { authUsers: [], authUid: [], storageObjects: [], extensions: [], other: [] };
  for (const raw of stderr.split('\n')) {
    const line = raw.trim();
    if (!line || !/ERROR/.test(line)) continue;
    if (/auth\.users/.test(line)) e.authUsers.push(line);
    else if (/auth\.(uid|jwt|role)\(\)/.test(line)) e.authUid.push(line);
    else if (/storage\.(objects|buckets)/.test(line)) e.storageObjects.push(line);
    else if (/schema "extensions"|extensions\./.test(line)) e.extensions.push(line);
    else e.other.push(line);
  }
  return e;
}

export function importScript(o: { src: string; dst: string; schemas: string[] }): string {
  const schemaFlags = o.schemas.map((s) => `--schema=${s}`).join(' ');
  return `set -u
SRC='${o.src.replaceAll("'", "'\\''")}'
DST='${o.dst.replaceAll("'", "'\\''")}'
pg_dump "$SRC" --schema-only --no-owner --no-privileges --no-comments --no-publications --no-subscriptions ${schemaFlags} -f /tmp/schema.sql
pg_dump "$SRC" --data-only --no-owner --no-privileges ${schemaFlags} -f /tmp/data.sql
echo '---SCHEMA-ERRORS---'
psql "$DST" -v ON_ERROR_STOP=0 -q -f /tmp/schema.sql 2>&1 >/dev/null | grep -E 'ERROR|FATAL' || true
echo '---DATA-ERRORS---'
psql "$DST" -v ON_ERROR_STOP=0 -q -c 'SET session_replication_role = replica' -f /tmp/data.sql 2>&1 >/dev/null | grep -E 'ERROR|FATAL' || true
echo '---END---'
`;
}

export async function importCommand(deps: Deps, o: ImportOptions): Promise<ImportReport> {
  const p = getProject(await deps.store.loadState(), o.slug);
  if (/:6543(\/|$)/.test(o.from)) throw userError('use the direct connection or the session pooler (port 5432), never the transaction pooler (6543), for pg_dump', 'import');
  if (p.status !== 'running') throw userError(`${o.slug} is ${p.status}; resume it first`, 'import');
  const schemas = o.schemas?.length ? o.schemas : ['public'];
  const dst = `postgresql://${encodeURIComponent(p.postgres.appRole)}:${encodeURIComponent(p.postgres.appPassword)}@${p.dokploy.appName}:5432/${p.postgres.database}`;

  deps.io.err(`dumping ${schemas.join(', ')} from source and restoring into ${o.slug} (this can take a while)...\n`);
  const r = await deps.ssh.run(
    ['docker', 'run', '--rm', '-i', '--network', deps.cfg.remote.dockerNetwork, IMAGES.postgres18, 'bash', '-s'],
    { input: importScript({ src: o.from, dst, schemas }), timeoutMs: 60 * 60_000 },
  );
  const out = r.stdout;
  const schemaErr = out.split('---SCHEMA-ERRORS---')[1]?.split('---DATA-ERRORS---')[0] ?? '';
  const dataErr = out.split('---DATA-ERRORS---')[1]?.split('---END---')[0] ?? '';
  const errors = classifyErrors(`${schemaErr}\n${dataErr}`);

  let storageSynced = false;
  if (o.storage) {
    if (!p.storage) throw userError(`${o.slug} has no storage bucket (created with --no-storage)`, 'import.storage');
    deps.io.err(`syncing storage bucket ${o.storage.bucket} -> ${p.storage.bucket}...\n`);
    const conf = `[src]\ntype = s3\nprovider = Other\nenv_auth = false\naccess_key_id = ${o.storage.keyId}\nsecret_access_key = ${o.storage.keySecret}\nendpoint = ${o.storage.endpoint}\nregion = ${o.storage.region}\nforce_path_style = true\n\n[dst]\ntype = s3\nprovider = Other\nenv_auth = false\naccess_key_id = ${p.storage.keyId}\nsecret_access_key = ${p.storage.keySecret}\nendpoint = http://${deps.cfg.remote.garageContainer}:3900\nregion = garage\nforce_path_style = true\nno_check_bucket = true\n`;
    await deps.ssh.run(
      ['docker', 'run', '--rm', '-i', '--network', deps.cfg.remote.dockerNetwork, IMAGES.rclone, '--config', '/dev/stdin', 'sync', `src:${o.storage.bucket}`, `dst:${p.storage.bucket}`, '--size-only', '--transfers', '4'],
      { input: conf, timeoutMs: 6 * 60 * 60_000 },
    );
    storageSynced = true;
  }
  return { slug: o.slug, schemas, errors, storageSynced };
}

export function formatReport(r: ImportReport): string {
  const sec = (title: string, lines: string[], hint: string) =>
    lines.length ? `\n${title} (${lines.length})\n  hint: ${hint}\n${lines.map((l) => `  ${l}`).join('\n')}\n` : '';
  return [
    `import into ${r.slug}: schemas ${r.schemas.join(', ')}${r.storageSynced ? ', storage synced' : ''}`,
    sec('Foreign keys / references to auth.users', r.errors.authUsers, 'point them at better-auth\'s "user"(id) instead; see docs/migration-from-supabase.md#users'),
    sec('auth.uid() and friends', r.errors.authUid, 'drop RLS policies and defaults; authorization moves to server code'),
    sec('storage.objects / storage.buckets', r.errors.storageObjects, 'replace with S3 keys in your own table; files are in your Garage bucket'),
    sec('extensions schema', r.errors.extensions, 'use gen_random_uuid() (pgcrypto is installed) or add --extensions'),
    sec('Other errors', r.errors.other, 'review individually'),
    r.errors.authUsers.length + r.errors.authUid.length + r.errors.storageObjects.length + r.errors.extensions.length + r.errors.other.length === 0 ? '\nno errors\n' : '',
  ].join('');
}
```

Register in `src/cli.ts`:
```ts
  program.command('import').description('Import a Supabase (or any Postgres) database and optionally a storage bucket into a project')
    .argument('<slug>').requiredOption('--from <postgres-url>', 'source direct/session-pooler URL (port 5432)')
    .option('--schemas <list>', 'comma-separated schemas', 'public')
    .option('--storage-endpoint <url>').option('--storage-region <region>').option('--storage-key <id>').option('--storage-secret <secret>').option('--storage-bucket <name>')
    .action(async function (this: Command, slug: string, opts: Record<string, string | undefined>) {
      const g = globals(this);
      const storage = opts.storageEndpoint && opts.storageRegion && opts.storageKey && opts.storageSecret && opts.storageBucket
        ? { endpoint: opts.storageEndpoint, region: opts.storageRegion, keyId: opts.storageKey, keySecret: opts.storageSecret, bucket: opts.storageBucket }
        : undefined;
      const r = await importCommand(await depsFactory(io), { slug, from: opts.from ?? '', schemas: (opts.schemas ?? 'public').split(',').map((s) => s.trim()).filter(Boolean), ...(storage ? { storage } : {}) });
      emit(io, g, r, formatReport(r));
    });
```

- [ ] **Step 4: Run tests, expect pass; commit**

Run: `npx vitest run --project unit && npm run typecheck && npm run lint`

```bash
git add src/commands/import.ts src/cli.ts test/commands/import.test.ts
git commit -m "feat: import command (pg_dump/psql in a throwaway container, error report, storage sync)"
```

---

## Phase F — Deliverables

### Task 23: Next.js templates

**Spec:** 5.7, 11. **Research:** `app-stack-and-supabase-export.md` §"Template code" and `pgbouncer-postgres-tls.md` §"Recommended postgres.js config", `garage-s3.md` §"Recommended S3Client config". Where the two reports differ on pool sizing, the PgBouncer report wins (`max: 10`, `idle_timeout: 5`), because it cites Vercel's Fluid guidance directly.

Templates are copied verbatim by the skill; they are excluded from Biome. They must typecheck inside a real Next.js 16 project, which is verified in Step 3.

**Files:**
- Create: `templates/nextjs/lib/db.ts`, `templates/nextjs/lib/schema.ts`, `templates/nextjs/drizzle.config.ts`, `templates/nextjs/lib/auth.ts`, `templates/nextjs/lib/auth-client.ts`, `templates/nextjs/app/api/auth/[...all]/route.ts`, `templates/nextjs/lib/s3.ts`, `templates/nextjs/vercel.json`, `templates/nextjs/.env.example`, `templates/nextjs/README.md`, `test/unit/templates.test.ts`

- [ ] **Step 1: Write the template files**

`templates/nextjs/lib/db.ts`:
```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// DATABASE_URL=postgresql://<role>:<pw>@db.<domain>:6432/<slug>?sslmode=verify-full
// postgres.js copies sslmode into `ssl`; 'verify-full' keeps Node TLS defaults (chain + hostname verified).
// NEVER use sslmode=require here: postgres.js maps it to rejectUnauthorized:false (no verification).
// Private-CA setups (dbm init --tls self-ca) set DATABASE_SSL_CA to the CA PEM with \n escapes.
const ssl = process.env.DATABASE_SSL_CA
  ? { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, "\n") }
  : ("verify-full" as const);

const globalForDb = globalThis as unknown as { pgClient?: ReturnType<typeof postgres> };

export const client =
  globalForDb.pgClient ??
  postgres(process.env.DATABASE_URL!, {
    ssl,
    max: 10, // Vercel Fluid: never max:1; instances are shared across concurrent invocations
    idle_timeout: 5, // seconds; release PgBouncer slots quickly when an instance goes idle
    connect_timeout: 10,
    max_lifetime: 60 * 30,
    prepare: true, // PgBouncer >= 1.21 with max_prepared_statements handles protocol-level prepares
    connection: { application_name: process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "nextjs" },
  });

if (process.env.NODE_ENV !== "production") globalForDb.pgClient = client;

export const db = drizzle({ client, schema });
```

`templates/nextjs/lib/schema.ts`:
```ts
// App tables go here. better-auth's tables are generated into ./auth-schema.ts by `npm run auth:schema`.
export {};
```

`templates/nextjs/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";

// Migrations use the session-mode alias (DATABASE_URL_SESSION); the app uses DATABASE_URL (transaction mode).
export default defineConfig({
  dialect: "postgresql",
  schema: ["./lib/schema.ts", "./lib/auth-schema.ts"],
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL_SESSION ?? process.env.DATABASE_URL! },
});
```

`templates/nextjs/lib/auth.ts`:
```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import * as authSchema from "./auth-schema"; // generated: npx auth@latest generate --config lib/auth.ts --output lib/auth-schema.ts -y
import { db } from "./db";

export const auth = betterAuth({
  // Explicit baseURL prevents request-derived baseURL poisoning. Production: BETTER_AUTH_URL=https://app.example.com.
  // Previews: exact Vercel hosts only; never "*.vercel.app".
  baseURL: process.env.BETTER_AUTH_URL
    ? process.env.BETTER_AUTH_URL
    : {
        allowedHosts: [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL].filter((h): h is string => Boolean(h)),
        protocol: "https",
      },
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    autoSignIn: true,
    requireEmailVerification: false, // enable once sendVerificationEmail is wired
    revokeSessionsOnPasswordReset: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  rateLimit: {
    enabled: true,
    storage: "database", // memory storage is per-instance on Vercel
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 10, max: 3 },
      "/sign-up/email": { window: 60, max: 5 },
      "/request-password-reset": { window: 60, max: 3 },
    },
  },
  advanced: {
    useSecureCookies: true,
    database: { generateId: "uuid" }, // matches Supabase uuid ids for migrated users
    ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
  },
  plugins: [nextCookies()], // must be last
});
```

`templates/nextjs/lib/auth-client.ts`:
```ts
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
```

`templates/nextjs/app/api/auth/[...all]/route.ts`:
```ts
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const { GET, POST } = toNextJsHandler(auth);
```

`templates/nextjs/lib/s3.ts`:
```ts
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Garage behind Traefik, path-style, region "garage".
// requestChecksumCalculation / responseChecksumValidation MUST be WHEN_REQUIRED: since @aws-sdk/client-s3 3.729.0
// the SDK signs an empty-body CRC32 into presigned PUT URLs and Garage rejects the upload with 400 InvalidDigest.
export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT!,
  region: process.env.S3_REGION ?? "garage",
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
});

const Bucket = process.env.S3_BUCKET!;

/** Browser PUTs directly to this URL with the same Content-Type. Garage caps expiry at 7 days. */
export function getPresignedUploadUrl(key: string, contentType: string, expiresIn = 900) {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), { expiresIn });
}

export function getPresignedDownloadUrl(key: string, expiresIn = 900) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: key }), { expiresIn });
}

export function deleteObject(key: string) {
  return s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
}

/** Only for buckets made public with `dbm storage public <slug>`; served by Garage's web endpoint per host. */
export function publicUrl(key: string) {
  const base = process.env.S3_PUBLIC_BASE_URL;
  if (!base) throw new Error("Bucket is not public (S3_PUBLIC_BASE_URL unset)");
  return `${base}/${encodeURI(key)}`;
}
```

`templates/nextjs/vercel.json`:
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["gru1"]
}
```

`templates/nextjs/.env.example`:
```bash
# From `dbm env <slug>`
DATABASE_URL=postgresql://myapp_app:<pw>@db.example.com:6432/myapp?sslmode=verify-full
DATABASE_URL_SESSION=postgresql://myapp_app:<pw>@db.example.com:6432/myapp_session?sslmode=verify-full
S3_ENDPOINT=https://s3.example.com
S3_REGION=garage
S3_BUCKET=myapp
S3_ACCESS_KEY_ID=GK...
S3_SECRET_ACCESS_KEY=...
BETTER_AUTH_SECRET=<32 random bytes>
# Production only. Leave unset on preview so allowedHosts (VERCEL_URL) is used.
BETTER_AUTH_URL=https://app.example.com
# Only after `dbm storage public <slug>`
# S3_PUBLIC_BASE_URL=https://myapp.web.example.com
# Only with `dbm init --tls self-ca`
# DATABASE_SSL_CA=-----BEGIN CERTIFICATE-----\n...
```

`templates/nextjs/README.md`:
```markdown
# dbm Next.js templates

Copy into a Next.js 16 App Router project, then:

    npm i better-auth@^1.7.6 drizzle-orm@^0.45.3 postgres@^3.4.9 @aws-sdk/client-s3@^3.1144.0 @aws-sdk/s3-request-presigner@^3.1144.0
    npm i -D drizzle-kit@^0.31.11 auth@^1.7.6
    npx auth@latest generate --config lib/auth.ts --output lib/auth-schema.ts -y
    npx drizzle-kit push        # uses DATABASE_URL_SESSION

Keep `pg` out of the project: drizzle-kit prefers it over postgres.js when both are installed.
Add `"regions": ["gru1"]` via vercel.json (or vercel.ts if you already have one; only one config file is allowed).
```

- [ ] **Step 2: Write a guard test that the templates never regress on the two invariants**

`test/unit/templates.test.ts`:
```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('templates/nextjs', () => {
  const files = walk('templates/nextjs');
  it('never uses sslmode=require or rejectUnauthorized:false', () => {
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/sslmode=require\b/);
      expect(s, f).not.toMatch(/rejectUnauthorized:\s*false/);
    }
  });
  it('S3 client opts out of SDK checksums and uses path style', () => {
    const s = readFileSync('templates/nextjs/lib/s3.ts', 'utf8');
    expect(s).toContain('requestChecksumCalculation: "WHEN_REQUIRED"');
    expect(s).toContain('responseChecksumValidation: "WHEN_REQUIRED"');
    expect(s).toContain('forcePathStyle: true');
  });
  it('vercel.json pins gru1', () => {
    expect(JSON.parse(readFileSync('templates/nextjs/vercel.json', 'utf8'))).toEqual({ $schema: 'https://openapi.vercel.sh/vercel.json', regions: ['gru1'] });
  });
});
```

- [ ] **Step 3: Typecheck the templates inside a scratch Next.js project (manual, once)**

Run in `/tmp`:
```bash
npx --yes create-next-app@latest dbm-tpl --ts --app --no-tailwind --no-eslint --src-dir=false --import-alias '@/*' --use-npm --yes
cd dbm-tpl && cp -r <repo>/templates/nextjs/. . \
 && npm i better-auth@^1.7.6 drizzle-orm@^0.45.3 postgres@^3.4.9 @aws-sdk/client-s3@^3.1144.0 @aws-sdk/s3-request-presigner@^3.1144.0 \
 && npm i -D drizzle-kit@^0.31.11 auth@^1.7.6 \
 && BETTER_AUTH_SECRET=x DATABASE_URL=postgresql://u:p@localhost:6432/x npx auth@latest generate --config lib/auth.ts --output lib/auth-schema.ts -y \
 && npx tsc --noEmit
```
Expected: `tsc` clean. If better-auth's option names changed (1.7 renamed several), fix the template and record the change in `templates/nextjs/README.md`.

- [ ] **Step 4: Run tests; commit**

Run: `npx vitest run --project unit test/unit/templates.test.ts`

```bash
git add templates test/unit/templates.test.ts
git commit -m "feat: Next.js templates (drizzle+postgres.js verify-full, better-auth 1.7, Garage S3 client, gru1)"
```

### Task 24: Agent skill

**Spec:** 5.7.

**Files:**
- Create: `skills/dbm/SKILL.md`

- [ ] **Step 1: Write the skill**

```markdown
---
name: dbm
description: Provision a database + storage project on the operator's own VPS with the dbm CLI and wire a Next.js app to it (env vars, Vercel, Drizzle, better-auth, S3). Use when asked to "create a db for this app", "connect this project to dbm", "scaffold backend for an MVP", or to migrate off Supabase.
---

# dbm: personal database platform

`dbm` (npm `db-manager`) runs on the operator's machine and talks to their VPS. It prints the env vars a Next.js app needs. You never touch the VPS directly.

## Create a project and wire the app

1. Pick a slug: lowercase, starts with a letter, letters/digits/hyphens, 2-31 chars. Usually the app's folder name.
2. Run and parse:
   ```bash
   dbm create <slug> --json
   ```
   If it exits 1 with "already exists", run `dbm env <slug> --json` instead. The JSON has `env: { DATABASE_URL, DATABASE_URL_SESSION, S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, BETTER_AUTH_SECRET, BETTER_AUTH_URL, DATABASE_SSL_CA? }`.
3. Write every key to `.env.local` (create or merge; never commit it).
4. Push to Vercel, two calls per variable (production/preview default to sensitive; development cannot be combined):
   ```bash
   for k in DATABASE_URL DATABASE_URL_SESSION S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY BETTER_AUTH_SECRET; do
     vercel env add "$k" production,preview --value "${!k}" --yes --force
     vercel env add "$k" development       --value "${!k}" --yes --force
   done
   vercel env add BETTER_AUTH_URL production --value "https://<production-domain>" --yes --force
   ```
   Do not set `BETTER_AUTH_URL` for preview; the template falls back to `VERCEL_URL`.
5. Pin functions to São Paulo: add `templates/nextjs/vercel.json` (`"regions": ["gru1"]`). If the project already has `vercel.ts`, add `regions: ['gru1']` there instead; never keep both files.
6. Copy the templates from the dbm repo `templates/nextjs/` into the project (`lib/db.ts`, `lib/schema.ts`, `drizzle.config.ts`, `lib/auth.ts`, `lib/auth-client.ts`, `app/api/auth/[...all]/route.ts`, `lib/s3.ts`, `.env.example`). Keep them verbatim except for `lib/schema.ts`, where the app's tables go.
7. Install pinned dependencies:
   ```bash
   npm i better-auth@^1.7.6 drizzle-orm@^0.45.3 postgres@^3.4.9 @aws-sdk/client-s3@^3.1144.0 @aws-sdk/s3-request-presigner@^3.1144.0
   npm i -D drizzle-kit@^0.31.11 auth@^1.7.6
   ```
   Do not install `pg`; drizzle-kit would prefer it over postgres.js.
8. Generate the auth schema and push:
   ```bash
   npx auth@latest generate --config lib/auth.ts --output lib/auth-schema.ts -y
   npx drizzle-kit push
   ```
   `drizzle-kit` reads `DATABASE_URL_SESSION` (session-mode pooler). If push fails with a pooler error, stop and report it; do not switch to `DATABASE_URL`.
9. Add `"auth:schema"`, `"db:push"`, `"db:generate"`, `"db:migrate"` scripts as in `templates/nextjs/README.md`.

## Rules

- All database access is server-side (server components, server actions, route handlers). Never import `lib/db.ts` from a client component. There is no anon key.
- Browser uploads use presigned URLs from `lib/s3.ts`; the browser never sees S3 credentials.
- Public assets need `dbm storage public <slug>` (operator runs it) and then `S3_PUBLIC_BASE_URL` in env.
- Never use `sslmode=require` or `rejectUnauthorized: false`.
- If the operator asks to remove a project: `dbm destroy <slug>` is theirs to run; do not run it yourself.

## Other useful commands

`dbm list`, `dbm env <slug>`, `dbm pause|resume <slug>`, `dbm backup <slug>`, `dbm restore <slug> latest --as <staging-slug>`, `dbm doctor`, `dbm import <slug> --from <postgres-url> ...` (see `docs/migration-from-supabase.md`).
```

- [ ] **Step 2: Commit**

```bash
git add skills/dbm/SKILL.md
git commit -m "docs: dbm agent skill"
```

### Task 25: Documentation

**Spec:** 9, 12, 13, 16.

**Files:**
- Create: `README.md`, `docs/migration-from-supabase.md`, `docs/security.md`, `docs/runbook.md`

- [ ] **Step 1: README.md** with these sections, in this order, each 5-25 lines: What it is (one paragraph + the architecture diagram from spec §4); Why (Supabase free tiers, cost); Prerequisites (VPS Ubuntu 24.04 with root key; DNS `db.`, `s3.`, `*.web.`; Tailscale with MagicDNS + HTTPS certs and a non-ephemeral pre-approved single-use auth key; two B2 buckets with the exact lifecycle rules from spec §5.5 and one Read/Write app key; Node >= 22.12; Vercel CLI); Install (`npm i -g db-manager`, `npx db-manager`); Quick start (`dbm init 1.2.3.4 --domain example.com`, `dbm create myapp`, paste env, `vercel.json` gru1); Commands (one line each from spec §7); Where things live on the VPS (`/etc/dokploy/dbm/*`, `/etc/dokploy/traefik/dynamic/dbm-*.yml`, `/etc/cron.d/dbm-*`); Local files (`~/.dbm/`, back it up); Provider note (São Paulo vs Argentina trade-off, spec §3); Security summary linking `docs/security.md`; Recovery linking `docs/runbook.md`; Development (`npm test`, `npm run test:integration` needs Docker, `scripts/e2e.sh`); License.

- [ ] **Step 2: docs/migration-from-supabase.md**: spec §13 expanded with the exact commands from `research/app-stack-and-supabase-export.md` §"Supabase export procedure" and §"User migration approach" (the `scripts/migrate-supabase-users.ts` usage, the `lib/auth.ts` bcrypt `verify` + `hooks.after` rehash snippet, the SQL to detect when the hook can go, `npm i bcryptjs@^3.0.3`). Include the `dbm import` report categories and the fix for each. State that Supabase S3 keys bypass RLS and must never be committed.

- [ ] **Step 3: docs/security.md**: spec §9 tables and residual risks, plus "what to do if a project's connection string leaks" (`dbm psql <slug> --admin` → `ALTER ROLE ... PASSWORD`, then `dbm sync-pgbouncer` after updating state — note `dbm rotate` is future work) and "what to do if `~/.dbm` leaks" (revoke Dokploy key in dashboard, `garage admin-token delete` on the VPS, rotate app passwords).

- [ ] **Step 4: docs/runbook.md**: spec §12 table as step-by-step procedures, plus: manual PgBouncer reload; reading Dokploy backup logs; restoring Garage metadata from a snapshot (Garage docs "Replacement scenario 3"); recovering when `init` stops midway (`~/.dbm/init-progress.json`); the two external port checks; upgrading component versions (bump the pinned tag in `core/compose.ts`, redeploy the compose service from the Dokploy dashboard, run `dbm doctor`).

- [ ] **Step 5: Commit**

```bash
git add README.md docs/migration-from-supabase.md docs/security.md docs/runbook.md
git commit -m "docs: README, Supabase migration guide, security model, runbook"
```

### Task 26: Operational scripts

**Spec:** 15 (e2e), 12 (recover-storage), 13 (user migration).

**Files:**
- Create: `scripts/e2e.sh`, `scripts/recover-storage.sh`, `scripts/migrate-supabase-users.ts`

- [ ] **Step 1: scripts/e2e.sh**

```bash
#!/usr/bin/env bash
# End-to-end against a disposable VPS. Usage:
#   DBM_E2E_HOST=1.2.3.4 DBM_E2E_DOMAIN=example.com TS_AUTHKEY=tskey-... \
#   B2_ENDPOINT=... B2_REGION=... B2_KEY_ID=... B2_KEY_SECRET=... B2_DUMPS=... B2_STORAGE=... scripts/e2e.sh
set -euo pipefail
: "${DBM_E2E_HOST:?}" "${DBM_E2E_DOMAIN:?}" "${TS_AUTHKEY:?}" "${B2_ENDPOINT:?}" "${B2_REGION:?}" "${B2_KEY_ID:?}" "${B2_KEY_SECRET:?}" "${B2_DUMPS:?}" "${B2_STORAGE:?}"
export HOME="$(mktemp -d)"          # fresh ~/.dbm so the run never touches the operator's real state
DBM="node $(dirname "$0")/../bin/dbm.js"
npm run build >/dev/null

$DBM init "$DBM_E2E_HOST" --domain "$DBM_E2E_DOMAIN" --tailscale-auth-key "$TS_AUTHKEY" \
  --b2-endpoint "$B2_ENDPOINT" --b2-region "$B2_REGION" --b2-key-id "$B2_KEY_ID" --b2-key-secret "$B2_KEY_SECRET" \
  --b2-dumps-bucket "$B2_DUMPS" --b2-storage-bucket "$B2_STORAGE"

$DBM create e2e-app --json > /tmp/e2e-create.json
$DBM list
$DBM pause e2e-app && $DBM resume e2e-app
$DBM backup e2e-app
$DBM restore e2e-app latest --as e2e-clone
$DBM storage public e2e-app
$DBM doctor
$DBM destroy e2e-clone --purge-storage --yes --confirm e2e-clone
$DBM destroy e2e-app --purge-storage --yes --confirm e2e-app

echo "== Section 19 verifications (record results in docs/superpowers/research/e2e-<date>.md)"
ssh root@"$DBM_E2E_HOST" 'docker volume ls --format {{.Name}} | grep -c -- -data || true'   # expect 0 leftover project volumes
ssh root@"$DBM_E2E_HOST" 'docker exec $(docker ps -q -f name=dokploy) date -u'                 # cron timezone: UTC
echo "From OUTSIDE the tailnet: nc -zv -w3 $DBM_E2E_HOST 3000 (must fail); nc -zv -w3 db.$DBM_E2E_DOMAIN 6432 (must succeed)"
```

- [ ] **Step 2: scripts/recover-storage.sh**

```bash
#!/usr/bin/env bash
# Re-hydrate every project's Garage bucket from the off-site storage mirror after a VPS loss.
# Run on the NEW VPS after `dbm init` and `dbm restore <slug> latest --as <slug>` for each project.
# Usage: recover-storage.sh <slug>...   (reads /etc/dokploy/dbm/rclone/rclone.conf written by init; B2_STORAGE_BUCKET env required)
set -euo pipefail
: "${B2_STORAGE_BUCKET:?}"
for slug in "$@"; do
  echo "== $slug"
  docker run --rm --network dokploy-network -v /etc/dokploy/dbm/rclone/rclone.conf:/config/rclone/rclone.conf:ro rclone/rclone:1 \
    copy "b2:${B2_STORAGE_BUCKET}/storage/${slug}" "garage:${slug}" --fast-list --transfers 8
done
```
Note in the script header: the `garage` remote in `rclone.conf` uses the read-only `dbm-backup` key; for recovery the operator temporarily grants it `write` with `AllowBucketKey` (documented in `docs/runbook.md`) or edits the conf to use the project key from `dbm env`.

- [ ] **Step 3: scripts/migrate-supabase-users.ts**

Copy the script from `research/app-stack-and-supabase-export.md` §"User migration approach" verbatim, with a header comment: runs inside the target Next.js project (`npx tsx scripts/migrate-supabase-users.ts auth-users.csv`), needs `csv-parse`, is idempotent on `user.id`, skips rows whose hash does not match `^\$2[aby]\$` with a log line, and never prints hashes.

- [ ] **Step 4: chmod and commit**

```bash
chmod +x scripts/e2e.sh scripts/recover-storage.sh
git add scripts
git commit -m "chore: e2e, storage recovery and Supabase user migration scripts"
```

### Task 27: Release workflow, package smoke, final review

**Spec:** 5.6, 16. **Research:** `cli-tooling.md` §"CI workflow" (release-please + npm trusted publishing).

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `package.json` (`repository`, `homepage`, `bugs`, `keywords`)

- [ ] **Step 1: release.yml**

```yaml
name: release
on:
  push:
    branches: [main]
permissions:
  contents: write
  pull-requests: write
  issues: write
  id-token: write
jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - id: release
        uses: googleapis/release-please-action@v5
        with:
          release-type: node
      - uses: actions/checkout@v6
        if: ${{ steps.release.outputs.release_created }}
      - uses: actions/setup-node@v6
        if: ${{ steps.release.outputs.release_created }}
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
          cache: npm
      - run: npm ci
        if: ${{ steps.release.outputs.release_created }}
      - run: npm run build
        if: ${{ steps.release.outputs.release_created }}
      - run: npm publish
        if: ${{ steps.release.outputs.release_created }}
```
Document in README "Releasing": configure the trusted publisher on npmjs.com for `<owner>/db-manager`, workflow `release.yml`; the first `0.1.0` may need a one-off manual `npm publish --provenance` (Section 19 of the research: unverified whether trusted publishing works before the package exists).

- [ ] **Step 2: Fill package metadata** (`repository.url`, `homepage`, `bugs.url` with the real GitHub owner; `keywords`).

- [ ] **Step 3: Full verification**

Run, all must pass:
```bash
npm run lint && npm run typecheck && npm run test:unit && npm run build
npm pack --silent && npx --yes ./db-manager-*.tgz --help && rm -f db-manager-*.tgz
npm run test:integration
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml package.json
git commit -m "chore: release-please + npm trusted publishing workflow"
```

- [ ] **Step 5: Hand-off checklist for the operator (write into README "Status")**

- Run `scripts/e2e.sh` against a disposable VPS; record the Section 19 verification results in `docs/superpowers/research/e2e-<date>.md`.
- Re-record Dokploy fixtures from the live instance (Task 11 README).
- Confirm the Garage `corsRules` casing from the integration run and remove the caveat comment in `test/integration/stack.test.ts`.
- Decide provider (São Paulo vs Argentina), create DNS records and B2 buckets, then run `dbm init` for real.
