#!/usr/bin/env bash
#
# Archives, exports, and (by default) uploads the iOS "Archive.ph Opener"
# app to App Store Connect / TestFlight from the command line.
#
# Purpose:
#   Automate the manual Xcode Organizer archive -> distribute -> upload
#   flow, keeping MARKETING_VERSION in sync with extension/manifest.json
#   and generating a monotonically increasing CURRENT_PROJECT_VERSION
#   (UTC timestamp) on every run, without ever touching the checked-in
#   Xcode project (versions are passed on the xcodebuild command line so
#   they apply identically to the app and appex targets).
#
# Prerequisites:
#   - A git-ignored .signing.env at the repo root (sourced below, same
#     pattern as build.sh) defining:
#       SIGN_TEAM=<Apple Developer Team ID>
#       ASC_KEY_ID=<App Store Connect API key ID>
#       ASC_ISSUER_ID=<App Store Connect API issuer UUID>
#     See bead archive-ph-safari-plugin-5xt.8 (App Store Connect
#     prerequisites) for how to obtain these and create the App IDs.
#   - The API private key at
#       $HOME/.private_keys/AuthKey_<ASC_KEY_ID>.p8
#     (override the directory with ASC_KEY_DIR, mainly for testing).
#   - An "Apple Distribution" signing certificate in the login keychain.
#   - Xcode command-line tools (xcodebuild, plutil).
#
# Usage: ./scripts/release-ios.sh [--no-upload] [-h|--help]
#
#   --no-upload   Export the signed .ipa to app/build/ios/export instead
#                 of uploading it to App Store Connect. Useful for
#                 verifying signing/export without burning a TestFlight
#                 build number's worth of upload traffic (the build
#                 number itself is still consumed locally).
#   -h, --help    Print this usage and exit 0.
#
# Output: on success, prints the exported/uploaded build's version and
# (with --no-upload) the path to the resulting .ipa.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/release-ios.sh [--no-upload] [-h|--help]

  --no-upload   Export the .ipa to app/build/ios/export instead of
                uploading to App Store Connect.
  -h, --help    Print this help and exit 0.
EOF
}

UPLOAD_MODE="upload"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-upload)
      UPLOAD_MODE="export"
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

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

# --- Load signing / App Store Connect API credentials --------------------

if [[ -f "${REPO_ROOT}/.signing.env" ]]; then
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/.signing.env"
fi

SIGN_TEAM="${SIGN_TEAM:-}"
ASC_KEY_ID="${ASC_KEY_ID:-}"
ASC_ISSUER_ID="${ASC_ISSUER_ID:-}"
ASC_KEY_DIR="${ASC_KEY_DIR:-$HOME/.private_keys}"

fail_prereq() {
  echo "error: $1" >&2
  echo "See bead archive-ph-safari-plugin-5xt.8 (App Store Connect prerequisites)" >&2
  echo "and set the missing value(s) in .signing.env at the repo root." >&2
  exit 1
}

if [[ -z "${SIGN_TEAM}" ]]; then
  fail_prereq "SIGN_TEAM is empty (Apple Developer Team ID)."
fi

if [[ -z "${ASC_KEY_ID}" ]]; then
  fail_prereq "ASC_KEY_ID is empty (App Store Connect API key ID)."
fi

if [[ -z "${ASC_ISSUER_ID}" ]]; then
  fail_prereq "ASC_ISSUER_ID is empty (App Store Connect API issuer ID)."
fi

AUTH_KEY_PATH="${ASC_KEY_DIR}/AuthKey_${ASC_KEY_ID}.p8"

if [[ ! -f "${AUTH_KEY_PATH}" ]]; then
  fail_prereq "App Store Connect API private key not found at ${AUTH_KEY_PATH}."
fi

# --- Versioning: manifest.json is the single source of truth -------------

MARKETING_VERSION="$(python3 -c '
import json, sys
with open("extension/manifest.json") as f:
    data = json.load(f)
version = data.get("version", "")
if not version:
    sys.exit(1)
print(version)
')" || fail_prereq "extension/manifest.json is missing a non-empty \"version\" field."

CURRENT_PROJECT_VERSION="$(date -u +%Y%m%d%H%M)"

echo "MARKETING_VERSION:      ${MARKETING_VERSION}"
echo "CURRENT_PROJECT_VERSION: ${CURRENT_PROJECT_VERSION}"

# --- Paths -----------------------------------------------------------------

XCODEPROJ="app/Archive.ph Opener/Archive.ph Opener.xcodeproj"
SCHEME="Archive.ph Opener (iOS)"
IOS_BUILD_DIR="${REPO_ROOT}/app/build/ios"
ARCHIVE_PATH="${IOS_BUILD_DIR}/ArchivePhOpener.xcarchive"
EXPORT_OPTIONS_PLIST="${IOS_BUILD_DIR}/ExportOptions.plist"
EXPORT_PATH="${IOS_BUILD_DIR}/export"
ARCHIVE_LOG="${IOS_BUILD_DIR}/xcodebuild-archive.log"
EXPORT_LOG="${IOS_BUILD_DIR}/xcodebuild-export.log"

