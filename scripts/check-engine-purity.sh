#!/usr/bin/env bash
# The engine dependency rule, as a build failure rather than a paragraph in a doc.
#
# ARCHITECTURE.md §1 claimed this "is checkable in CI with a one-line grep and should be" —
# and then nothing checked it. src/engine/** must never import discord.js or a node builtin,
# and must never call Date.now(), Math.random(), setTimeout or setInterval: determinism and
# testability (audit #54, #17/#58) both depend on it.
#
# Comment lines are skipped, so the file that explains why randomSeed() was moved out of the
# engine does not itself fail the check.
set -uo pipefail

FORBIDDEN='Math\.random|Date\.now|setTimeout|setInterval|from ['"'"'"](discord\.js|node:)'

hits=$(grep -rnE "$FORBIDDEN" src/engine/ 2>/dev/null \
  | grep -vE ':[0-9]+:[[:space:]]*(\*|//|/\*)' || true)

if [ -n "$hits" ]; then
  echo "Engine purity violation — src/engine must have no platform dependency and no clock:"
  echo "$hits"
  exit 1
fi

echo "engine purity: OK (no discord.js, no node builtins, no clock, no Math.random)"
