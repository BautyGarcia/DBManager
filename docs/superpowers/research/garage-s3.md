# Garage S3 research for the db-manager spec

Date checked: 2026-09-30. Scope: spec sections 5.4, 5.5, 7 (`create`, `destroy`, `storage public`, `import`) and 17.
Method: official docs at garagehq.deuxfleurs.fr, the Garage OpenAPI v2 JSON, the `main-v2` branch source on the GitHub mirror, Docker Hub API, NVD/OSV/GitHub advisory APIs, AWS SDK docs, Supabase docs. The Forgejo HTML/REST endpoints at git.deuxfleurs.fr are behind an Anubis anti-bot wall, so release notes were reconstructed from the site's release list, the RSS feed (tags + dates only) and the GitHub mirror's commit range.

## Summary

1. Garage stands. Current stable is **v2.4.1 (2026-09-08)**; pin `dxflrs/garage:v2.4.1` (multi-arch, no `latest` tag). The 2.x line has shipped 6 releases in 15 months; 1.x still gets patch releases.
2. Since v2.3.0, `garage server --single-node` auto-creates the layout, so the `layout assign/apply` dance is unnecessary. The admin API can also do it (`UpdateClusterLayout` + `ApplyClusterLayout`).
3. Admin API is **v2** (`/v2/<OperationName>`, `Authorization: Bearer`). Everything `dbm` needs exists: CreateBucket, CreateKey, AllowBucketKey, UpdateBucket (website, quotas, **corsRules**), GetBucketInfo (`bytes`, `objects`), DeleteKey, DeleteBucket (must be empty).
4. Presigned PUT/GET, CORS, multipart and path-style all work. **Path-style is always on**, so `s3.example.com/<bucket>/<key>` works behind Traefik.
5. Hard blocker for spec 5.4/7: **Garage has no anonymous access on the S3 endpoint** (`"Garage does not support anonymous access yet"` in the signature code, no bucket policies/ACLs). Public assets must go through the web endpoint (3902), which resolves buckets **by Host header only**, so `s3.example.com/<bucket>/<key>` cannot be public. Use `<slug>.web.example.com` (or a custom alias hostname) routed to port 3902.
6. AWS SDK JS >= 3.729.0 signs an empty-body CRC32 into presigned PUT URLs; Garage validates checksums and returns `400 InvalidDigest`. Set `requestChecksumCalculation: "WHEN_REQUIRED"` and `responseChecksumValidation: "WHEN_REQUIRED"`.
7. Keys are scoped **per bucket** (read/write/owner); no prefix scoping. Admin auth = master `admin_token` plus optional scoped/expiring tokens (v2.0+).
8. No CVEs recorded for Garage in NVD, OSV or GitHub advisories; a reflected-XSS fix on the web endpoint landed in v2.4.0 without a CVE.
9. Single node = zero redundancy; LMDB is known to corrupt on unclean shutdown. Set `metadata_auto_snapshot_interval` and `metadata_fsync = true`, and keep the nightly rclone off-site sync.
10. MinIO community is archived (2026-04-25), RustFS 1.0 GA is two weeks old, Ceph RGW needs 3+ nodes. SeaweedFS remains the right fallback.

## Verified facts

