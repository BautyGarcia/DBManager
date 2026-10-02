import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// DATABASE_URL=postgresql://<role>:<pw>@db.<domain>:6432/<slug>?sslmode=verify-full
// postgres.js copies sslmode into `ssl`; 'verify-full' keeps Node TLS defaults (chain + hostname verified).
// Never use the 'require' ssl mode here: postgres.js then skips certificate verification entirely.
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
