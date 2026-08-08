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

# Sign with Developer ID (team Y5SB82BPYL) so Safari treats the extension as
# properly signed — no "Allow Unsigned Extensions" toggle needed, and it
# survives Safari restarts. Do NOT use CODE_SIGNING_ALLOWED=NO: that leaves
# only linker-signed binaries with wrong codesign identifiers, and
# macOS/pluginkit refuses to register the appex. If the Developer ID identity
# is unavailable, fall back to ad-hoc: CODE_SIGN_IDENTITY="-" (works, but
# requires the unsigned-extensions toggle each Safari restart).
xcodebuild -project "${XCODEPROJ}" -scheme "${SCHEME}" \
  -configuration "${CONFIGURATION}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="Developer ID Application" \
  DEVELOPMENT_TEAM=Y5SB82BPYL \
  build

APP_PATH="$(find "${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}" -maxdepth 1 -name "*.app" -print -quit)"

if [[ -z "${APP_PATH}" || ! -d "${APP_PATH}" ]]; then
  echo "error: build succeeded but no .app was found under ${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}" >&2
  exit 1
fi

echo "Built app: ${APP_PATH}"
