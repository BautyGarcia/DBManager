Recorded Dokploy responses. Re-record against a live Dokploy >= 0.30 before the first e2e:
1. GET /api/settings.getOpenApiDocument  -> openapi.json (for path/param names)
2. Run each call once with curl -H 'x-api-key: ...' and save the JSON here as <router>.<procedure>.json
3. Update the MSW handlers in test/adapters/dokploy.test.ts to serve these files.
