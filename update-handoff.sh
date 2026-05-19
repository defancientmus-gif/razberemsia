#!/usr/bin/env bash
set -euo pipefail

# Rebuild the flat Claude upload folder from the current project files.
# Use before sending files to Claude.
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/build-claude-handoff.sh"