### Versions, cadence, image
- Release list (checked 2026-09-30): v2.4.1 (2026-09-08), v2.4.0 (2026-09-06), v2.3.0 (2026-04-16), v2.2.0 (2026-01-24), v2.1.0 (2025-09-15), v2.0.0 (2025-06-14); parallel 1.x maintenance: v1.3.1 (2026-01-24), v1.3.0 (2025-09-15). https://garagehq.deuxfleurs.fr/_releases.html
- Docker Hub `dxflrs/garage` tags `v2.4.1` (2026-09-08), `v2.4.0` (2026-09-06), `v2.3.0` (2026-04-16), each with amd64/arm64/arm/386 images. A `latest` tag does **not** exist (query for `name=latest` returned an empty list). https://hub.docker.com/v2/repositories/dxflrs/garage/tags?name=v2 (checked 2026-09-30)
- The current quick-start uses `dxflrs/garage:v2.4.1`. https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/doc/book/quick-start/_index.md
- v2.4.1 content (25 commits over v2.4.0, all helm chart work plus "set ring as rustls crypto provider when building http clients" fixing #1526/#1416, a startup crash introduced by a dependency change): https://api.github.com/repos/deuxfleurs-org/garage/compare/v2.4.0...v2.4.1
- v2.4.0 content (125 commits over v2.3.0), relevant items: "fix reflected xss when returning errors on web endpoint" (2026-06-10), "Better handling of wildcards in CORS rules (fix #1105)", "fix(cors): return single matching origin instead of multiple values in Access-Control-Allow-Origin", "fix(cors): include Access-Control-Allow-Headers in permissive OPTIONS placeholder", "collapse sequential whitespace in canonical SigV4 header values", "fix(s3): treat NoSuchKey as success in bulk DeleteObjects", "api/s3: don't panic when final multipart version has no blocks", "fix(s3): allow UTF-8 in PostObject form field values", "add SECURITY.md". https://api.github.com/repos/deuxfleurs-org/garage/compare/v2.3.0...v2.4.1
- v2.3.0: "Making initial setup easier by allowing the use of `garage server --single-node` to autocreate a layout"; "no breaking changes when migrating from Garage v2.2.0". https://git.deuxfleurs.fr/Deuxfleurs/garage/releases/tag/v2.3.0 (via search snippet; page itself is Anubis-walled)
- v2.0.0 breaking changes: "The administration API has been completely reworked. Some calls to the `/v1/` endpoints will still work but most will not." and `replication_mode` removed in favour of `replication_factor` + `consistency_mode`. https://garagehq.deuxfleurs.fr/documentation/working-documents/migration-2/ and https://garagehq.deuxfleurs.fr/blog/2025-06-garage-v2/
- GitHub mirror default branch is `main-v2`; last push 2026-09-30, i.e. actively developed. https://api.github.com/repos/deuxfleurs-org/garage
- Funding: NLNet grant for reliability/performance work announced 2026-04-18. https://garagehq.deuxfleurs.fr/blog/2026-04-performance-reliability/

### Single-node configuration and layout
- Required top-level keys: `replication_factor`, `metadata_dir`, `data_dir`, `rpc_secret`, `rpc_bind_addr`; `bootstrap_peers` and `rpc_public_addr` are for multi-node ("optional but recommended"). `[s3_api]` requires `api_bind_addr` and `s3_region`; `root_domain` is optional. `[s3_web] bind_addr` required if the section is present. `[admin] api_bind_addr` and `admin_token` are optional (no admin API without them). https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/
- `rpc_secret` is "32-byte hex-encoded key" (`openssl rand -hex 32`); `admin_token` via `openssl rand -base64 32`. Both can also be supplied via `rpc_secret_file`/`GARAGE_RPC_SECRET`/`GARAGE_RPC_SECRET_FILE` and `admin_token_file`/`GARAGE_ADMIN_TOKEN`/`GARAGE_ADMIN_TOKEN_FILE`. https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/doc/book/reference-manual/configuration.md (sections `rpc_secret`, `admin_token`)
- `s3_api.root_domain`: "Note path-style requests are always enabled, whether or not vhost-style is configured." Path-style therefore works without any `root_domain`. Same file, section `root_domain {#s3_root_domain}`.
- `s3_web.root_domain`: "if `root_domain` is `web.garage.eu`, a bucket called `deuxfleurs.fr` will be accessible either with hostname `deuxfleurs.fr.web.garage.eu` or with hostname `deuxfleurs.fr`." Same file, `{#web_root_domain}`.
- `db_engine`: LMDB default; "LMDB is prone to database corruption after an unclean shutdown (e.g. a process kill or a power outage). It is recommended to configure `metadata_auto_snapshot_interval`". SQLite is "a viable alternative". Same file, `db_engine`.
- `metadata_fsync`: default `false`; "reduces the risk of metadata corruption in case of power failures, at the cost of a significant drop in write performance". Same file.
- `metadata_auto_snapshot_interval`: Garage "keeps only the two most recent snapshots"; recovery procedure: https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/doc/book/operations/recovering.md (section "Replacement scenario 3: corrupted metadata").
- `--single-node` behaviour (source, `src/garage/server.rs`): errors unless `replication_factor = 1`; if layout version is 0 it stages this node in zone `dc1`, tag `default`, `capacity` = **total size of the data disk** (fallback 1 GiB), then applies layout version 1; refuses to run if layout version > 1 or other nodes are known. On restart with layout version 1 it is a no-op, so the flag can stay in the compose command. https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/garage/server.rs
- `--default-bucket` implies `--default-access-key`, reads `GARAGE_DEFAULT_ACCESS_KEY`, `GARAGE_DEFAULT_SECRET_KEY`, `GARAGE_DEFAULT_BUCKET`; both flags require `--single-node`. Refuses to start if the env secret differs from the stored key. https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/garage/cli/structs.rs and server.rs above.
- Manual equivalent (pre-2.3 or without the flag): `garage layout assign -z dc1 -c 1G <node_id>` then `garage layout apply --version 1`; node id from `garage node id` / `garage status`. https://garagehq.deuxfleurs.fr/documentation/quick-start/ and https://garagehq.deuxfleurs.fr/documentation/cookbook/real-world/
- Layout via admin API is possible: `GET /v2/GetClusterStatus` returns `nodes[].id`; `POST /v2/UpdateClusterLayout` body `{"roles":[{"id":"<node id>","zone":"dc1","capacity":<bytes>,"tags":[]}]}` (capacity in bytes; `null` = gateway); `POST /v2/ApplyClusterLayout` body `{"version": 1}`. https://garagehq.deuxfleurs.fr/api/garage-admin-v2.json

### Admin API
- "The current version of the admin API is v2. No breaking changes to the Garage administration API will be published outside of a major release." Auth header `Authorization: Bearer <token>`. v1 spec still published but deprecated. https://garagehq.deuxfleurs.fr/documentation/reference-manual/admin-api/
- OpenAPI JSON `info.version` is `v2.3.0`, server `http://localhost:3903/`, single `bearerAuth` scheme. Reads are `GET` with query params; mutations are `POST /v2/<OperationName>`. https://garagehq.deuxfleurs.fr/api/garage-admin-v2.json
- `AllowBucketKey`/`DenyBucketKey` semantics (quoted from the spec): "Flags in permissions which have the value true will be activated. Other flags will remain unchanged". There is no "set exactly these permissions" call. Same URL.
- `DeleteBucket`: "A bucket cannot be deleted if it is not empty." 400 when not empty; also deletes all aliases. `DeleteKey`: "Buckets are not automatically deleted and can be dangling." Same URL.
- `UpdateBucketRequestBody` schema keys: `corsRules`, `lifecycleRules`, `quotas`, `websiteAccess` (verified by parsing the JSON schema; the endpoint's prose description only mentions `websiteAccess` and `quotas`). Same URL.
- `GetBucketInfoResponse` includes `bytes`, `objects`, `unfinishedUploads`, `unfinishedMultipartUploadBytes`, `websiteAccess`, `corsRules`, `keys[].permissions`, `quotas`. Same URL.
- Scoped admin tokens: `garage admin-token create --expires-in 30d --scope ListBuckets,GetBucketInfo,ListKeys,GetKeyInfo,CreateBucket,CreateKey,AllowBucketKey,DenyBucketKey my-token`; token shown once, stored hashed. Also `POST /v2/CreateAdminToken` with `scope` array or `"*"`. https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/doc/book/reference-manual/admin-api.md
- `garage json-api` (v2.0+) invokes any admin call from the CLI over internal RPC without HTTP. Same file.
- `GET /health` (200 if quorum, 503 otherwise) and `GET /check?domain=` (for on-demand TLS) are unauthenticated; `GET /metrics` uses `metrics_token`. https://garagehq.deuxfleurs.fr/documentation/reference-manual/admin-api/

### S3 compatibility
- Compatibility table: presigned URLs supported (SigV4); PutBucketCors/GetBucketCors/DeleteBucketCors implemented; all 7 multipart endpoints implemented; PostObject implemented; ListObjectsV2 implemented; **no ACLs, no bucket policies** ("Garage implements none of them, and has its own system instead, built around a per-access-key-per-bucket logic"); no versioning; PutBucketWebsite only index/error document; lifecycle only Expiration and AbortIncompleteMultipartUpload. https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/
- Presigned URL handling (source): query-string auth is detected by `X-Amz-Algorithm`; `X-Amz-Expires` is required and "may not exceed a week"; "Presigned URLs always use UNSIGNED-PAYLOAD"; query parameters starting with `x-amz-` "are actually intended to stand in for" headers and override them. https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/api/common/signature/payload.rs
- Checksums (source): Garage knows `x-amz-checksum-crc32`, `-crc32c`, `-crc64nvme`, `-sha1`, `-sha256`, `x-amz-checksum-algorithm`, `x-amz-checksum-mode`, `x-amz-checksum-type`, and validates them, returning `InvalidDigest`/`BadDigest`. https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/api/common/signature/checksum.rs and https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/api/s3/error.rs
- Consequence, third-party report: against "Garage v2.4.1" a presigned PUT generated with SDK defaults fails with "400 InvalidDigest ... Failed to validate checksum for algorithm Crc32 ... expected Crc32([0, 0, 0, 0])"; with `requestChecksumCalculation: "WHEN_REQUIRED"` Garage returns 200. https://github.com/m0t0r/recomencemos/issues/317
- AWS SDK JS: "Beginning with version 3.729.0 of the AWS SDK for JavaScript, the SDK provides default integrity protections by automatically calculating a CRC32 checksum for uploads." https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html
- AWS announcement: opt out "by setting the config flag to WHEN_REQUIRED, or by using related AWS shared config file settings or environment variables"; third-party S3-compatible implementations "may not yet support these features". https://github.com/aws/aws-sdk-js-v3/issues/6810
- Settings reference: `request_checksum_calculation` / `AWS_REQUEST_CHECKSUM_CALCULATION` and `response_checksum_validation` / `AWS_RESPONSE_CHECKSUM_VALIDATION`, default `WHEN_SUPPORTED`, valid values `WHEN_SUPPORTED` | `WHEN_REQUIRED`. https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html
- CORS on the S3 endpoint (source): `OPTIONS` is handled **before** signature verification (`handle_options_api`), and successful responses get `Access-Control-*` headers when a bucket CORS rule matches. Preflights for presigned PUTs therefore work. https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/api/s3/api_server.rs
- CORS on the web endpoint (source): web responses also get CORS headers from the bucket's rules (`find_matching_cors_rule` / `add_cors_headers` in `web_server.rs`). https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/web/web_server.rs
- Example CORS payload from the official cookbook (Ente): `{"CORSRules":[{"AllowedHeaders":["*"],"AllowedMethods":["GET","PUT","POST","DELETE"],"AllowedOrigins":["*"],"ExposeHeaders":["ETag"]}]}` applied with `aws s3api put-bucket-cors`. https://garagehq.deuxfleurs.fr/documentation/connect/apps/
- Reverse proxy cookbook: Traefik routes S3 to port 3900 and web to 3902; nginx: "Path-style requests use `s3.garage.tld` while vhost-style use `*.s3.garage.tld`"; Apache needs `nocanon` to preserve presigned URLs. https://garagehq.deuxfleurs.fr/documentation/cookbook/reverse-proxy/

### Public buckets
- Signature code: `Error::forbidden("Garage does not support anonymous access yet")` when a request carries no key. Anonymous GETs on `s3.example.com/<bucket>/<key>` are impossible. https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/api/common/signature/mod.rs
- Feature request "Allow anonymous access on the S3 endpoint" is issue #263 (status could not be read; Anubis wall). https://git.deuxfleurs.fr/Deuxfleurs/garage/issues/263
- Web endpoint: bucket = `host_to_bucket(host, root_domain).unwrap_or(host)`, i.e. `<bucket>.<s3_web.root_domain>` or a hostname equal to a bucket global alias; requires `website_config` enabled. Path is only the key. https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/web/web_server.rs
- Three ways to enable: `PutBucketWebsite` (owner key), `garage bucket website --allow <bucket>`, or admin API `UpdateBucket {"websiteAccess":{"enabled":true,"indexDocument":"index.html"}}`. "The bucket needs to have a global alias to be exposed as a website." No directory listing. https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/doc/book/cookbook/exposing-websites.md
- Global aliases with dots are legal (docs use bucket `deuxfleurs.fr`); `POST /v2/AddBucketAlias {"bucketId":..., "globalAlias":"assets.myapp.com"}` adds one. https://garagehq.deuxfleurs.fr/api/garage-admin-v2.json

### Operations
- rclone remote for Garage (official): `type = s3`, `provider = Other`, `env_auth = false`, `region = <region>`, `endpoint = <endpoint>`, `force_path_style = true`, `acl = private`, `bucket_acl = private`; use `--fast-list` on large buckets. https://garagehq.deuxfleurs.fr/documentation/connect/cli/
- rclone `--s3-force-path-style` default is already `true`; `--s3-no-check-bucket` avoids the create-bucket call (needed when the key lacks `createBucket`). https://rclone.org/s3/
- Supabase S3 endpoint: `https://<project_ref>.storage.supabase.co/storage/v1/s3` (preferred) or `https://<project_ref>.supabase.co/storage/v1/s3`; region = the project's region; `forcePathStyle: true`; "S3 access keys provide full access to all S3 operations across all buckets and bypass RLS policies". Keys are created in the dashboard under Storage > S3 configuration. https://supabase.com/docs/guides/storage/s3/authentication
- Supabase's own rclone example: `[platform] type = s3 / provider = Other / access_key_id / secret_access_key / endpoint = https://your-project-ref.supabase.co/storage/v1/s3 / region = your-project-region`, then `rclone copy platform:bucket dest:bucket --progress` (tune `--transfers 4 --checkers 8`). https://supabase.com/docs/guides/self-hosting/copy-from-platform-s3
- Scrubs run automatically every 25-35 days; `garage meta snapshot` is "very intensive as it requires making a full copy of the database file"; filesystem snapshots recommended as alternative. https://garagehq.deuxfleurs.fr/documentation/operations/durability-repairs/
- Known issues: metadata performance collapses at ~10M objects per bucket; large single objects are O(n^2) in metadata (raise `block_size`); no conditional writes; LMDB corruption bug "mitigated via replication and snapshots". https://garagehq.deuxfleurs.fr/documentation/reference-manual/known-issues/

### Security
- NVD keyword search "deuxfleurs garage": `totalResults 0`. OSV query for crates `garage`, `garage_api_s3`: `{}`. GitHub advisories filtered `ecosystem=rust&affects=garage`: `[]`. (All checked 2026-09-30.) https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=deuxfleurs%20garage , https://api.osv.dev/v1/query , https://api.github.com/advisories?ecosystem=rust&affects=garage
- SECURITY.md (added 2026-04-27): report to garagehq@deuxfleurs.fr; response "within a few weeks". https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/SECURITY.md
- Reflected XSS in web-endpoint error pages fixed 2026-06-10, shipped in v2.4.0, no CVE found. https://api.github.com/repos/deuxfleurs-org/garage/compare/v2.3.0...v2.4.1
- Admin auth: master `admin_token` (all endpoints except metrics), `metrics_token`, and user-defined tokens with scope + expiration. Admin/S3/web endpoints "do not support TLS" natively. https://garagehq.deuxfleurs.fr/documentation/reference-manual/admin-api/ and configuration reference.
- Key granularity: permissions are `read`/`write`/`owner` **per bucket** (`ApiBucketKeyPerm`), plus a key-level `createBucket` flag and optional `expiration`. No prefix/path scoping exists in the API or docs. https://garagehq.deuxfleurs.fr/api/garage-admin-v2.json
- CreateBucket concurrency: "CreateBucket race conditions: Concurrent bucket creation requests lack mutual exclusion" (known issue; irrelevant for a single CLI operator). https://garagehq.deuxfleurs.fr/documentation/reference-manual/known-issues/

### Alternatives
- MinIO: GitHub repo archived 2026-04-25 ("THIS REPOSITORY IS NO LONGER MAINTAINED"), "distributed as source code only", users pointed to AIStor Free/Enterprise. https://github.com/minio/minio and https://api.github.com/repos/minio/minio (`archived: true`)
- SeaweedFS: latest release 4.48 published 2026-09-28; single container can run master+volume+filer+S3. https://api.github.com/repos/seaweedfs/seaweedfs/releases/latest and https://github.com/seaweedfs/seaweedfs
- RustFS: 1.0.0 GA published 2026-09-16, Apache-2.0, console on :9001. https://api.github.com/repos/rustfs/rustfs/releases/latest and https://rustfs.com/blog/announcing-rustfs-1-0-0-ga/
- Ceph RGW: vendor guidance is 3+ nodes, 16 GB+ RAM per OSD host, ~1 GB per RGW daemon minimum. https://www.ibm.com/docs/en/storage-ceph/8.0.0?topic=recommendations-minimum-hardware-considerations

## Admin API reference

Base URL inside the Docker network: `http://garage:3903`. Header on every call: `Authorization: Bearer <admin_token or scoped token>`. All bodies and responses are JSON. Source for every row: https://garagehq.deuxfleurs.fr/api/garage-admin-v2.json (spec version v2.3.0, checked 2026-09-30).

| dbm step | Method + path | Request | Response / notes |
|---|---|---|---|
| Health check (`doctor`) | `GET /health` | none, unauthenticated | 200 when quorum OK, 503 otherwise |
| Node id for layout | `GET /v2/GetClusterStatus` | none | `{layoutVersion, nodes:[{id, isUp, role, dataPartition{...}}]}` |
| Stage layout (fallback if not using `--single-node`) | `POST /v2/UpdateClusterLayout` | `{"roles":[{"id":"<nodeId>","zone":"dc1","capacity":<bytes>,"tags":["vps"]}]}` | staged changes; `capacity: null` makes a gateway |
| Apply layout | `POST /v2/ApplyClusterLayout` | `{"version": <current layoutVersion + 1>}` | `{layout, message[], statistics}`; do not parse `message` |
| Create bucket `<slug>` | `POST /v2/CreateBucket` | `{"globalAlias":"<slug>"}` | full `GetBucketInfoResponse` incl. `id` (store it; other calls take the id) |
| Create key `<slug>-key` | `POST /v2/CreateKey` | `{"name":"<slug>-key","neverExpires":true}` (optional `"expiration":"<RFC3339>"`, `"allow":{"createBucket":false}`) | `{accessKeyId, secretAccessKey, name, permissions, buckets[]}`; `secretAccessKey` is only returned here and via `GetKeyInfo?showSecretKey=true` |
| Grant key on bucket | `POST /v2/AllowBucketKey` | `{"bucketId":"<id>","accessKeyId":"GK...","permissions":{"read":true,"write":true,"owner":false}}` | only `true` flags change; use `DenyBucketKey` with `true` flags to revoke |
| Grant shared `dbm-backup` read | `POST /v2/AllowBucketKey` | `{"bucketId":"<id>","accessKeyId":"<backup key>","permissions":{"read":true}}` | same |
| Set CORS (needed for browser presigned PUT) | `POST /v2/UpdateBucket?id=<id>` | `{"corsRules":[{"allowedOrigins":["https://app.example.com"],"allowedMethods":["GET","PUT","POST","DELETE","HEAD"],"allowedHeaders":["*"],"exposeHeaders":["ETag"],"maxAgeSeconds":3600}]}` | field present in schema; exact rule-key casing must be confirmed against the `cors.Rule` schema in the JSON or by test (see Unverified). Fallback: S3 `PutBucketCors` with an owner key |
| Make public (`storage public`) | `POST /v2/UpdateBucket?id=<id>` | `{"websiteAccess":{"enabled":true,"indexDocument":"index.html","errorDocument":"404.html"}}` | serves on web endpoint (3902) by Host only |
| Make private (`--off`) | `POST /v2/UpdateBucket?id=<id>` | `{"websiteAccess":{"enabled":false}}` | must not include index/error docs when disabling |
| Custom public hostname | `POST /v2/AddBucketAlias` | `{"bucketId":"<id>","globalAlias":"assets.myapp.com"}` | hostname then resolves on the web endpoint |
| Quota (optional) | `POST /v2/UpdateBucket?id=<id>` | `{"quotas":{"maxSize":<bytes>,"maxObjects":null}}` | both fields must be present (`null` allowed) |
| Bucket stats (`list`) | `GET /v2/GetBucketInfo?globalAlias=<slug>` (or `?id=`) | none | `bytes`, `objects`, `unfinishedUploads`, `keys[]`, `websiteAccess`, `corsRules`, `quotas` |
| List buckets | `GET /v2/ListBuckets` | none | ids + global/local aliases |
| Delete key (`destroy`) | `POST /v2/DeleteKey?id=GK...` | none | 200; buckets left dangling |
| Purge multipart leftovers | `POST /v2/CleanupIncompleteUploads` | `{"bucketId":"<id>","olderThanSecs":0}` (check schema) | needed before delete if uploads were aborted mid-way |
| Delete bucket (`--purge-storage`) | `POST /v2/DeleteBucket?id=<id>` | none | **400 if not empty**; empty it first via S3 `ListObjectsV2` + `DeleteObjects` |
| Scoped token for the CLI | `POST /v2/CreateAdminToken` | `{"name":"dbm","scope":["ListBuckets","GetBucketInfo","CreateBucket","UpdateBucket","DeleteBucket","AddBucketAlias","ListKeys","GetKeyInfo","CreateKey","DeleteKey","AllowBucketKey","DenyBucketKey","CleanupIncompleteUploads","GetClusterStatus","GetClusterHealth"],"neverExpires":true}` | `secretToken` shown once |

v1 vs v2 differences (https://garagehq.deuxfleurs.fr/blog/2025-06-garage-v2/, https://garagehq.deuxfleurs.fr/documentation/working-documents/migration-2/): v1 used REST-ish paths (`/v1/bucket?id=`, `/v1/key`, `/v1/layout`) and a single master token; v2 uses `/v2/<OperationName>` with GET for reads and POST for mutations, adds multiple scoped/expiring admin tokens, key expiration, `garage json-api`, and mirrors every CLI command as an endpoint. "Some calls to the `/v1/` endpoints will still work but most will not." Do not implement against v1.

## Recommended garage.toml

Complete single-node file for `compose/garage/garage.toml.template`. Secrets are injected as env vars so the file itself contains none.

```toml
# Garage v2.4.x single-node configuration for dbm.
# Ref: https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/

metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
metadata_snapshots_dir = "/var/lib/garage/snapshots"

# Single node: no redundancy inside Garage. Durability comes from
# metadata snapshots + nightly rclone off-site sync + provider VPS snapshots.
replication_factor = 1
consistency_mode = "consistent"

# LMDB is the default and fastest, but is known to corrupt on unclean
# shutdown. fsync + periodic snapshots are the documented mitigations.
db_engine = "lmdb"
metadata_fsync = true
data_fsync = false
metadata_auto_snapshot_interval = "6h"

# 1M default; bump to 10M if projects store large files (video, exports).
block_size = "1M"
compression_level = 1

rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
# Provided via env GARAGE_RPC_SECRET (32-byte hex, `openssl rand -hex 32`).
# rpc_secret = ""

[s3_api]
s3_region = "garage"            # S3_REGION in app env must match exactly
api_bind_addr = "[::]:3900"     # Traefik: s3.example.com -> garage:3900
# root_domain intentionally unset: path-style is always enabled and a
# single certificate covers every bucket.

[s3_web]
bind_addr = "[::]:3902"         # Traefik: *.web.example.com -> garage:3902
root_domain = ".web.example.com"
index = "index.html"
add_host_to_metrics = false

[admin]
api_bind_addr = "[::]:3903"     # Docker network only, never routed by Traefik
# Provided via env GARAGE_ADMIN_TOKEN (`openssl rand -base64 32`).
# admin_token = ""
# Provided via env GARAGE_METRICS_TOKEN, optional.
# metrics_token = ""
metrics_require_token = true
```

Compose command: `/garage server --single-node` (no `--default-bucket`; `dbm` creates buckets and keys through the admin API). Mount `garage.toml` at `/etc/garage.toml` and named volumes at `/var/lib/garage/meta`, `/var/lib/garage/data`, `/var/lib/garage/snapshots`. Environment: `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `GARAGE_METRICS_TOKEN`. Image: `dxflrs/garage:v2.4.1`.

## Recommended S3Client config

`templates/nextjs/lib/s3.ts`:

```ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Garage single-node behind Traefik, path-style, region "garage".
// requestChecksumCalculation / responseChecksumValidation MUST be
// WHEN_REQUIRED: since @aws-sdk/client-s3 3.729.0 the SDK signs an
// empty-body CRC32 into presigned PUT URLs and Garage rejects the
// upload with 400 InvalidDigest. Refs:
// https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html
// https://github.com/aws/aws-sdk-js-v3/issues/6810
export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT!,          // https://s3.example.com
  region: process.env.S3_REGION ?? "garage",   // must equal s3_api.s3_region
  forcePathStyle: true,                        // s3.example.com/<bucket>/<key>
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
});

const Bucket = process.env.S3_BUCKET!;

// Browser PUTs directly to this URL. Garage caps X-Amz-Expires at 7 days.
export function getPresignedUploadUrl(
  key: string,
  contentType: string,
  expiresIn = 900,
) {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }),
    { expiresIn },
  );
}

