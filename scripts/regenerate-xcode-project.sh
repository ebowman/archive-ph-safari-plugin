#!/usr/bin/env bash
#
# Regenerates app/Archive.ph Opener from scratch by re-running
# `xcrun safari-web-extension-converter` against extension/ and re-applying
# the hand fixes this repo depends on:
#
#   1. Rewriting the absolute-ish PBXFileReference paths the converter
#      emits (e.g. ../../../../../../../../../Users/you/.../extension/x)
#      down to the relative ../../../extension/x paths this repo commits,
#      so the project is portable across machines/checkouts.
#   2. Preserving the nine hand-curated mac-icon-*.png files (and the
#      universal-icon-1024@1x.png iOS icon, once a later bead adds it) in
#      Shared (App)/Assets.xcassets/AppIcon.appiconset/. The fresh
#      converter output ships its OWN, byte-different icon set at that
#      same path -- that is exactly why this script must overwrite them
#      with the curated ones on every run, not skip the copy because the
#      destination already "has" icons.
#      1024x1024 universal iOS icon note: if archive-ph-safari-plugin-5xt.2
#      has not landed yet, the curated source won't have
#      universal-icon-1024@1x.png either, and it is fine for it to stay
#      missing here.
#   3. Setting ITSAppUsesNonExemptEncryption=NO in the iOS app's
#      Info.plist so TestFlight/App Store Connect skips the per-build
#      export-compliance question (the extension only speaks HTTPS,
#      which is exempt).
#
# This is the ONLY sanctioned way to regenerate app/Archive.ph Opener.
# Do not hand-edit the generated project or re-run the converter directly
# against app/ -- if the converter's output format changes in a future
# Xcode release (different directory names, etc.), this script is meant
# to fail loudly rather than silently ship a half-fixed project.
#
# Idempotency caveat: running this script twice in a row on a clean tree
# is idempotent EXCEPT for two kinds of expected, acceptable churn:
#   - Xcode's own "Created by ... on <date>." header comments in generated
#     Swift files, which embed the current date/time.
#   - The converter assigns fresh, time-based object IDs to every
#     PBXFileReference/PBXBuildFile/etc. entry on each run, so
#     project.pbxproj will show several hundred lines of ID churn even
#     when nothing meaningful changed. This is inherent to the converter,
#     not a bug in this script. When checking this script's output for
#     drift, diff the PBXFileReference `path`/`name` values and build
#     settings (e.g. PRODUCT_BUNDLE_IDENTIFIER), not the object IDs
#     themselves.
#
# Usage: ./scripts/regenerate-xcode-project.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

APP_NAME="Archive.ph Opener"
BUNDLE_ID="ie.boboco.ArchivePhOpener"
APP_DIR="${REPO_ROOT}/app/${APP_NAME}"

# --- Guard: refuse to run against a dirty app/ tree ------------------------

if [[ -n "$(git status --porcelain -- app/ 2>/dev/null)" ]]; then
  echo "error: app/ has uncommitted changes; refusing to regenerate." >&2
  echo "Commit or discard changes under app/ first, then re-run this script." >&2
  exit 1
fi

# --- Run the converter into a scratch directory (never directly into app/) -

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "==> Running safari-web-extension-converter into ${WORK_DIR}"
xcrun safari-web-extension-converter "${REPO_ROOT}/extension" \
  --project-location "${WORK_DIR}" \
  --app-name "${APP_NAME}" \
  --bundle-identifier "${BUNDLE_ID}" \
  --swift \
  --no-open \
  --no-prompt \
  --force

NEW_APP_DIR="${WORK_DIR}/${APP_NAME}"

if [[ ! -d "${NEW_APP_DIR}/Shared (App)" ]]; then
  echo "error: expected '${NEW_APP_DIR}/Shared (App)' not found." >&2
  echo "The converter's output format may have changed; refusing to" >&2
  echo "proceed with a half-fixed project. Inspect ${NEW_APP_DIR} by hand." >&2
  exit 1
fi

PBXPROJ="${NEW_APP_DIR}/${APP_NAME}.xcodeproj/project.pbxproj"

if [[ ! -f "${PBXPROJ}" ]]; then
  echo "error: expected pbxproj not found at ${PBXPROJ}" >&2
  exit 1
fi

# --- Rewrite absolute-ish extension/ paths down to ../../../extension/... --

echo "==> Rewriting extension/ paths in project.pbxproj"
python3 - "${PBXPROJ}" <<'PYEOF'
import re
import sys

path = sys.argv[1]
with open(path) as f:
    content = f.read()

# Matches `path = <value>;` where <value> (quoted or bare) contains
# "/extension/" anywhere -- this covers both the converter's freshly
# generated absolute-ish paths and (idempotently) already-fixed relative
# paths from a prior run.
pattern = re.compile(r'path = "?([^";\n]*?/extension/[^";\n]*?)"?;')