mkdir -p "${IOS_BUILD_DIR}"

if [[ -e "${ARCHIVE_PATH}" ]]; then
  echo "Removing stale archive: ${ARCHIVE_PATH}"
  rm -rf "${ARCHIVE_PATH}"
fi

AUTH_ARGS=(
  -authenticationKeyPath "${AUTH_KEY_PATH}"
  -authenticationKeyID "${ASC_KEY_ID}"
  -authenticationKeyIssuerID "${ASC_ISSUER_ID}"
)

# --- Provisioning failure hint detection ----------------------------------

print_provisioning_hint() {
  cat <<EOF

Signing/provisioning failure detected. Common fixes:
  - The App Store Connect API key ($ASC_KEY_ID) must have the App Manager
    role (or higher) in App Store Connect > Users and Access.
  - The App IDs (ie.boboco.ArchivePhOpener and
    ie.boboco.ArchivePhOpener.Extension) must already exist in the Apple
    Developer portal -- see the App Store Connect prerequisites bead
    (archive-ph-safari-plugin-5xt.8).
  - An "Apple Distribution" signing certificate must be present in the
    login keychain on this machine.
EOF
}

check_log_for_provisioning_failure() {
  local log_file="$1"
  if grep -qE 'No profiles for|No Account for Team|requires a provisioning profile|No signing certificate "iOS Distribution"' "${log_file}"; then
    return 0
  fi
  return 1
}

# --- Archive ---------------------------------------------------------------

echo "Archiving..."
set -o pipefail
if xcodebuild archive \
    -project "${XCODEPROJ}" \
    -scheme "${SCHEME}" \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "${ARCHIVE_PATH}" \
    CODE_SIGN_STYLE=Automatic \
    DEVELOPMENT_TEAM="${SIGN_TEAM}" \
    MARKETING_VERSION="${MARKETING_VERSION}" \
    CURRENT_PROJECT_VERSION="${CURRENT_PROJECT_VERSION}" \
    -allowProvisioningUpdates \
    "${AUTH_ARGS[@]}" \
    2>&1 | tee "${ARCHIVE_LOG}"; then
  :
else
  ARCHIVE_EXIT=$?
  if check_log_for_provisioning_failure "${ARCHIVE_LOG}"; then
    print_provisioning_hint
  fi
  exit "${ARCHIVE_EXIT}"
fi
set +o pipefail

# --- Export options plist (runtime-generated; never checked in) ----------

if [[ "${UPLOAD_MODE}" == "upload" ]]; then
  EXPORT_DESTINATION="upload"
else
  EXPORT_DESTINATION="export"
fi

plutil -create xml1 "${EXPORT_OPTIONS_PLIST}"
plutil -replace method -string "app-store-connect" "${EXPORT_OPTIONS_PLIST}"
plutil -replace destination -string "${EXPORT_DESTINATION}" "${EXPORT_OPTIONS_PLIST}"
plutil -replace teamID -string "${SIGN_TEAM}" "${EXPORT_OPTIONS_PLIST}"
plutil -replace signingStyle -string "automatic" "${EXPORT_OPTIONS_PLIST}"
plutil -replace uploadSymbols -bool true "${EXPORT_OPTIONS_PLIST}"
plutil -replace manageAppVersionAndBuildNumber -bool false "${EXPORT_OPTIONS_PLIST}"

# --- Export / upload ---------------------------------------------------

echo "Exporting (destination: ${EXPORT_DESTINATION})..."
set -o pipefail
if xcodebuild -exportArchive \
    -archivePath "${ARCHIVE_PATH}" \
    -exportOptionsPlist "${EXPORT_OPTIONS_PLIST}" \
    -exportPath "${EXPORT_PATH}" \
    -allowProvisioningUpdates \
    "${AUTH_ARGS[@]}" \
    2>&1 | tee "${EXPORT_LOG}"; then
  :
else
  EXPORT_EXIT=$?
  if check_log_for_provisioning_failure "${EXPORT_LOG}"; then
    print_provisioning_hint
  fi
  exit "${EXPORT_EXIT}"
fi
set +o pipefail

# --- Success ---------------------------------------------------------------

if [[ "${UPLOAD_MODE}" == "upload" ]]; then
  echo "Uploaded build ${CURRENT_PROJECT_VERSION} (${MARKETING_VERSION}) -- processing takes a few minutes; watch App Store Connect > TestFlight"
  echo "The internal group with automatic distribution will push it to the TestFlight app."
else
  IPA_PATH="$(find "${EXPORT_PATH}" -maxdepth 1 -name "*.ipa" -print -quit)"
  echo "Exported build ${CURRENT_PROJECT_VERSION} (${MARKETING_VERSION})"
  if [[ -n "${IPA_PATH}" ]]; then
    echo "IPA: ${IPA_PATH}"
  else
    echo "warning: export succeeded but no .ipa was found under ${EXPORT_PATH}" >&2
  fi
fi
