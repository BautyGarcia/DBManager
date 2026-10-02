# dbm Next.js templates

Copy into a Next.js 16 App Router project, then:

    npm i better-auth@^1.7.6 drizzle-orm@^0.45.3 postgres@^3.4.9 @aws-sdk/client-s3@^3.1144.0 @aws-sdk/s3-request-presigner@^3.1144.0
    npm i -D drizzle-kit@^0.31.11 auth@^1.7.6
    npx auth@latest generate --config lib/auth.ts --output lib/auth-schema.ts -y
    npx drizzle-kit push        # reads DATABASE_URL_SESSION from .env.local (drizzle.config.ts loads it)

Running `auth generate` needs a base URL: set `BETTER_AUTH_URL=http://localhost:3000` for that step if your .env lacks one.

Keep `pg` out of the project: drizzle-kit prefers it over postgres.js when both are installed.
Add `"regions": ["gru1"]` via vercel.json (or vercel.ts if you already have one; only one config file is allowed).
