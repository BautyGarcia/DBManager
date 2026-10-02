import { defineConfig } from "drizzle-kit";

// Migrations use the session-mode alias (DATABASE_URL_SESSION) only; the app uses DATABASE_URL
// (transaction mode), which drizzle-kit must never use.
const url = process.env.DATABASE_URL_SESSION;
if (!url) {
  throw new Error(
    "DATABASE_URL_SESSION is not set: copy it from `dbm env <slug>` into .env.local (drizzle-kit needs the session pooler)",
  );
}

// Same TLS policy as lib/db.ts: verify the chain and hostname; a private CA (dbm init --tls self-ca)
// comes in DATABASE_SSL_CA with \n escapes. drizzle-kit ignores `ssl` next to `url`, so the URL is
// split into its parts and `ssl` is passed alongside them.
const ssl = process.env.DATABASE_SSL_CA
  ? { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, "\n") }
  : ("verify-full" as const);
const u = new URL(url);

export default defineConfig({
  dialect: "postgresql",
  schema: ["./lib/schema.ts", "./lib/auth-schema.ts"],
  out: "./drizzle",
  dbCredentials: {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
    ssl,
  },
});
