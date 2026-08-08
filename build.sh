#!/usr/bin/env bash
#
# Builds the "Archive.ph Opener" Safari app wrapper from the Xcode project
# generated under app/ by `xcrun safari-web-extension-converter`.
#
# Usage: ./build.sh
#
# Output: prints the absolute path of the built .app on success.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Optional local override for codesigning identity/team. Git-ignored; see
# the signing comment below for details.
if [[ -f "${REPO_ROOT}/.signing.env" ]]; then
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/.signing.env"
fi

SIGN_IDENTITY="${SIGN_IDENTITY:--}"
SIGN_TEAM="${SIGN_TEAM:-}"

DERIVED_DATA_PATH="${REPO_ROOT}/app/build"
CONFIGURATION="Debug"

# Locate the generated .xcodeproj under app/ (avoid hardcoding its path,
# since the converter names the project directory after --app-name).
XCODEPROJ="$(find "${REPO_ROOT}/app" -maxdepth 2 -name "*.xcodeproj" -print -quit)"

if [[ -z "${XCODEPROJ}" ]]; then
  echo "error: no .xcodeproj found under ${REPO_ROOT}/app" >&2
  echo "Run: xcrun safari-web-extension-converter extension/ --project-location app/ --app-name \"Archive.ph Opener\" --macos-only --no-open --force" >&2
  exit 1
fi

PROJECT_DIR="$(dirname "${XCODEPROJ}")"

# Discover the scheme name rather than hardcoding it.
SCHEME="$(xcodebuild -list -project "${XCODEPROJ}" 2>/dev/null \
  | awk '/Schemes:/{found=1; next} found && NF{print; exit}' \
  | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

if [[ -z "${SCHEME}" ]]; then
  echo "error: could not determine scheme from ${XCODEPROJ}" >&2
  exit 1
fi

echo "Project: ${XCODEPROJ}"
echo "Scheme:  ${SCHEME}"
echo "Config:  ${CONFIGURATION}"

# Signing is configurable so this repo builds out of the box for anyone who
# clones it, while still supporting Developer ID signing for the owner.
#
# Do NOT use CODE_SIGNING_ALLOWED=NO: that leaves only linker-signed binaries
# with wrong codesign identifiers, and macOS/pluginkit refuses to register
# the appex.
#
# Default (no env vars, no .signing.env): ad-hoc signing
# (CODE_SIGN_IDENTITY="-"). This builds fine for anyone, but Safari will
# require Develop -> "Allow Unsigned Extensions" to be re-enabled after
# every restart.
#
# Identity signing (e.g. Developer ID Application): set SIGN_IDENTITY and
# SIGN_TEAM in the environment, or create a git-ignored "${REPO_ROOT}/.signing.env"
# file (sourced above) containing:
#   SIGN_IDENTITY="Developer ID Application"
#   SIGN_TEAM=YOURTEAMID
# This makes Safari treat the extension as properly signed — no toggle
# needed, and it survives Safari restarts.
SIGNING_ARGS=()
if [[ -n "${SIGN_TEAM}" ]]; then
  SIGNING_ARGS=(
    CODE_SIGN_STYLE=Manual
    CODE_SIGN_IDENTITY="${SIGN_IDENTITY}"
    DEVELOPMENT_TEAM="${SIGN_TEAM}"
  )
  echo "Signing: Developer ID (team ${SIGN_TEAM})"
else
  SIGNING_ARGS=(
    CODE_SIGN_IDENTITY="-"
  )
  echo "Signing: ad-hoc (set SIGN_TEAM/SIGN_IDENTITY or .signing.env for identity signing)"
fi

xcodebuild -project "${XCODEPROJ}" -scheme "${SCHEME}" \
  -configuration "${CONFIGURATION}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  "${SIGNING_ARGS[@]}" \
  build

APP_PATH="$(find "${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}" -maxdepth 1 -name "*.app" -print -quit)"

if [[ -z "${APP_PATH}" || ! -d "${APP_PATH}" ]]; then
  echo "error: build succeeded but no .app was found under ${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}" >&2
  exit 1
fi

echo "Built app: ${APP_PATH}"
