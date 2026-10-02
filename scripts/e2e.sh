#!/usr/bin/env bash
# End-to-end against a DISPOSABLE VPS (it will be hardened, and Dokploy is installed on it). Usage:
#   DBM_E2E_HOST=1.2.3.4 DBM_E2E_DOMAIN=example.com TS_AUTHKEY=tskey-... \
#   B2_ENDPOINT=... B2_REGION=... B2_KEY_ID=... B2_KEY_SECRET=... B2_DUMPS=... B2_STORAGE=... scripts/e2e.sh
# Run before each tagged release. Needs: DNS db./s3./*.web. pointing at the host, an
# operator machine on the same tailnet, and ssh access as root with your normal key.
# Note: --json and --yes are global dbm options and go BEFORE the subcommand.
set -euo pipefail
: "${DBM_E2E_HOST:?}" "${DBM_E2E_DOMAIN:?}" "${TS_AUTHKEY:?}" "${B2_ENDPOINT:?}" "${B2_REGION:?}" "${B2_KEY_ID:?}" "${B2_KEY_SECRET:?}" "${B2_DUMPS:?}" "${B2_STORAGE:?}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$ROOT" && npm run build >/dev/null)   # build before HOME changes so the real npm cache is used
export HOME="$(mktemp -d)"          # fresh ~/.dbm so the run never touches the operator's real state
DBM="node $ROOT/bin/dbm.js"

$DBM init "$DBM_E2E_HOST" --domain "$DBM_E2E_DOMAIN" --tailscale-auth-key "$TS_AUTHKEY" \
  --b2-endpoint "$B2_ENDPOINT" --b2-region "$B2_REGION" --b2-key-id "$B2_KEY_ID" --b2-key-secret "$B2_KEY_SECRET" \
  --b2-dumps-bucket "$B2_DUMPS" --b2-storage-bucket "$B2_STORAGE"

CREATE_JSON="$(mktemp)"             # holds credentials; removed below
$DBM --json create e2e-app > "$CREATE_JSON"
rm -f "$CREATE_JSON"
$DBM list
$DBM pause e2e-app && $DBM resume e2e-app
$DBM backup e2e-app
$DBM restore e2e-app latest --as e2e-clone
$DBM storage public e2e-app
$DBM doctor
$DBM --yes destroy e2e-clone --purge-storage --confirm e2e-clone
$DBM --yes destroy e2e-app --purge-storage --confirm e2e-app

echo "== Section 19 verifications (record results in docs/superpowers/research/e2e-<date>.md)"
ssh root@"$DBM_E2E_HOST" 'docker volume ls --format {{.Name}} | grep -c -- -data || true'   # expect 0 leftover project volumes
ssh root@"$DBM_E2E_HOST" 'docker exec $(docker ps -q -f name=dokploy) date -u'                 # cron timezone: UTC
echo "From OUTSIDE the tailnet: nc -zv -w3 $DBM_E2E_HOST 3000 (must fail); nc -zv -w3 db.$DBM_E2E_DOMAIN 6432 (must succeed)"
