#!/usr/bin/env bash
#
# Builds the "Archive.ph Opener" Safari app wrapper (via build.sh) and
# installs it into /Applications, replacing any existing copy so Safari
# never lists the extension twice.
#
# Usage: ./install.sh
#        sudo ./install.sh   (if /Applications is not writable by you)
#        ./install.sh --ios-simulator
#
#   (no flag)         Build the macOS app and install it into /Applications
#                      (existing behaviour, unchanged).
#   --ios-simulator    Build the iOS app for the Simulator (via
#                      ./build.sh --platform ios-simulator), find or boot a
#                      simulator, install the app on it, and launch it. If
#                      no simulator is already booted, the fallback iPhone
#                      is chosen by scripts/select-sim.py, which prefers
#                      the newest installed iOS runtime (and, within that
#                      runtime, a "Pro" model over a plain or "Pro Max"
#                      one) rather than simctl's JSON device order.
#                      Prints a reminder to manually enable the extension in
#                      Settings > Apps > Safari > Extensions.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_NAME="Archive.ph Opener"
BUNDLE_ID="ie.boboco.ArchivePhOpener"

if [[ "${1:-}" == "--ios-simulator" ]]; then
  echo "==> Building ${APP_NAME} for iOS Simulator..."
  "${REPO_ROOT}/build.sh" --platform ios-simulator

  SIM_APP_PATH="$(find "${REPO_ROOT}/app/build/Build/Products/Debug-iphonesimulator" -maxdepth 1 -name "*.app" -print -quit)"

  if [[ -z "${SIM_APP_PATH}" || ! -d "${SIM_APP_PATH}" ]]; then
    echo "error: build succeeded but expected simulator app not found under ${REPO_ROOT}/app/build/Build/Products/Debug-iphonesimulator" >&2
    exit 1
  fi

  echo "==> Looking for a booted simulator..."
  BOOTED_UDIDS="$(xcrun simctl list devices booted -j \
    | python3 -c 'import json,sys; data=json.load(sys.stdin); udids=[d["udid"] for devs in data["devices"].values() for d in devs if d.get("state") == "Booted"]; print("\n".join(udids))')"

  if [[ -z "${BOOTED_UDIDS}" ]]; then
    echo "==> No booted simulator found; selecting the newest-runtime available iPhone..."
    UDID="$(xcrun simctl list devices available -j \
      | python3 "${REPO_ROOT}/scripts/select-sim.py")"

    if [[ -z "${UDID}" ]]; then
      echo "error: no available iPhone simulator found to boot." >&2
      exit 1
    fi

    xcrun simctl boot "${UDID}"
    open -a Simulator 2>/dev/null || echo "warning: could not open Simulator.app (GUI is optional; continuing headless)" >&2
    xcrun simctl bootstatus "${UDID}" -b
  else
    UDID="$(printf '%s\n' "${BOOTED_UDIDS}" | head -n1)"
    BOOTED_COUNT="$(printf '%s\n' "${BOOTED_UDIDS}" | wc -l | tr -d ' ')"
    if [[ "${BOOTED_COUNT}" -gt 1 ]]; then
      echo "==> Multiple simulators are booted; using the first one: ${UDID}"
    else
      echo "==> Using booted simulator: ${UDID}"
    fi
  fi

  echo "==> Installing ${APP_NAME} on simulator ${UDID}..."
  xcrun simctl install "${UDID}" "${SIM_APP_PATH}"

  echo "==> Launching ${APP_NAME} on simulator ${UDID}..."
  xcrun simctl launch "${UDID}" "${BUNDLE_ID}"

  cat <<'EOF'

Next step (manual):
  Settings > Apps > Safari > Extensions > Archive.ph Opener > turn on, then allow for websites
EOF
  exit 0
fi

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
