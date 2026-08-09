#!/usr/bin/env bash
#
# Builds the "Archive.ph Opener" Safari app wrapper (via build.sh) and
# installs it into /Applications, replacing any existing copy so Safari
# never lists the extension twice.
#
# Usage: ./install.sh
#        sudo ./install.sh   (if /Applications is not writable by you)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_NAME="Archive.ph Opener"
BUILD_APP_PATH="${REPO_ROOT}/app/build/Build/Products/Debug/${APP_NAME}.app"
INSTALLED_APP_PATH="/Applications/${APP_NAME}.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

echo "==> Building ${APP_NAME}..."
"${REPO_ROOT}/build.sh"

if [[ ! -d "${BUILD_APP_PATH}" ]]; then
  echo "error: build succeeded but expected app not found at: ${BUILD_APP_PATH}" >&2
  exit 1
fi

echo "==> Quitting ${APP_NAME} if running..."
osascript -e "quit app \"${APP_NAME}\"" 2>/dev/null || true

ERR_LOG="$(mktemp)"
trap 'rm -f "${ERR_LOG}"' EXIT

echo "==> Removing existing installed copy at ${INSTALLED_APP_PATH} (if any)..."
if [[ -e "${INSTALLED_APP_PATH}" ]]; then
  if ! rm -rf "${INSTALLED_APP_PATH}" 2>"${ERR_LOG}"; then
    cat "${ERR_LOG}" >&2
    echo "error: could not remove ${INSTALLED_APP_PATH} (permission denied?)." >&2
    echo "Try: sudo ./install.sh" >&2
    exit 1
  fi
fi

echo "==> Copying built app to ${INSTALLED_APP_PATH}..."
if ! ditto "${BUILD_APP_PATH}" "${INSTALLED_APP_PATH}" 2>"${ERR_LOG}"; then
  cat "${ERR_LOG}" >&2
  echo "error: could not copy app into /Applications (permission denied?)." >&2
  echo "Try: sudo ./install.sh" >&2
  exit 1
fi

echo "==> Unregistering stale build-path registration (if any)..."
"${LSREGISTER}" -f -u "${BUILD_APP_PATH}" || true

echo "==> Cleaning up build output..."
rm -rf "${REPO_ROOT}/app/build"

echo "==> Opening ${INSTALLED_APP_PATH} to register the extension..."
open "${INSTALLED_APP_PATH}"

echo "==> Checking signing of installed app..."
CODESIGN_OUTPUT="$(codesign -dv "${INSTALLED_APP_PATH}" 2>&1 || true)"

if echo "${CODESIGN_OUTPUT}" | grep -q "Signature=adhoc"; then
  cat <<'EOF'

This build is ad-hoc signed. Safari will require you to re-enable
"Allow Unsigned Extensions" every time Safari restarts:

  1. Safari Settings -> Advanced -> enable "Show features for web developers"
  2. Safari -> Develop -> Allow Unsigned Extensions

EOF
else
  echo
  echo "Enable the extension in Safari Settings -> Extensions."
  echo
fi

cat <<'EOF'
If the extension doesn't appear in Safari, try quitting and reopening Safari:
  osascript -e 'quit app "Safari"' && open -a Safari
EOF
