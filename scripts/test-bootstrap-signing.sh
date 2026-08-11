#!/usr/bin/env bash
#
# Regression test for the OU (team ID) parsing logic used by
# detect_signing_identity() in scripts/bootstrap.sh. This test does NOT
# invoke bootstrap.sh or detect_signing_identity() itself (bootstrap.sh
# ends in an unconditional `main "$@"` that would clone the repo, prompt
# for signing, etc. -- unsafe to source directly). Instead it extracts the
# real sed script used inside detect_signing_identity() straight out of
# scripts/bootstrap.sh at run time, and applies that extracted sed script
# to fixture `openssl x509 -noout -subject` strings. This keeps the test
# wired to the real implementation: if the sed pattern in bootstrap.sh
# regresses or is reverted, this test fails without needing a second
# hand-maintained copy of the pattern.
#
# Usage: ./scripts/test-bootstrap-signing.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP_SH="${SCRIPT_DIR}/bootstrap.sh"

extract_sed_pattern() {
  # Pull just the detect_signing_identity() function body out of
  # bootstrap.sh (never source the whole file -- see header comment).
  local func_body
  func_body="$(sed -n '/^detect_signing_identity() {/,/^}/p' "${BOOTSTRAP_SH}")"

  if [[ -z "${func_body}" ]]; then
    echo "error: could not locate detect_signing_identity() in ${BOOTSTRAP_SH}" >&2
    exit 1
  fi

  local sed_line
  sed_line="$(echo "${func_body}" | grep 'sed -n' | head -n 1)"

  if [[ -z "${sed_line}" ]]; then
    echo "error: could not find a 'sed -n' invocation inside detect_signing_identity() in ${BOOTSTRAP_SH}" >&2
    exit 1
  fi

  # sed_line looks like: team="$(echo "${subject}" | sed -n 's/.../p')"
  # Pull out just the single-quoted sed script.
  local pattern
  pattern="$(echo "${sed_line}" | sed -n "s/.*sed -n '\\(.*\\)'.*/\\1/p")"

  if [[ -z "${pattern}" ]]; then
    echo "error: could not extract sed script from line: ${sed_line}" >&2
    exit 1
  fi

  echo "${pattern}"
}

SED_PATTERN="$(extract_sed_pattern)"

extract_team() {
  echo "$1" | sed -n "${SED_PATTERN}"
}

FAILURES=0

check() {
  local description="$1"
  local subject="$2"
  local expected="$3"
  local actual

  actual="$(extract_team "${subject}")"

  if [[ "${actual}" == "${expected}" ]]; then
    echo "PASS: ${description}"
  else
    echo "FAIL: ${description}"
    echo "  subject:  ${subject}"
    echo "  expected: \"${expected}\""
    echo "  actual:   \"${actual}\""
    FAILURES=$((FAILURES + 1))
  fi
}

check "spaced OU format (LibreSSL-style)" \
  "subject=UID = ABC123, CN = Apple Development: Name (ABC123), OU = TEAMID1, O = Org, C = US" \
  "TEAMID1"

check "unspaced OU format (OpenSSL 3.x-style)" \
  "subject=UID=ABC123,CN=Apple Development: Name (ABC123),OU=TEAMID2,O=Org,C=US" \
  "TEAMID2"

check "no OU field present" \
  "subject=UID=ABC123,CN=Apple Development: Name (ABC123),O=Org,C=US" \
  ""

if [[ "${FAILURES}" -gt 0 ]]; then
  echo "test-bootstrap-signing: ${FAILURES} fixture(s) failed" >&2
  exit 1
fi

echo "test-bootstrap-signing: all fixtures passed"
