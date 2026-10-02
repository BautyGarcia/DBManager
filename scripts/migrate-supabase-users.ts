// @ts-nocheck
// This script runs inside the TARGET Next.js project, not in the db-manager repo: it imports
// csv-parse and the project's own lib/db and lib/auth-schema, which do not exist here. The
// nocheck above keeps this repo's `tsc --noEmit` (which includes scripts/*.ts) green.
//
// Usage (from the target project, after `npm i -D csv-parse` and `drizzle-kit push`):
//   npx tsx scripts/migrate-supabase-users.ts auth-users.csv
//
// - Idempotent on user.id (onConflictDoNothing); safe to re-run.
// - Skips rows whose password hash does not match ^\$2[aby]\$ (non-bcrypt) with a log line.
// - Never prints password hashes.
// See docs/migration-from-supabase.md#users. Review before running.

import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { account, user } from '../lib/auth-schema';
import { db } from '../lib/db';

type Row = {
  id: string;
  email: string;
  encrypted_password: string | null;
  email_confirmed_at: string | null;
  raw_user_meta_data: string;
  created_at: string;
  updated_at: string;
};

const rows = parse(readFileSync(process.argv[2] ?? 'auth-users.csv'), { columns: true }) as Row[];

for (const r of rows) {
  const meta = r.raw_user_meta_data ? JSON.parse(r.raw_user_meta_data) : {};
  // Only bcrypt hashes (hosted Supabase) can be verified by the lib/auth.ts verify hook.
  if (r.encrypted_password && !/^\$2[aby]\$/.test(r.encrypted_password)) {
    console.warn(`skip ${r.id}: password hash is not bcrypt`); // never print the hash itself
    continue;
  }
  const createdAt = new Date(r.created_at);
  const updatedAt = new Date(r.updated_at || r.created_at);

  await db
    .insert(user)
    .values({
      id: r.id, // keep the Supabase uuid so app FKs survive
      email: r.email.toLowerCase(),
      emailVerified: r.email_confirmed_at != null,
      name: meta.full_name ?? meta.name ?? r.email.split('@')[0],
      image: meta.avatar_url ?? null,
      createdAt,
      updatedAt,
    })
    .onConflictDoNothing();

  if (r.encrypted_password) {
    await db
      .insert(account)
      .values({
        id: crypto.randomUUID(),
        userId: r.id,
        accountId: r.id, // credential accounts use user.id
        providerId: 'credential',
        password: r.encrypted_password, // bcrypt, stored as-is
        createdAt,
        updatedAt,
      })
      .onConflictDoNothing();
  }
  // OAuth identities (auth.identities) map to account rows with providerId = provider,
  // accountId = identity.provider_id; see the official guide for the join query.
}

console.log(`processed ${rows.length} rows`);
