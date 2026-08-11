#!/usr/bin/env bash
#
# Single entry point for every quality gate in this repo: manifest lint,
# syntax checks, the four node test suites, and the tsc structural-lint
# gate. Exits nonzero on the first failing gate.
#
# Usage: ./scripts/run-checks.sh  (or scripts/run-checks.sh from anywhere)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

GATE_COUNT=0

run_gate() {
  local name="$1"
  shift
  GATE_COUNT=$((GATE_COUNT + 1))
  echo "==> [${GATE_COUNT}] ${name}"
  if ! "$@"; then
    echo "FAIL: ${name}" >&2
    exit 1
  fi
}

run_gate_tail() {
  # Runs a command through `tail -1` while still propagating a nonzero
  # exit code from the command itself (not from tail). Relies on
  # `set -o pipefail` (enabled above) so that $? reflects the first
  # failing stage of the pipeline, i.e. the node process, not tail.
  local name="$1"
  shift
  GATE_COUNT=$((GATE_COUNT + 1))
  echo "==> [${GATE_COUNT}] ${name}"
  if ! "$@" | tail -1; then
    echo "FAIL: ${name}" >&2
    exit 1
  fi
}

# --- Fast gates first -------------------------------------------------

run_gate "manifest.json is valid JSON" \
  bash -c 'python3 -m json.tool extension/manifest.json >/dev/null'

run_gate "syntax: extension/background.js" \
  node --check extension/background.js

run_gate "syntax: extension/archive-url.js" \
  node --check extension/archive-url.js

run_gate "syntax: extension/snapshot-probe.js" \
  node --check extension/snapshot-probe.js

run_gate "syntax: extension/settings/settings.js" \
  node --check extension/settings/settings.js

run_gate "test suite: test-bootstrap-signing" \
  ./scripts/test-bootstrap-signing.sh

# --- Node test suites ---------------------------------------------------

run_gate_tail "test suite: test-archive-url" node scripts/test-archive-url.js
run_gate_tail "test suite: test-background" node scripts/test-background.js
run_gate_tail "test suite: test-settings" node scripts/test-settings.js
run_gate_tail "test suite: test-snapshot-probe" node scripts/test-snapshot-probe.js

# --- TypeScript structural-lint gate -------------------------------------

# Type-checks the four extension scripts as global (non-module) scripts
# sharing one lexical scope, catching cross-file redeclarations of
# top-level bindings (see bead archive-ph-safari-plugin-umg / bug 9k9) plus
# other structural JS errors. No devDependency needed -- npx fetches
# TypeScript on demand; needs network on a cold npx cache. Must use
# `-p typescript` since bare `npx tsc` resolves to an unrelated, deprecated
# `tsc` npm package.
run_gate "tsc: scripts/tsconfig.extension.json" \
  npx -p typescript tsc -p scripts/tsconfig.extension.json

echo "ALL CHECKS PASSED (${GATE_COUNT} gates)"
