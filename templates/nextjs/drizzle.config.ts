import { defineConfig } from "drizzle-kit";

// Migrations use the session-mode alias (DATABASE_URL_SESSION); the app uses DATABASE_URL (transaction mode).
export default defineConfig({
  dialect: "postgresql",
  schema: ["./lib/schema.ts", "./lib/auth-schema.ts"],
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL_SESSION ?? process.env.DATABASE_URL! },
});
