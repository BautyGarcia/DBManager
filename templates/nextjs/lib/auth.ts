import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import * as authSchema from "./auth-schema"; // generated: npx auth@latest generate --config lib/auth.ts --output lib/auth-schema.ts -y
import { db } from "./db";

const vercelHosts = [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL].filter((h): h is string => Boolean(h));

export const auth = betterAuth({
  // Explicit baseURL prevents request-derived baseURL poisoning. Production: BETTER_AUTH_URL=https://app.example.com.
  // Previews: exact Vercel hosts only; never "*.vercel.app".
  baseURL: process.env.BETTER_AUTH_URL
    ? process.env.BETTER_AUTH_URL
    : vercelHosts.length
      ? { allowedHosts: vercelHosts, protocol: "https" }
      : "http://localhost:3000", // local development; dbm env leaves BETTER_AUTH_URL empty
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
