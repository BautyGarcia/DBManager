#!/usr/bin/env bash
# Re-hydrate every project's Garage bucket from the off-site storage mirror after a VPS loss.
# Run on the NEW VPS after `dbm init` and `dbm restore <slug> latest --as <slug>` for each project.
# Usage: recover-storage.sh <slug>...   (reads /etc/dokploy/dbm/rclone/rclone.conf written by init; B2_STORAGE_BUCKET env required)
#
# The `garage` remote in rclone.conf uses the read-only `dbm-backup` key. For recovery, either
# temporarily grant it write on each bucket (docker exec dbm-garage /garage bucket allow --read --write <slug> --key dbm-backup,
# and deny --write again afterwards; see docs/runbook.md), or edit the conf to use the project key from `dbm env <slug>`.
set -euo pipefail
: "${B2_STORAGE_BUCKET:?}"
[ "$#" -ge 1 ] || { echo "usage: $0 <slug>..." >&2; exit 1; }
for slug in "$@"; do
  echo "== $slug"
  docker run --rm --network dokploy-network -v /etc/dokploy/dbm/rclone/rclone.conf:/config/rclone/rclone.conf:ro rclone/rclone:1 \
    copy "b2:${B2_STORAGE_BUCKET}/storage/${slug}" "garage:${slug}" --fast-list --transfers 8
done
