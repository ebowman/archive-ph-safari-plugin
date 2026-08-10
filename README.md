# Archive.ph Opener

A Safari toolbar extension. Click its icon on any web page and it opens
the current tab's URL at `https://archive.ph/newest/<current-tab-url>` —
the newest archived snapshot of that page, or archive.ph's prompt to save
one if none exists yet. Handy for reading paywalled articles, dead links,
or pages that have since been edited. Only `http:`/`https:` tabs are
handled; other schemes (Safari's start page, `file:`, etc.) are ignored.

The toolbar icon is a toggle. On a normal page it archives, as above
(honoring the "open in a new tab" setting below). On an archive.ph or
mirror snapshot page it does the reverse: it navigates back to the
original article. This works both for long-form snapshot URLs (which
carry the original URL in the archive URL itself) and for bare
short-code links like `archive.is/f0rxt` (aggregator-style links that
don't embed the original) — for the latter, a small content script
reads the original off the snapshot page's own header.

The settings page (Safari Settings → Extensions → Archive.ph Opener →
Preferences) also offers two domain lists for automatic redirecting:
"Always open via archive.ph" for sites you don't pay for (visiting them
auto-archives), and "Always open the original site" for sites you do
pay for (an archive.ph link to one auto-un-archives once the redirect
lands). A domain can only be on one list at a time — adding it to one
removes it from the other — and a manual toolbar click always wins over
the lists for that tab, so toggling by hand is never immediately undone
by the auto-redirect. The first time a snapshot page loads, Safari will
ask once for permission to run the content script on the archive
mirror domains.

## Quick start

Paste this into Terminal:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/ebowman/archive-ph-safari-plugin/main/scripts/bootstrap.sh)"
```

Then enable "Archive.ph Opener" in Safari Settings → Extensions.

What the installer does:

- Checks that `git` and full Xcode are installed.
- Auto-detects an Apple Development signing identity in your
  Keychain and signs the build with it, so the extension stays
  enabled across Safari restarts.
- Clones the repo into a temporary directory, builds it, installs
  the app to `/Applications`, and deletes the temporary clone.
- Re-running the same command later updates to the latest version.

If no signing identity is found, the installer explains the
consequence and asks for confirmation (press Enter) before producing
an **ad-hoc** build, which requires Safari's Develop → Allow Unsigned
Extensions to be re-enabled after every Safari restart. The permanent
fix is free — no paid developer account needed: Xcode → Settings →
Accounts → add your Apple ID → Manage Certificates → "+" → Apple
Development, then re-run the installer. See [Signing](#signing)
below for the full details on signing tiers.

### Manual install

For development, or to pin a specific signing identity via
`.signing.env` (see [Signing](#signing)):

1. Clone this repo.
2. Run `./install.sh` (builds the app and installs it to `/Applications`).
3. Enable "Archive.ph Opener" in Safari Settings → Extensions.

## Requirements

- macOS with full Xcode installed (provides `xcodebuild` and `xcrun`;
  the Command Line Tools alone are not enough)
- Safari

## Signing

Safari only lists extensions that are development-signed, notarized
Developer ID, or App Store. Anything else — including an *unnotarized*
Developer ID build — is treated as unsigned.

| Mode | How | Safari behavior |
| --- | --- | --- |
| Ad-hoc (default) | No Apple account, nothing to configure. | Extension is only listed while Develop → Allow Unsigned Extensions is enabled. **That toggle resets every time Safari restarts.** |
| Apple Development | Requires any Apple Developer account, with the "Apple Development" certificate installed in your keychain. Recommended for personal use. | Trusted automatically on your own Mac — no toggle needed, survives Safari restarts. |
| Developer ID | Requires a Developer ID Application certificate. | Only skips the toggle if the app is **notarized**. These scripts do not automate notarization, so an unnotarized Developer ID build is still treated as unsigned by Safari. |

The [Quick start](#quick-start) one-liner auto-detects an Apple
Development identity in your Keychain and uses it automatically. For
[Manual install](#manual-install), or to pin a specific identity, create
a git-ignored `.signing.env` file at the repo root instead. It's
`source`d by `build.sh`, so it executes as a shell script — keep it
limited to plain variable assignments, nothing else:

```bash
SIGN_IDENTITY="Apple Development"
SIGN_TEAM=YOURTEAMID
```

Find your team ID on the
[developer.apple.com account membership page](https://developer.apple.com/account),
or by running `security find-identity -v -p codesigning`.

## Manual build

Running `./build.sh` alone builds the app without installing it. The
built app ends up at:

```
app/build/Build/Products/Debug/Archive.ph Opener.app
```

You can run it from there and Safari will register the extension, but
leaving copies in both `app/build` and `/Applications` causes Safari to
list the extension twice (see Troubleshooting). Prefer `./install.sh`,
which builds, installs to `/Applications`, and removes the build copy so
only one registration exists.

## Troubleshooting

**Extension doesn't appear in Safari Settings → Extensions.**
Check what signing class the installed app actually has:

```bash
spctl -a -t exec -vv "/Applications/Archive.ph Opener.app"
```

If the result mentions "Unnotarized Developer ID" or the app is ad-hoc
signed, Safari treats it as unsigned: either enable Develop → Allow
Unsigned Extensions, or re-sign with an Apple Development identity (see
Signing above). After changing signing, quit and reopen Safari — the
Extensions list only refreshes on launch.

**Extension appears twice.**
This means two app copies are registered. Check with:

```bash
pluginkit -m -v -i com.yourCompany.Archive-ph-Opener.Extension
```

Fix it by running `./install.sh`, which removes the `app/build` copy and
re-registers only the `/Applications` copy, then restart Safari.

## How it works

- `extension/` contains the WebExtension source: `manifest.json`,
  `background.js`, and `snapshot-probe.js`. `background.js` listens for
  toolbar icon clicks and, for `http:`/`https:` tabs (other schemes,
  like Safari's start page or `file:` URLs, are ignored), either opens
  `https://archive.ph/newest/<tab-url>` (normal page) or navigates back
  to the original article (archive snapshot page) — a single click acts
  as a toggle. It also watches navigation and applies the two settings
  domain lists automatically, without overriding a tab the user has
  just toggled by hand.
- `snapshot-probe.js` is a content script injected into archive.ph/
  mirror pages. On a bare short-code snapshot page, where the tab's URL
  doesn't carry the original article URL, it scrapes the original out
  of the rendered page (its "Redirected from"/"Saved from" fields, or
  falling back to a header link or canonical/og:url meta tag) and
  reports it to `background.js`, so the toggle and the auto-redirect
  lists still work on those pages.
- `app/` is the thin macOS app wrapper generated by
  `xcrun safari-web-extension-converter`, which embeds the extension so
  Safari can load it.
- `build.sh` drives `xcodebuild` against the generated Xcode project to
  produce the `.app`, applying whichever signing configuration is active
  (see Signing above).
- `install.sh` runs `build.sh`, copies the built app into
  `/Applications`, removes the build-directory copy, and unregisters its
  stale LaunchServices entry — so Safari only ever sees one registered
  copy of the extension.

## Manual test checklist

- [ ] Click the icon on an `https://` page → a new tab opens at
      `https://archive.ph/newest/<that-url>`.
- [ ] Click the icon on a non-web tab (e.g. Safari's start page) → nothing
      happens, no error.
- [ ] The archived page loads, or archive.ph offers to save the page if no
      snapshot exists.

## License

MIT — see [LICENSE](LICENSE).
