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

# Build with code signing disabled. This is the variant that succeeds for
# this project (the generated targets don't require entitlements that force
# signing for a local Debug build).
#
# If a future change to the generated project causes this to fail with a
# signing-related error, fall back to ad-hoc signing instead:
#   xcodebuild -project "${XCODEPROJ}" -scheme "${SCHEME}" \
#     -configuration "${CONFIGURATION}" \
#     -derivedDataPath "${DERIVED_DATA_PATH}" \
#     CODE_SIGN_IDENTITY="-" \
#     build
xcodebuild -project "${XCODEPROJ}" -scheme "${SCHEME}" \
  -configuration "${CONFIGURATION}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY="" \
  build

APP_PATH="$(find "${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}" -maxdepth 1 -name "*.app" -print -quit)"

if [[ -z "${APP_PATH}" || ! -d "${APP_PATH}" ]]; then
  echo "error: build succeeded but no .app was found under ${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}" >&2
  exit 1
fi

echo "Built app: ${APP_PATH}"
