# Changelog

## 1.0.0 (2026-10-03)


### Features

* **adapters:** dokploy REST client with zod-validated responses and MSW tests ([c90bf2d](https://github.com/BautyGarcia/DBManager/commit/c90bf2d1fbabb9e23aab6af576dab3bd26942c9c))
* **adapters:** interfaces, ssh runner via system ssh, local runner ([838cdea](https://github.com/BautyGarcia/DBManager/commit/838cdea040c75e5f77be05775fb5ab2a38ec7781))
* **adapters:** postgres admin over docker exec, garage admin v2 over curl ([69cd261](https://github.com/BautyGarcia/DBManager/commit/69cd26189091a70da8323ec86ac24ea6cdc02be3))
* backup and restore commands (pg_restore from off-site dumps, clone via --as) ([6956f06](https://github.com/BautyGarcia/DBManager/commit/6956f06fff25a5616c71dac68b0f1c9aeab41ee2))
* checkpointed init (harden, tailscale, dokploy, api key, garage, pgbouncer+TLS, destinations, smoke test) ([5fca529](https://github.com/BautyGarcia/DBManager/commit/5fca529266f0d3cd807dd890a798322aa678bf1e))
* **core:** idempotent Ubuntu 24.04 hardening script renderer ([741d5a7](https://github.com/BautyGarcia/DBManager/commit/741d5a70e141bb64f9767e8c0cd1dc7fe19991c8))
* **core:** render pgbouncer.ini and userlist from state ([755cf2e](https://github.com/BautyGarcia/DBManager/commit/755cf2e6e21f5a316b4f5b1346a2f1ffa222ab59))
* **core:** renderers for garage.toml, compose, traefik routers, rclone and host crons ([3256d27](https://github.com/BautyGarcia/DBManager/commit/3256d27a268dee50717c85db11ec277a3e2c97bd))
* **core:** secrets, SCRAM-SHA-256 verifier, memory units ([4abb10d](https://github.com/BautyGarcia/DBManager/commit/4abb10d174f3a9fd6207b9b92a2a7f5a4d2e836f))
* **core:** slug validation and derived names ([caab33e](https://github.com/BautyGarcia/DBManager/commit/caab33e57c75b8d5dbe3a6e313261ea98893a8f8))
* **core:** SQL builders, project env rendering, backup cron jitter ([f59a7b7](https://github.com/BautyGarcia/DBManager/commit/f59a7b72fa6d7b091b9b08a8210b5528731d5fcf))
* **core:** versioned state/config schemas and atomic file store ([197f7f1](https://github.com/BautyGarcia/DBManager/commit/197f7f128a3dc255bbd7f0ef583f04a05a40fac9))
* create command with rollback, deps context, pgbouncer apply, CLI wiring ([930bbc6](https://github.com/BautyGarcia/DBManager/commit/930bbc683ae7fe3a9bba352cd2f5f49ffe27dd6a))
* destroy command with final backup, volume removal and optional storage purge ([ea53cb5](https://github.com/BautyGarcia/DBManager/commit/ea53cb542c644213ea1723c0b49f3ca3081ba197))
* doctor command (versions, drift, TLS expiry, tailscale, disk, per-project data dir and backup age) ([b528360](https://github.com/BautyGarcia/DBManager/commit/b528360825bf06771e9992aef9afc9fc71f0419a))
* import command (pg_dump/psql in a throwaway container, error report, storage sync) ([20ac839](https://github.com/BautyGarcia/DBManager/commit/20ac839d63809cbfea7de399581344fe950ebd18))
* list and env commands ([0b23e82](https://github.com/BautyGarcia/DBManager/commit/0b23e823a6ebc3e2e674bf03ef715ee94a16a1f7))
* Next.js templates (drizzle+postgres.js verify-full, better-auth 1.7, Garage S3 client, gru1) ([fb52a9f](https://github.com/BautyGarcia/DBManager/commit/fb52a9fe0519fb37b9e7c3f4f14539580c1d9006))
* pause and resume commands ([1cbe36b](https://github.com/BautyGarcia/DBManager/commit/1cbe36bc64a44ebfb89752ed4da3efac45410831))
* psql and sync-pgbouncer commands ([9dcfeda](https://github.com/BautyGarcia/DBManager/commit/9dcfeda8e1972eee98b3beb3ea011e3633b946a3))
* **skills:** /dbmanager provisioning skill with preflight script; retire skills/dbm ([0a0ce46](https://github.com/BautyGarcia/DBManager/commit/0a0ce46b8aae40a7a3113fee844cdb0ffe77fa64))
* storage public (web endpoint + traefik router) and storage cors commands ([6bc5054](https://github.com/BautyGarcia/DBManager/commit/6bc5054421d2d61a00c6c3175454d858f6a2b63d))
* **templates:** drizzle.config.ts loads .env.local via process.loadEnvFile ([f55c23b](https://github.com/BautyGarcia/DBManager/commit/f55c23bcac4389c64a4d7f92855e664a79bb1dbd))
* tombstones so restore can recreate destroyed projects ([b8faf69](https://github.com/BautyGarcia/DBManager/commit/b8faf698f866361e091f29deae4e88f5c4358749))


### Bug Fixes

* **adapters:** pass pgbouncer probe URL on stdin ([dac164a](https://github.com/BautyGarcia/DBManager/commit/dac164ae4cdcf6874faeb5d0b20e70c973052bd7))
* **adapters:** send Garage corsRules with S3 XML field names ([d98effa](https://github.com/BautyGarcia/DBManager/commit/d98effafe6fd888ea6350c2436f74f37886ed989))
* **cli:** global flags in any position, state lock around every command ([53a8af0](https://github.com/BautyGarcia/DBManager/commit/53a8af0b9d59bbfdfe0b521c31a959b0545eb9b6))
* **core:** make DOCKER-USER after.rules update idempotent ([87c06b5](https://github.com/BautyGarcia/DBManager/commit/87c06b5834fab27da633e8858c9832eca07bb48c))
* destroy keeps project in state until all resources are removed ([b84eab4](https://github.com/BautyGarcia/DBManager/commit/b84eab42c31e3cdd113dd609ab2d46ed4df4f1e3))
* **destroy,restore:** retryable destroy, correct restore source, extension-safe pipeline ([b7fbebd](https://github.com/BautyGarcia/DBManager/commit/b7fbebd83ad43988c02ddcd09b3f0a9712ab9983))
* **doctor:** log rotation is a failure, add garage region check ([1dc581a](https://github.com/BautyGarcia/DBManager/commit/1dc581a0f9e12c7278caaee4d9284ebea8d81ba5))
* **dokploy:** omit expiresIn when minting the API key (live API rejects null) ([eb3aaa7](https://github.com/BautyGarcia/DBManager/commit/eb3aaa75646d756ce8fca4a22e5a1bedc38abcde))
* **dokploy:** read backupId from postgres.one when backup.create returns an empty body ([01e67e7](https://github.com/BautyGarcia/DBManager/commit/01e67e7e995774f4ec85d10dc6b5ba80a76804cc))
* **dokploy:** retry a transient network failure once ([b8b2239](https://github.com/BautyGarcia/DBManager/commit/b8b2239049aabe95634709620f478d2c3e820b7b))
* **import:** fail fast on dump errors; grant session_replication_role to app role ([582652b](https://github.com/BautyGarcia/DBManager/commit/582652b900a4b3a440a140953b556e54975ed6b7))
* **init,doctor,storage:** host-change reset, timezone check, safer mirrors ([67b1bef](https://github.com/BautyGarcia/DBManager/commit/67b1bef175dda54fc570aa5bf9b5296034d2a322))
* **init:** error-preserving smoke cleanup, tailscale exit codes, idempotent destination, clear secrets on completion ([db21f8a](https://github.com/BautyGarcia/DBManager/commit/db21f8a3d2faf8934b7897df7a949de24e8ec07e))
* **init:** restart pgbouncer after fixing cert ownership (it exits before the chown) ([c2b8425](https://github.com/BautyGarcia/DBManager/commit/c2b842569f8a5988a29d450bc9fff7fa57c54cae))
* **init:** serve the Dokploy dashboard on tailnet port 8443 ([8ea0ae2](https://github.com/BautyGarcia/DBManager/commit/8ea0ae2f83dc3360635c1a80388d2eb3ef6e77e3))
* retryable tombstone restore, confirm in-place restore, quote restore pipeline ([c9fbad7](https://github.com/BautyGarcia/DBManager/commit/c9fbad7dc00d71ca782289ae87788086bf503a57))
* **templates:** local-dev baseURL fallback for better-auth ([0e427db](https://github.com/BautyGarcia/DBManager/commit/0e427db1c746b66e6172d9420633813fef0a20e6))
* tolerant volume removal and argument-recording fakes for create ([ee11f85](https://github.com/BautyGarcia/DBManager/commit/ee11f85b1add33a3f44654df4c79e7970f4a3d87))
