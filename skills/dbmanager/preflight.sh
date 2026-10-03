#!/usr/bin/env bash
# dbmanager preflight: inspect the machine and the target folder, print one JSON object.
# Usage: bash ~/.claude/skills/dbmanager/preflight.sh [folder]   (default: current dir)
# Never prints secrets. Exit 0 always; the agent acts on the JSON fields.
set -u
DIR="${1:-$PWD}"; DIR="$(cd "$DIR" 2>/dev/null && pwd -P || echo "$DIR")"

jstr() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }

# 1. dbm CLI: present? installable from the local repo or npm?
DBM="$(command -v dbm || true)"
INSTALL_HINT=""
if [ -z "$DBM" ]; then
  if [ -f "$HOME/projects/db-manager/package.json" ]; then
    INSTALL_HINT="cd $HOME/projects/db-manager && npm install && npm run build && npm link"
  else
    INSTALL_HINT="npm i -g db-manager"
  fi
fi

# 2. dbm root (templates live there), via the resolved symlink of the bin
DBM_ROOT=""; TEMPLATES=""
if [ -n "$DBM" ]; then
  REAL="$(readlink -f "$DBM" 2>/dev/null || python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$DBM")"
  DBM_ROOT="$(cd "$(dirname "$REAL")/.." 2>/dev/null && pwd -P)"
  [ -d "$DBM_ROOT/templates/nextjs" ] && TEMPLATES="$DBM_ROOT/templates/nextjs"
fi

# 2b. installed dbm new enough for this skill (import --replace)?
DBM_V2=false
[ -n "$DBM" ] && dbm import --help 2>/dev/null | grep -q -- '--replace' && DBM_V2=true

# 3. platform configured on this machine?
CONFIGURED=false; [ -f "$HOME/.dbm/config.json" ] && CONFIGURED=true

# 4. slug from folder name: lowercase, non [a-z0-9] -> '-', squeeze, trim, 3..31, no dbm- prefix
BASE="$(basename "$DIR" | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
BASE="$(printf '%s' "$BASE" | cut -c1-31 | sed -E 's/-+$//')"
SLUG_OK=true; SLUG_NOTE=""
case "$BASE" in
  dbm-*) SLUG_OK=false; SLUG_NOTE="dbm- prefix is reserved";;
  [a-z]*) [ ${#BASE} -ge 3 ] || { SLUG_OK=false; SLUG_NOTE="shorter than 3 chars"; };;
  *) SLUG_OK=false; SLUG_NOTE="must start with a letter";;
esac

# 5. folder state
HAS_PKG=false; IS_NEXT=false; EMPTY=true
[ -f "$DIR/package.json" ] && HAS_PKG=true && grep -q '"next"' "$DIR/package.json" && IS_NEXT=true
[ -n "$(ls -A "$DIR" 2>/dev/null | grep -vE '^(\.git|\.DS_Store|AGENTS\.md|CLAUDE\.md|README\.md|\.claude)$')" ] && EMPTY=false
VERCEL_LINKED=false; [ -f "$DIR/.vercel/project.json" ] && VERCEL_LINKED=true

# 6. tools
HAS_JQ=false; command -v jq >/dev/null && HAS_JQ=true
HAS_VERCEL=false; command -v vercel >/dev/null && HAS_VERCEL=true
NODE="$(node --version 2>/dev/null || echo none)"

# 7. supabase detection (files whose import path mentions supabase: @supabase/* or a local client wrapper)
SB_DETECTED=false; SB_ENV=false; SB_FILES_JSON="[]"
if [ "$HAS_PKG" = true ] && grep -qE '"@supabase/(supabase-js|ssr)"' "$DIR/package.json"; then
  SB_DETECTED=true
  SB_FILES_JSON="$(cd "$DIR" && grep -rlE "from ['\"][^'\"]*supabase" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' . 2>/dev/null \
    | grep -vE '/(node_modules|\.next|dist)/' | sed 's#^\./##' | sort | head -200 \
    | python3 -c 'import json,sys; print(json.dumps([l.rstrip("\n") for l in sys.stdin if l.strip()]))')"
fi
for f in "$DIR"/.env "$DIR"/.env.local "$DIR"/.env.development "$DIR"/.env.production; do
  [ -f "$f" ] && grep -q 'SUPABASE_URL' "$f" && SB_ENV=true
done

# 8. mode
if [ "$EMPTY" = true ]; then MODE=create
elif [ "$IS_NEXT" = true ] && [ "$SB_DETECTED" = true ]; then MODE=migrate
elif [ "$IS_NEXT" = true ]; then MODE=connect
else MODE=unknown; fi

cat <<JSON
{
  "folder": $(jstr "$DIR"),
  "dbm": $(jstr "$DBM"),
  "dbmInstallHint": $(jstr "$INSTALL_HINT"),
  "dbmImportV2": $DBM_V2,
  "dbmRoot": $(jstr "$DBM_ROOT"),
  "templatesDir": $(jstr "$TEMPLATES"),
  "configured": $CONFIGURED,
  "slug": $(jstr "$BASE"),
  "slugOk": $SLUG_OK,
  "slugNote": $(jstr "$SLUG_NOTE"),
  "folderEmpty": $EMPTY,
  "hasPackageJson": $HAS_PKG,
  "isNextApp": $IS_NEXT,
  "vercelLinked": $VERCEL_LINKED,
  "mode": "$MODE",
  "supabase": { "detected": $SB_DETECTED, "files": $SB_FILES_JSON, "envPresent": $SB_ENV },
  "hasJq": $HAS_JQ,
  "hasVercelCli": $HAS_VERCEL,
  "node": $(jstr "$NODE")
}
JSON
