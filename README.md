# Archive.ph Opener

A personal-use, unsigned Safari extension. Click the toolbar icon on any
`http://` or `https://` page and the extension opens a new tab at
`https://archive.ph/newest/<current-tab-url>`, which redirects to the newest
archived snapshot of that page, or offers to archive it if no snapshot
exists yet. Pages with other schemes (Safari's start page, `file:`, etc.)
are ignored.

## Build

Requires Xcode (the project builds the Xcode wrapper generated under `app/`
by `xcrun safari-web-extension-converter`).

```bash
./build.sh
```

On success this prints the absolute path of the built `.app`, currently:

```
app/build/Build/Products/Debug/Archive.ph Opener.app
```

## Install / enable for personal use

Since this extension is unsigned, Safari requires a few one-time (and
per-session) steps to allow it to run:

1. Build the app: `./build.sh`
2. Open the built app once so macOS registers the extension with Safari:
   ```bash
   open "app/build/Build/Products/Debug/Archive.ph Opener.app"
   ```
3. In Safari, enable the Develop menu if it isn't already visible: Safari
   Settings → Advanced → check "Show features for web developers".
4. Develop menu → "Allow Unsigned Extensions". Note: this setting resets
   every time Safari restarts, so you'll need to re-enable it each session.
5. Safari Settings → Extensions → enable "Archive.ph Opener", and grant it
   access to websites when prompted.

## Usage

Click the toolbar icon while viewing any `http://` or `https://` page. A
new tab opens showing the archived version of that page (or archive.ph's
prompt to create one if none exists yet). Clicking the icon on non-web
pages (Safari's start page, `file:` URLs, etc.) does nothing, by design.

## Manual test checklist

- [ ] Click the icon on an `https://` page → a new tab opens at
      `https://archive.ph/newest/<that-url>`.
- [ ] Click the icon on a non-web tab (e.g. Safari's start page) → nothing
      happens, no error.
- [ ] The archived page loads, or archive.ph offers to save the page if no
      snapshot exists.
