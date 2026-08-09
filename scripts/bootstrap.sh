#!/usr/bin/env bash
#
# One-liner installer entry point for "Archive.ph Opener". Intended to be
# run via:
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/ebowman/archive-ph-safari-plugin/main/scripts/bootstrap.sh)"
#
# It checks prerequisites, auto-detects an Apple Development signing
# identity (falling back to an ad-hoc build with a confirmation prompt),
# clones the repo into a temporary directory, and runs the repo's own
# install.sh, which builds the app, installs it into /Applications, and
# prints Safari enablement guidance.
#
# This script intentionally does not use `exec` when invoking install.sh,
# so that the EXIT trap that cleans up the temporary clone still runs. Do
# not modify build.sh or install.sh from here; this script only drives them.

set -euo pipefail

REPO_URL="https://github.com/ebowman/archive-ph-safari-plugin.git"

check_macos() {
  if [[ "$(uname)" != "Darwin" ]]; then
    echo "error: this installer only supports macOS." >&2
    exit 1
  fi
}

check_git() {
  if ! command -v git >/dev/null 2>&1; then
    echo "error: git is required but was not found on PATH." >&2
    echo "Install Xcode Command Line Tools or Xcode, then re-run this installer." >&2
    exit 1
  fi
}

check_full_xcode() {
  if ! command -v xcode-select >/dev/null 2>&1; then
    echo "error: xcode-select not found. Install Xcode from the App Store." >&2
    exit 1
  fi

  local dev_dir
  if ! dev_dir="$(xcode-select -p 2>/dev/null)"; then
    echo "error: could not determine the active developer directory." >&2
    echo "Install Xcode from the App Store, then run:" >&2
    echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
    exit 1
  fi

  if [[ "${dev_dir}" != *.app/Contents/Developer ]]; then
    echo "error: full Xcode is required to build this app, but the active developer" >&2
    echo "directory is: ${dev_dir}" >&2
    echo "This looks like the Command Line Tools, not full Xcode." >&2
    echo "Install Xcode from the App Store, then run:" >&2
    echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
    exit 1
  fi

  if ! xcodebuild -version >/dev/null 2>&1; then
    echo "error: 'xcodebuild -version' failed." >&2
    echo "This is commonly caused by an unaccepted Xcode license. Try:" >&2
    echo "  sudo xcodebuild -license accept" >&2
    exit 1
  fi
}

# Sets the globals: DETECTED_SIGN_IDENTITY, DETECTED_SIGN_TEAM (may be empty
# if no Apple Development identity was found). Never fails the script due to
# set -e even if `security` exits nonzero or reports zero identities.
detect_signing_identity() {
  DETECTED_SIGN_IDENTITY=""
  DETECTED_SIGN_TEAM=""

  local identity_line
  identity_line="$(security find-identity -v -p codesigning 2>/dev/null | grep "Apple Development" | head -n 1 || true)"

  if [[ -z "${identity_line}" ]]; then
    return 0
  fi

  local subject
  subject="$(security find-certificate -c "Apple Development" -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null || true)"

  if [[ -z "${subject}" ]]; then
    return 0
  fi

  # subject looks like:
  #   subject=UID = XXXXXXXXXX, CN = Apple Development: name (XXXXXXXXXX), OU = TEAMID, O = ..., C = US
  # The parenthesized string after the CN is NOT the team ID -- only the OU
  # field is the team ID.
  local team
  team="$(echo "${subject}" | sed -n 's/.*OU = \([A-Z0-9]*\).*/\1/p')"

  if [[ -z "${team}" ]]; then
    return 0
  fi

  DETECTED_SIGN_IDENTITY="Apple Development"
  DETECTED_SIGN_TEAM="${team}"
}

# Resolves SIGN_IDENTITY / SIGN_TEAM (may leave both empty for ad-hoc).
# Prompts for confirmation via /dev/tty if falling back to ad-hoc signing.
resolve_signing() {
  if [[ -n "${SIGN_TEAM:-}" ]]; then
    # Respect a pre-set, non-empty SIGN_TEAM from the environment.
    SIGN_IDENTITY="${SIGN_IDENTITY:-Apple Development}"
    echo "==> Using pre-set SIGN_TEAM=${SIGN_TEAM} (SIGN_IDENTITY=${SIGN_IDENTITY})"
    return 0
  fi

  SIGN_IDENTITY=""
  SIGN_TEAM=""

  detect_signing_identity

  if [[ -n "${DETECTED_SIGN_TEAM}" ]]; then
    SIGN_IDENTITY="${DETECTED_SIGN_IDENTITY}"
    SIGN_TEAM="${DETECTED_SIGN_TEAM}"
    echo "==> Detected signing identity \"${SIGN_IDENTITY}\" (team ${SIGN_TEAM}); will use it for a development-signed build."
    return 0
  fi

  cat >&2 <<'EOF'

warning: no Apple Development signing identity was found.

The build will be ad-hoc signed. Safari will require you to re-enable
"Allow Unsigned Extensions" every time Safari restarts:

  1. Safari Settings -> Advanced -> enable "Show features for web developers"
  2. Safari -> Develop -> Allow Unsigned Extensions

The permanent fix is free:
  Xcode -> Settings -> Accounts -> add your Apple ID -> Manage Certificates
  -> "+" -> Apple Development, then re-run this installer.

EOF

  if [[ ! -e /dev/tty ]]; then
    echo "error: no terminal available to confirm an unsigned build." >&2
    echo "Re-run this installer interactively, or pre-set SIGN_TEAM (and optionally" >&2
    echo "SIGN_IDENTITY) in the environment before running it." >&2
    exit 1
  fi

  if ! read -r -p "Press Enter to continue with an unsigned build, or Ctrl-C to abort. " _reply </dev/tty; then
    echo "error: aborted (could not read confirmation from /dev/tty)." >&2
    exit 1
  fi
}

main() {
  check_macos
  check_git
  check_full_xcode

  resolve_signing

  WORKDIR="$(mktemp -d)"
  trap 'rm -rf "${WORKDIR}"' EXIT

  local clone_dir="${WORKDIR}/archive-ph-safari-plugin"

  echo "==> Cloning ${REPO_URL}..."
  git clone --depth 1 "${REPO_URL}" "${clone_dir}"

  echo "==> Running install.sh..."
  if [[ -n "${SIGN_TEAM}" ]]; then
    SIGN_IDENTITY="${SIGN_IDENTITY}" SIGN_TEAM="${SIGN_TEAM}" "${clone_dir}/install.sh"
  else
    "${clone_dir}/install.sh"
  fi
}

main "$@"
