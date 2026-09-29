#!/usr/bin/env bash
#
# Verifies scripts/select-sim.py's fallback-iPhone selection logic against
# synthetic `simctl list devices available -j` fixtures, without needing a
# real simulator installed. Exercises two cases:
#
#   (a) Two runtimes installed (iOS 18.2 and iOS 26.5), each with a single
#       iPhone -> the iOS 26.5 device must be chosen (newest runtime wins).
#   (b) A single newest runtime with three iPhones ("iPhone 17",
#       "iPhone 17 Pro", "iPhone 17 Pro Max") -> "iPhone 17 Pro" must be
#       chosen (Pro preferred over plain and over Pro Max).
#
# Usage: ./scripts/test-install-sim-select.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELECT_SIM="${REPO_ROOT}/scripts/select-sim.py"

FAILURES=0

# --- Fixture (a): newest runtime wins ------------------------------------

FIXTURE_A='{
  "devices": {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
      {
        "name": "iPhone 15",
        "udid": "AAAAAAAA-0000-0000-0000-000000000001",
        "isAvailable": true,
        "state": "Shutdown"
      }
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
      {
        "name": "iPhone 17",
        "udid": "BBBBBBBB-0000-0000-0000-000000000002",
        "isAvailable": true,
        "state": "Shutdown"
      }
    ]
  }
}'

EXPECTED_A="BBBBBBBB-0000-0000-0000-000000000002"
ACTUAL_A="$(printf '%s' "${FIXTURE_A}" | python3 "${SELECT_SIM}")"

if [[ "${ACTUAL_A}" == "${EXPECTED_A}" ]]; then
  echo "PASS: fixture (a) newest runtime (iOS 26.5) chosen"
else
  echo "FAIL: fixture (a) expected UDID ${EXPECTED_A}, got '${ACTUAL_A}'" >&2
  FAILURES=$((FAILURES + 1))
fi

# --- Fixture (b): "Pro" preferred over plain and "Pro Max" ---------------

FIXTURE_B='{
  "devices": {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
      {
        "name": "iPhone 17",
        "udid": "CCCCCCCC-0000-0000-0000-000000000003",
        "isAvailable": true,
        "state": "Shutdown"
      },
      {
        "name": "iPhone 17 Pro",
        "udid": "DDDDDDDD-0000-0000-0000-000000000004",
        "isAvailable": true,
        "state": "Shutdown"
      },
      {
        "name": "iPhone 17 Pro Max",
        "udid": "EEEEEEEE-0000-0000-0000-000000000005",
        "isAvailable": true,
        "state": "Shutdown"
      }
    ]
  }
}'

EXPECTED_B="DDDDDDDD-0000-0000-0000-000000000004"
ACTUAL_B="$(printf '%s' "${FIXTURE_B}" | python3 "${SELECT_SIM}")"

if [[ "${ACTUAL_B}" == "${EXPECTED_B}" ]]; then
  echo "PASS: fixture (b) \"iPhone 17 Pro\" chosen over plain and Pro Max"
else
  echo "FAIL: fixture (b) expected UDID ${EXPECTED_B}, got '${ACTUAL_B}'" >&2
  FAILURES=$((FAILURES + 1))
fi

if [[ "${FAILURES}" -gt 0 ]]; then
  echo "FAILED: ${FAILURES} fixture(s) failed" >&2
  exit 1
fi

echo "ALL FIXTURES PASSED"
