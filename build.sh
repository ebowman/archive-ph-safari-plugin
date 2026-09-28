#!/usr/bin/env bash
#
# Builds the "Archive.ph Opener" Safari app wrapper from the Xcode project
# generated under app/ by `xcrun safari-web-extension-converter`.
#
# Usage: ./build.sh [--platform macos|ios-simulator] [--ios-simulator] [-h|--help]
#
#   --platform macos          Build the macOS scheme "Archive.ph Opener (macOS)".
#                              This is the default when no flag is given. Uses
#                              the same signing logic as before (ad-hoc unless
#                              SIGN_IDENTITY/SIGN_TEAM or .signing.env is set).
#   --platform ios-simulator  Build the iOS scheme "Archive.ph Opener (iOS)"
#                              for the iOS Simulator (-sdk iphonesimulator,
#                              -destination 'generic/platform=iOS Simulator').
#                              Always ad-hoc signed (CODE_SIGN_IDENTITY=-);
#                              .signing.env is ignored for this mode.
#   --ios-simulator            Shorthand for --platform ios-simulator.
#   -h, --help                 Print this usage and exit 0.
#
# Output: prints the absolute path of the built .app on success.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./build.sh [--platform macos|ios-simulator] [--ios-simulator] [-h|--help]

  --platform macos          Build the macOS app (default).
  --platform ios-simulator  Build the iOS app for the iOS Simulator.
  --ios-simulator            Shorthand for --platform ios-simulator.
  -h, --help                 Print this help and exit 0.
EOF
}

PLATFORM="macos"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      if [[ $# -lt 2 ]]; then
        echo "error: --platform requires an argument (macos|ios-simulator)" >&2
        usage >&2
        exit 2
      fi
      PLATFORM="$2"
      shift 2
      ;;
    --platform=*)
      PLATFORM="${1#*=}"
      shift
      ;;
    --ios-simulator)
      PLATFORM="ios-simulator"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "${PLATFORM}" in
  macos|ios-simulator) ;;
  *)
    echo "error: unknown --platform value: ${PLATFORM} (expected macos or ios-simulator)" >&2
    usage >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DERIVED_DATA_PATH="${REPO_ROOT}/app/build"
CONFIGURATION="Debug"

# Locate the generated .xcodeproj under app/ (avoid hardcoding its path,
# since the converter names the project directory after --app-name).
XCODEPROJ="$(find "${REPO_ROOT}/app" -maxdepth 2 -name "*.xcodeproj" -print -quit)"

if [[ -z "${XCODEPROJ}" ]]; then
  echo "error: no .xcodeproj found under ${REPO_ROOT}/app" >&2
  echo "Run: ./scripts/regenerate-xcode-project.sh" >&2
  exit 1
fi

PROJECT_DIR="$(dirname "${XCODEPROJ}")"

if [[ "${PLATFORM}" == "macos" ]]; then
  SCHEME="Archive.ph Opener (macOS)"
else
  SCHEME="Archive.ph Opener (iOS)"
fi

# Verify the expected scheme exists rather than assuming it.
AVAILABLE_SCHEMES="$(xcodebuild -list -project "${XCODEPROJ}" 2>/dev/null \
  | awk '/Schemes:/{found=1; next} found && NF{print}' \
  | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

if ! printf '%s\n' "${AVAILABLE_SCHEMES}" | grep -qxF "${SCHEME}"; then
  echo "error: scheme \"${SCHEME}\" not found in ${XCODEPROJ}" >&2
  echo "Available schemes:" >&2
  printf '%s\n' "${AVAILABLE_SCHEMES}" | sed 's/^/  /' >&2
  echo "Run: ./scripts/regenerate-xcode-project.sh" >&2
  exit 1
fi

echo "Project:  ${XCODEPROJ}"
echo "Scheme:   ${SCHEME}"
echo "Platform: ${PLATFORM}"
echo "Config:   ${CONFIGURATION}"

if [[ "${PLATFORM}" == "macos" ]]; then
  # Optional local override for codesigning identity/team. Git-ignored; see
  # the signing comment below for details.
  if [[ -f "${REPO_ROOT}/.signing.env" ]]; then
    # shellcheck disable=SC1091
    source "${REPO_ROOT}/.signing.env"
  fi

  SIGN_IDENTITY="${SIGN_IDENTITY:--}"
  SIGN_TEAM="${SIGN_TEAM:-}"

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
  # Identity signing: set SIGN_IDENTITY and SIGN_TEAM in the environment, or
  # create a git-ignored "${REPO_ROOT}/.signing.env" file (sourced above)
  # containing:
  #   SIGN_IDENTITY="Apple Development"
  #   SIGN_TEAM=YOURTEAMID
  # Safari only skips the "Allow Unsigned Extensions" toggle for extensions
  # that are development-signed (Apple Development identity, on your own
  # Mac) or notarized Developer ID. This script does not automate
  # notarization, so an unnotarized Developer ID build is still treated as
  # unsigned by Safari, same as ad-hoc.
  SIGNING_ARGS=()
  if [[ -n "${SIGN_TEAM}" ]]; then
    SIGNING_ARGS=(
      CODE_SIGN_STYLE=Manual
      CODE_SIGN_IDENTITY="${SIGN_IDENTITY}"
      DEVELOPMENT_TEAM="${SIGN_TEAM}"
    )
    echo "Signing: identity \"${SIGN_IDENTITY}\" (team ${SIGN_TEAM})"
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

  PRODUCTS_DIR="${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}"
else
  # iOS Simulator builds always ad-hoc sign, regardless of .signing.env: the
  # simulator has no code-signing enforcement worth honoring a real identity
  # for, and using one would pull in provisioning-profile requirements that
  # don't apply here.
  echo "Signing: ad-hoc (ios-simulator mode always ad-hoc signs; .signing.env is ignored)"

  xcodebuild -project "${XCODEPROJ}" -scheme "${SCHEME}" \
    -configuration "${CONFIGURATION}" \
    -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "${DERIVED_DATA_PATH}" \
    CODE_SIGN_IDENTITY=- \
    build

  PRODUCTS_DIR="${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}-iphonesimulator"
fi

APP_PATH="$(find "${PRODUCTS_DIR}" -maxdepth 1 -name "*.app" -print -quit)"

if [[ -z "${APP_PATH}" || ! -d "${APP_PATH}" ]]; then
  echo "error: build succeeded but no .app was found under ${PRODUCTS_DIR}" >&2
  exit 1
fi

echo "Built app: ${APP_PATH}"
