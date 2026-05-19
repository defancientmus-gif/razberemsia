#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/claude-handoff"

rm -rf "$out"
mkdir -p "$out"

cp "$root/README.md" "$out/README.md"
cp "$root/project-memory/README.md" "$out/project-memory_README.md"
cp "$root/project-memory/current/2026-05-19_PROJECT_BRIEF.md" "$out/2026-05-19_PROJECT_BRIEF.md"
cp "$root/project-memory/current/2026-05-19_AGENT_RULES.md" "$out/2026-05-19_AGENT_RULES.md"
cp "$root/project-memory/current/2026-05-19_TODO.md" "$out/2026-05-19_TODO.md"
cp "$root/project-memory/current/2026-05-19_AI_MEMORY.md" "$out/2026-05-19_AI_MEMORY.md"
cp "$root/project-memory/current/2026-05-19_RELEASE_CHECKLIST.md" "$out/2026-05-19_RELEASE_CHECKLIST.md"

cp "$root/index.html" "$out/index.html"
cp "$root/js/app.js" "$out/app.js"
cp "$root/sw.js" "$out/sw.js"
cp "$root/supabase.sql" "$out/supabase.sql"
cp "$root/supabase/functions/smooth-processor/index.ts" "$out/supabase_functions_smooth-processor_index.ts"

find "$out" -maxdepth 1 -type f -print | sort