export function getPresignedDownloadUrl(key: string, expiresIn = 900) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: key }), {
    expiresIn,
  });
}

export function deleteObject(key: string) {
  return s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
}

// Public buckets are served by Garage's web endpoint, resolved by Host,
// not by path. dbm prints S3_PUBLIC_BASE_URL (e.g. https://<slug>.web.example.com)
// after `dbm storage public <slug>`.
export function publicUrl(key: string) {
  const base = process.env.S3_PUBLIC_BASE_URL;
  if (!base) throw new Error("Bucket is not public (S3_PUBLIC_BASE_URL unset)");
  return `${base}/${encodeURI(key)}`;
}
```

Browser side: `fetch(url, { method: "PUT", body: file, headers: { "Content-Type": file.type } })`. The same `Content-Type` must be passed when presigning, because it is part of the signed headers. Preflight `OPTIONS` is answered by Garage without auth as long as the bucket has a matching CORS rule.

Equivalent environment-level opt-out (useful for `rclone`-free scripts or the AWS CLI on the VPS): `AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED`, `AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED` (https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html).

## Unverified / uncertain

- **v2.3.0 / v2.4.x official release notes** could not be read directly (Forgejo HTML and REST API return an Anubis "Access Denied"; the RSS feed carries titles and dates but empty bodies). Content above is reconstructed from the GitHub mirror commit range and one search snippet. Cross-check once from a browser: https://git.deuxfleurs.fr/Deuxfleurs/garage/releases
- **Exact JSON key casing for `corsRules` in `UpdateBucket`** (`allowedOrigins` vs `AllowedOrigins`, `maxAgeSeconds`, whether `id` is allowed) was not extracted from the `cors.Rule` component schema. Read `components.schemas` in https://garagehq.deuxfleurs.fr/api/garage-admin-v2.json or verify in the integration test; the S3 `PutBucketCors` XML path is the documented fallback.
- **Status of issue #263 (anonymous S3 access)** is unknown (page walled). The source on `main-v2` as of 2026-09-30 still returns "Garage does not support anonymous access yet", so treat it as unsupported for v2.4.x.
- **`STREAMING-UNSIGNED-PAYLOAD-TRAILER` (aws-chunked trailing checksums)** for non-presigned server-side `PutObject` from Node: `payload.rs` parses `STREAMING-` content-sha256 values with a trailer flag, and issue #824 tracked it, but I did not confirm end-to-end that current SDK streaming uploads succeed with `WHEN_REQUIRED`. The template uses presigned URLs for browser uploads; for server-side uploads pass a `Buffer`, not a stream, or test first. https://git.deuxfleurs.fr/Deuxfleurs/garage/issues/824
- **Traefik rewriting the `Host` header** (to fake `<bucket>.web.example.com` for a path-prefix router on `s3.example.com/<bucket>/`) is not documented in Traefik's headers-middleware reference; only `X-Forwarded-Host` handling is documented. Do not build on it. https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/headers/
- **`CleanupIncompleteUploads` request body** fields were not extracted (assumed `bucketId` + `olderThanSecs`); confirm in the OpenAPI JSON.
- **MinIO's last binary release identifier** (`RELEASE.2025-10-15T17-29-55Z`) comes from secondary sources in search results, not from the archived repo page itself.
- **SeaweedFS anonymous-read / bucket-policy behaviour** was not verified; only its release recency and single-container mode were.

## Recommended spec deviations

1. **Pin `dxflrs/garage:v2.4.1`** and start with `/garage server --single-node`. Drop the `layout assign/apply` step from `dbm init`; keep the admin-API layout calls (`GetClusterStatus` -> `UpdateClusterLayout` -> `ApplyClusterLayout`) only as a documented fallback for older images. Section 7 `init` step 6.
2. **Public buckets cannot live at `s3.example.com/<bucket>/<key>`** (5.4, 7 `storage public`). Garage has no anonymous S3 access and the web endpoint is Host-resolved. Change to: `s3_web.root_domain = ".web.example.com"`, one wildcard A record `*.web.example.com` -> VPS, and `dbm storage public <slug>` (a) sets `websiteAccess.enabled=true` via `UpdateBucket`, (b) creates a Traefik/Dokploy domain `<slug>.web.example.com` -> `garage:3902` (Let's Encrypt HTTP-01 per host), and (c) prints `S3_PUBLIC_BASE_URL=https://<slug>.web.example.com`. Optional `--domain assets.myapp.com` adds a global alias via `AddBucketAlias` so a vanity hostname works. Add `publicBaseUrl` to the `storage` state object (Section 8). Note the web endpoint has no directory listing and serves `index.html` for `/`.
3. **Set CORS at `dbm create`** (new sub-step in 7 `create` step 5): `UpdateBucket` with `corsRules` allowing `GET, PUT, POST, DELETE, HEAD`, `allowedHeaders: ["*"]`, `exposeHeaders: ["ETag"]`, origins defaulting to `*` with a `--cors-origin` flag to tighten. Without it browser presigned PUTs fail at preflight. Add `dbm storage cors <slug> --origin ...` as a hidden maintenance command.
4. **Template S3Client** (5.7 `lib/s3.ts`): add `requestChecksumCalculation: "WHEN_REQUIRED"` and `responseChecksumValidation: "WHEN_REQUIRED"` next to `forcePathStyle: true`, `region: "garage"`. Presign expiry <= 7 days.
5. **Key permissions**: grant the app key `read + write` only, not `owner`, and have `dbm` manage CORS/website via the admin API. `owner` is only needed for `PutBucketCors`/`PutBucketWebsite`/`PutBucketLifecycle`; withholding it shrinks the blast radius of a leaked app key. Update 5.4 and 7 `create` step 5. Keep `AllowBucketKey`'s additive semantics in mind: revocation is `DenyBucketKey`.
6. **`dbm destroy --purge-storage`** must empty the bucket before `DeleteBucket` (400 on non-empty). Sequence: `CleanupIncompleteUploads`, then S3 `ListObjectsV2` + `DeleteObjects` using a short-lived key created by `dbm` with `write` (or the project key before it is deleted), then `DeleteBucket`, then `DeleteKey`. Also note `DeleteKey` leaves buckets dangling by design. Section 7 `destroy` step 5.
7. **`dbm list` storage column**: use `GetBucketInfo` `bytes` and `objects`; also surface `unfinishedUploads` in `dbm doctor` (aborted browser uploads accumulate).
8. **Durability for `replication_factor = 1`** (5.4/5.5): set `metadata_fsync = true`, `metadata_auto_snapshot_interval = "6h"`, a dedicated `metadata_snapshots_dir` volume, and include the snapshots volume in the nightly off-site rclone job (the bucket-content sync alone cannot rebuild bucket/key metadata). Document recovery scenario "corrupted LMDB on single node -> restore last snapshot" in `runbook.md`.
9. **Use a scoped admin token for the CLI** (5.6 `config.json`): `dbm init` creates a `dbm` token via `CreateAdminToken` with the exact scope list from the table above and stores that; the master `GARAGE_ADMIN_TOKEN` stays only in the compose env on the VPS. Rotation becomes `DeleteAdminToken` + `CreateAdminToken`.
10. **rclone storage-sync remote** (5.5): `type = s3, provider = Other, region = garage, endpoint = http://garage:3900` (inside the Docker network; no TLS hop), `force_path_style = true`, `no_check_bucket = true` (the read-only `dbm-backup` key cannot create buckets), plus `--fast-list`.
11. **`dbm import --storage`** (7): default the Supabase endpoint to `https://<ref>.storage.supabase.co/storage/v1/s3`, require `--storage-region` (project region, e.g. `us-east-1`) since SigV4 needs it, and warn that Supabase S3 keys bypass RLS and see every bucket. Run `rclone copy supabase:<bucket> garage:<slug>` with a temporary Garage key that has `write`.
12. **Decision log (17)**: strengthen the MinIO rationale with the archive date (2026-04-25) and record that RustFS was considered and rejected for now because its 1.0 GA is two weeks old. Keep SeaweedFS as fallback; note the one behavioural difference that would matter on a swap (SeaweedFS has bucket policies, so public-by-path would become possible there).
13. **`S3_REGION=garage`** already matches `s3_region`; keep, and make `dbm doctor` assert the two agree.

