#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/claude-handoff"

rm -rf "$out"
mkdir -p "$out/texts" "$out/js" "$out/supabase/functions/ai" "$out/supabase/migrations"

copy_if_exists() {
  local src="$1"
  local dst="$2"
  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
  fi
}

# Entry points for Claude.
copy_if_exists "$root/CLAUDE.md" "$out/CLAUDE.md"
copy_if_exists "$root/README.md" "$out/README.md"

# Active project context. Archive is intentionally excluded.
for file in \
  README.md \
  ROUTER.md \
  SNAPSHOT.md \
  NEXT.md \
  CONTEXT.md \
  STATUS.md \
  RULES.md \
  UI_PHILOSOPHY.md \
  MASTER_PROMPT.md \
  PROMPTS.md \
  TERMINOLOGY.md \
  IDEAS_NEAR_TERM.md \
  IDEAS_DONE_OR_DORMANT.md \
  IDEAS_FUTURE.md \
  IDEAS_BETA_DELIGHTERS.md
do
  copy_if_exists "$root/texts/$file" "$out/texts/$file"
done

# Runtime files needed for code review.
copy_if_exists "$root/index.html" "$out/index.html"
copy_if_exists "$root/js/app.js" "$out/js/app.js"
copy_if_exists "$root/sw.js" "$out/sw.js"
copy_if_exists "$root/manifest.json" "$out/manifest.json"
copy_if_exists "$root/deploy.sh" "$out/deploy.sh"

# Supabase source of truth.
copy_if_exists "$root/supabase/functions/ai/index.ts" "$out/supabase/functions/ai/index.ts"
if [ -d "$root/supabase/migrations" ]; then
  find "$root/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -exec cp {} "$out/supabase/migrations/" \;
fi

find "$out" -type f -print | sort