def fix(match):
    value = match.group(1)
    idx = value.find('/extension/')
    rest = value[idx + len('/extension/'):]
    new_value = '../../../extension/' + rest
    # Match the converter's own quoting convention: quote the value only
    # when it contains characters outside [A-Za-z0-9_./] (e.g. a hyphen).
    if re.search(r'[^A-Za-z0-9_./]', new_value):
        return 'path = "%s";' % new_value
    return 'path = %s;' % new_value

new_content, count = pattern.subn(fix, content)
if count == 0:
    print("warning: no extension/ path references found to rewrite", file=sys.stderr)
else:
    print("rewrote %d extension/ path reference(s)" % count)

with open(path, 'w') as f:
    f.write(new_content)
PYEOF

# Fail loudly if any absolute path or the placeholder bundle id survived.
if grep -q '/Users/' "${PBXPROJ}"; then
  echo "error: project.pbxproj still contains an absolute /Users/ path after rewrite" >&2
  exit 1
fi
if grep -q 'yourCompany' "${PBXPROJ}"; then
  echo "error: project.pbxproj still contains the placeholder 'yourCompany' bundle id" >&2
  exit 1
fi

# --- Preserve the hand-curated mac icons ------------------------------------

# Resolve the source appiconset: prefer the current multiplatform layout
# (Shared (App)/...), falling back to the legacy macOS-only layout for a
# one-time migration off an unregenerated checkout. Either way, this is
# the CURATED set that must survive regeneration -- the converter's own
# freshly emitted icons at the destination path are not curated and must
# be overwritten.
SHARED_APPICONSET="${APP_DIR}/Shared (App)/Assets.xcassets/AppIcon.appiconset"
LEGACY_APPICONSET="${APP_DIR}/Archive.ph Opener/Assets.xcassets/AppIcon.appiconset"
NEW_APPICONSET="${NEW_APP_DIR}/Shared (App)/Assets.xcassets/AppIcon.appiconset"

if [[ -d "${SHARED_APPICONSET}" ]]; then
  OLD_APPICONSET="${SHARED_APPICONSET}"
elif [[ -d "${LEGACY_APPICONSET}" ]]; then
  OLD_APPICONSET="${LEGACY_APPICONSET}"
else
  echo "error: no curated appiconset found at either:" >&2
  echo "  ${SHARED_APPICONSET}" >&2
  echo "  ${LEGACY_APPICONSET}" >&2
  echo "Cannot preserve hand-curated icons; refusing to regenerate." >&2
  exit 1
fi

echo "==> Copying curated icons from ${OLD_APPICONSET}"
shopt -s nullglob
icon_files=("${OLD_APPICONSET}"/mac-icon-*.png)
shopt -u nullglob
if [[ "${#icon_files[@]}" -eq 0 ]]; then
  echo "error: no mac-icon-*.png files found under ${OLD_APPICONSET}" >&2
  exit 1
fi
cp -f "${icon_files[@]}" "${NEW_APPICONSET}/"

# The 1024x1024 universal iOS icon is added by a later bead
# (archive-ph-safari-plugin-5xt.2); once present in the curated source, it
# must survive regeneration too, but it is fine for it to be absent until
# then.
if [[ -f "${OLD_APPICONSET}/universal-icon-1024@1x.png" ]]; then
  cp -f "${OLD_APPICONSET}/universal-icon-1024@1x.png" "${NEW_APPICONSET}/"
fi

# --- iOS Info.plist: ITSAppUsesNonExemptEncryption = NO ---------------------

IOS_INFO_PLIST="${NEW_APP_DIR}/iOS (App)/Info.plist"

if [[ ! -f "${IOS_INFO_PLIST}" ]]; then
  echo "error: expected iOS Info.plist not found at ${IOS_INFO_PLIST}" >&2
  exit 1
fi

echo "==> Setting ITSAppUsesNonExemptEncryption=NO in iOS Info.plist"
plutil -replace ITSAppUsesNonExemptEncryption -bool NO "${IOS_INFO_PLIST}"

# --- Swap the generated project into place ----------------------------------

echo "==> Replacing ${APP_DIR}"
rm -rf "${APP_DIR}"
mv "${NEW_APP_DIR}" "${APP_DIR}"

# --- Summary -----------------------------------------------------------------

XCODEPROJ="${APP_DIR}/${APP_NAME}.xcodeproj"
FINAL_PBXPROJ="${XCODEPROJ}/project.pbxproj"

echo "==> Schemes:"
xcodebuild -list -project "${XCODEPROJ}"

echo "==> grep -c '/Users/' project.pbxproj (expect 0):"
grep -c '/Users/' "${FINAL_PBXPROJ}" || true

echo "==> grep -c yourCompany project.pbxproj (expect 0):"
grep -c 'yourCompany' "${FINAL_PBXPROJ}" || true

echo "==> Done. app/Archive.ph Opener regenerated at ${APP_DIR}"