## Sources

Garage official
- https://garagehq.deuxfleurs.fr/_releases.html
- https://garagehq.deuxfleurs.fr/documentation/quick-start/
- https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/
- https://garagehq.deuxfleurs.fr/documentation/reference-manual/admin-api/
- https://garagehq.deuxfleurs.fr/api/garage-admin-v2.json
- https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/
- https://garagehq.deuxfleurs.fr/documentation/reference-manual/known-issues/
- https://garagehq.deuxfleurs.fr/documentation/cookbook/exposing-websites/
- https://garagehq.deuxfleurs.fr/documentation/cookbook/reverse-proxy/
- https://garagehq.deuxfleurs.fr/documentation/cookbook/real-world/
- https://garagehq.deuxfleurs.fr/documentation/operations/durability-repairs/
- https://garagehq.deuxfleurs.fr/documentation/connect/cli/
- https://garagehq.deuxfleurs.fr/documentation/connect/apps/
- https://garagehq.deuxfleurs.fr/documentation/connect/backup/
- https://garagehq.deuxfleurs.fr/documentation/working-documents/migration-2/
- https://garagehq.deuxfleurs.fr/blog/2025-06-garage-v2/
- https://garagehq.deuxfleurs.fr/blog/2026-04-performance-reliability/
- https://git.deuxfleurs.fr/Deuxfleurs/garage/releases/tag/v2.3.0 (walled; via snippet)
- https://git.deuxfleurs.fr/Deuxfleurs/garage/issues/263 (walled)
- https://git.deuxfleurs.fr/Deuxfleurs/garage/issues/824 (walled)

Garage source (GitHub mirror, branch `main-v2`, fetched 2026-09-30)
- https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/doc/book/quick-start/_index.md
- https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/doc/book/reference-manual/configuration.md
- https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/doc/book/reference-manual/admin-api.md
- https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/doc/book/cookbook/exposing-websites.md
- https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/doc/book/operations/recovering.md
- https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/garage/server.rs
- https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/garage/cli/structs.rs
- https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/api/common/signature/mod.rs
- https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/api/common/signature/payload.rs
- https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/api/common/signature/checksum.rs
- https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/api/common/helpers.rs
- https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/api/s3/api_server.rs
- https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/api/s3/error.rs
- https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/src/web/web_server.rs
- https://raw.githubusercontent.com/deuxfleurs-org/garage/main-v2/SECURITY.md
- https://api.github.com/repos/deuxfleurs-org/garage
- https://api.github.com/repos/deuxfleurs-org/garage/compare/v2.3.0...v2.4.1
- https://api.github.com/repos/deuxfleurs-org/garage/compare/v2.4.0...v2.4.1
- https://hub.docker.com/v2/repositories/dxflrs/garage/tags?name=v2

AWS SDK
- https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html
- https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html
- https://github.com/aws/aws-sdk-js-v3/issues/6810
- https://github.com/m0t0r/recomencemos/issues/317 (third-party report against Garage v2.4.1)

Supabase / rclone
- https://supabase.com/docs/guides/storage/s3/authentication
- https://supabase.com/docs/guides/self-hosting/copy-from-platform-s3
- https://rclone.org/s3/

Security databases
- https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=deuxfleurs%20garage
- https://api.osv.dev/v1/query (crates.io `garage`, `garage_api_s3`)
- https://api.github.com/advisories?ecosystem=rust&affects=garage

Alternatives
- https://github.com/minio/minio and https://api.github.com/repos/minio/minio
- https://api.github.com/repos/seaweedfs/seaweedfs/releases/latest ; https://github.com/seaweedfs/seaweedfs
- https://api.github.com/repos/rustfs/rustfs/releases/latest ; https://rustfs.com/blog/announcing-rustfs-1-0-0-ga/
- https://www.ibm.com/docs/en/storage-ceph/8.0.0?topic=recommendations-minimum-hardware-considerations
- https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/headers/
