#!/usr/bin/env node
// Zero-dependency fixture test for extension/background.js. Loads
// archive-url.js then background.js into a single vm context (mirroring how
// Safari loads them as sequential <script> tags), backed by a mock `chrome`
// global, and drives the captured action.onClicked / contextMenus.onClicked
// / tabs.onRemoved listeners to assert toggle, override-registry, and
// context-menu behavior without touching a real browser.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ARCHIVE_URL_PATH = path.join(__dirname, "..", "extension", "archive-url.js");
const BACKGROUND_PATH = path.join(__dirname, "..", "extension", "background.js");

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.log(`FAIL: ${name}`);
    console.log(`  expected: ${JSON.stringify(expected)}`);
    console.log(`  actual:   ${JSON.stringify(actual)}`);
  }
}

function assertTrue(name, condition) {
  check(name, Boolean(condition), true);
}

// --- mock chrome/browser global ------------------------------------------

// Builds a fresh mock `chrome` global for a single test case. newTabSetting
// controls what storage.local.get("newTab") resolves to (undefined by
// default, matching "unset" -> defaults to false, i.e. reuse the current
// tab, per shouldUseNewTab).
// alwaysArchiveDomains / alwaysOriginalDomains seed the auto-redirect
// engine's domain lists (bead 6kl.4); storageGetShouldReject, when true,
// makes every storage.local.get call reject (asserting the engine's
// read-failure-is-empty-list contract in case (h)).
function makeMockChrome({
  newTabSetting,
  alwaysArchiveDomains,
  alwaysOriginalDomains,
  storageGetShouldReject,
} = {}) {
  let nextTabId = 100;

  const calls = {
    tabsUpdate: [], // { tabId, url }
    tabsCreate: [], // { url }
  };

  let onClickedListener = null;
  let onRemovedListener = null;
  let menuOnClickedListener = null;
  let onUpdatedListener = null;
  let onMessageListener = null;
  let createdMenu = null;

  const chromeMock = {
    action: {
      onClicked: {
        addListener(fn) {
          onClickedListener = fn;
        },
      },
    },
    tabs: {
      update(tabId, updateInfo) {
        calls.tabsUpdate.push({ tabId, url: updateInfo.url });
      },
      create(createInfo) {
        const id = nextTabId++;
        calls.tabsCreate.push({ url: createInfo.url, id });
        return Promise.resolve({ id });
      },
      onRemoved: {
        addListener(fn) {
          onRemovedListener = fn;
        },
      },
      onUpdated: {
        addListener(fn) {
          onUpdatedListener = fn;
        },
      },
    },
    storage: {
      local: {
        get(key) {
          if (storageGetShouldReject) {
            return Promise.reject(new Error("storage unavailable"));
          }
          if (key === "newTab") {
            return Promise.resolve(
              newTabSetting === undefined ? {} : { newTab: newTabSetting }
            );
          }
          if (key === "alwaysArchiveDomains") {
            return Promise.resolve({
              alwaysArchiveDomains: alwaysArchiveDomains || [],
            });
          }
          if (key === "alwaysOriginalDomains") {
            return Promise.resolve({
              alwaysOriginalDomains: alwaysOriginalDomains || [],
            });
          }
          return Promise.resolve({});
        },
      },
    },
    contextMenus: {
      create(opts, cb) {
        createdMenu = opts;
        if (cb) cb();
      },
      onClicked: {
        addListener(fn) {
          menuOnClickedListener = fn;
        },
      },
    },
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener(fn) {
          onMessageListener = fn;
        },
      },
    },
  };

  return {
    chromeMock,
    calls,
    getOnClickedListener: () => onClickedListener,
    getOnRemovedListener: () => onRemovedListener,
    getMenuOnClickedListener: () => menuOnClickedListener,
    getOnUpdatedListener: () => onUpdatedListener,
    getOnMessageListener: () => onMessageListener,
    getCreatedMenu: () => createdMenu,
  };
}

// Simulates a runtime.onMessage dispatch from a content script running in
// tabId, awaiting the listener's returned promise (background.js's listener
// returns the result of handleSnapshotOriginalMessage(...).catch(...), so
// this mirrors how a real message dispatch would be awaited) then flushing
// remaining microtasks so any chained storage.local reads settle.
// senderTabUrl is optional (sender.tab.url is absent in some real Safari
// contexts); when provided it's attached to the sender so tests can drive
// the sender.tab.url mirror-host guard in handleSnapshotOriginalMessage.
async function dispatchMessage(h, message, tabId, senderTabUrl) {
  const listener = h.getOnMessageListener();
  const sender = { tab: { id: tabId } };
  if (senderTabUrl !== undefined) sender.tab.url = senderTabUrl;
  await listener(message, sender);
  await flush();
}

// Loads archive-url.js then background.js into one fresh vm context wired
// to the given mock chrome global. Returns the harness handles plus the
// sandbox (for globalThis inspection, unused today but handy for debugging).
function loadBackground({
  newTabSetting,
  alwaysArchiveDomains,
  alwaysOriginalDomains,
  storageGetShouldReject,
} = {}) {
  const harness = makeMockChrome({
    newTabSetting,
    alwaysArchiveDomains,
    alwaysOriginalDomains,
    storageGetShouldReject,
  });

  const sandbox = {
    chrome: harness.chromeMock,
    console,
    // fetch stub: resolves immediately so pickMirror() picks archive.ph
    // (the first mirror) without any real network access. AbortSignal is
    // node-ambient (available since Node 15+), so no stub needed for it.
    fetch: () => Promise.resolve({ ok: true }),
    AbortSignal,
    URL,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // Loaded RAW (no wrapping) into one shared vm context, exactly like
  // Safari's background page: manifest.json's background.scripts lists
  // archive-url.js then background.js as sequential <script> tags, and
  // Safari's MV3 background page runs them in ONE shared top-level lexical
  // scope (unlike vm.runInContext calls, which would otherwise each get
  // their own scope if wrapped -- that wrapping previously masked a
  // duplicate-top-level-declaration collision; see bead 9k9). archive-url.js
  // is now itself IIFE-wrapped internally (only globalThis.ArchiveUrl
  // escapes it), so it and background.js can safely share this scope.
  const archiveUrlSource = fs.readFileSync(ARCHIVE_URL_PATH, "utf8");
  vm.runInContext(archiveUrlSource, sandbox, {
    filename: ARCHIVE_URL_PATH,
  });

  const backgroundSource = fs.readFileSync(BACKGROUND_PATH, "utf8");
  vm.runInContext(backgroundSource, sandbox, {
    filename: BACKGROUND_PATH,
  });

  return { ...harness, sandbox };
}

// Waits for pending microtasks (promise chains inside the listener) to
// settle before assertions run, since onClicked handlers are fire-and-forget
// async functions.
async function flush() {
  // A handful of microtask turns is enough to drain the async chains used
  // in background.js (pickMirror -> shouldUseNewTab -> tabs.create/update).
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// --- (0) shared-scope load: archive-url.js then background.js RAW into one
//     fresh vm context must not throw ---------------------------------------
//
// Guards against exactly the bead 9k9 regression: Safari's background page
// loads manifest.json's background.scripts (archive-url.js, background.js)
// as sequential <script> tags sharing ONE top-level lexical scope. If either
// file (or a future edit to either) reintroduces a top-level const/let/
// function/class name that also exists top-level in the other, this raw
// load throws "SyntaxError: Can't create duplicate variable" and the whole
// background page dies. loadBackground() above already loads both files raw
// (no per-file IIFE wrapping) for every case in this suite, so any such
// collision would surface here as a thrown exception during
// vm.runInContext, not just in this dedicated case -- this case exists to
// name the invariant explicitly and fail with a clear message if the raw
// load ever throws.
function testSharedScopeLoadDoesNotThrow() {
  let threw = null;
  try {
    loadBackground({});
  } catch (e) {
    threw = e;
  }
  check(
    "(0) archive-url.js + background.js load raw into one shared scope without throwing",
    threw === null,
    true
  );
  if (threw) {
    console.log(`  threw: ${threw.stack || threw}`);
  }
}

// --- (a) normal page + newTab default (unset) -> tabs.update on the same
//     tab with archive.ph ---------------------------------------------------

async function testNormalPageDefaultNewTab() {
  const h = loadBackground({});
  const listener = h.getOnClickedListener();
  listener({ id: 1, url: "https://example.com/article" });
  await flush();

  check("(a) tabs.create not called", h.calls.tabsCreate.length, 0);
  check("(a) tabs.update called once", h.calls.tabsUpdate.length, 1);
  check("(a) tabs.update targets the clicked tab", h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].tabId, 1);
  check(
    "(a) tabs.update url is archive.ph/newest/<url>",
    h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].url,
    "https://archive.ph/newest/https://example.com/article"
  );
}

// --- (a2) storage.get("newTab") explicitly resolves {} (key absent) ->
//     toolbar archive still uses tabs.update on the clicked tab -----------
//
// Distinct from case (a) above: (a) exercises the harness's default
// newTabSetting (undefined), which the mock also serializes as storage.get
// resolving {}; this case names that "key absent from storage" contract
// explicitly so a future harness refactor that changes the undefined
// default's resolution shape can't silently stop covering it.

async function testStorageGetReturnsEmptyObjectDefaultsToSameTab() {
  const h = loadBackground({ newTabSetting: undefined });
  const listener = h.getOnClickedListener();
  listener({ id: 50, url: "https://example.com/absent-key" });
  await flush();

  check("(a2) tabs.create not called", h.calls.tabsCreate.length, 0);
  check("(a2) tabs.update called once", h.calls.tabsUpdate.length, 1);
  check("(a2) tabs.update targets the clicked tab", h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].tabId, 50);
  check(
    "(a2) tabs.update url is archive.ph/newest/<url>",
    h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].url,
    "https://archive.ph/newest/https://example.com/absent-key"
  );
}

// --- (b) archive URL + newTab=false -> tabs.update on same tab -----------

async function testDeArchiveSameTab() {
  const h = loadBackground({ newTabSetting: false });
  const listener = h.getOnClickedListener();
  listener({ id: 42, url: "https://archive.ph/AbC12/https://example.com/x" });
  await flush();

  check("(b) tabs.create not called", h.calls.tabsCreate.length, 0);
  check("(b) tabs.update called once", h.calls.tabsUpdate.length, 1);
  check("(b) tabs.update targets same tab", h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].tabId, 42);
  check(
    "(b) tabs.update url is the original",
    h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].url,
    "https://example.com/x"
  );

  return h;
}

// --- (c) same with newTab=true -> tabs.create with the original ----------

async function testDeArchiveNewTab() {
  const h = loadBackground({ newTabSetting: true });
  const listener = h.getOnClickedListener();
  listener({ id: 7, url: "https://archive.ph/AbC12/https://example.com/x" });
  await flush();

  check("(c) tabs.update not called", h.calls.tabsUpdate.length, 0);
  check("(c) tabs.create called once", h.calls.tabsCreate.length, 1);
  check(
    "(c) tabs.create url is the original",
    h.calls.tabsCreate[0] && h.calls.tabsCreate[0].url,
    "https://example.com/x"
  );
}

// --- (d) bare short-code archive URL -> no tabs call ----------------------

async function testBareShortCodeNoOp() {
  const h = loadBackground({});
  const listener = h.getOnClickedListener();
  listener({ id: 5, url: "https://archive.ph/AbC12" });
  await flush();

  check("(d) tabs.update not called", h.calls.tabsUpdate.length, 0);
  check("(d) tabs.create not called", h.calls.tabsCreate.length, 0);
}

// --- (e) toggle round-trip: archive then de-archive back -----------------

async function testToggleRoundTrip() {
  const h = loadBackground({ newTabSetting: false });
  const listener = h.getOnClickedListener();

  listener({ id: 9, url: "https://example.com/roundtrip" });
  await flush();
  check("(e) first click archives via tabs.update", h.calls.tabsUpdate.length, 1);
  const archiveUrl = h.calls.tabsUpdate[0].url;
  check(
    "(e) archived url looks right",
    archiveUrl,
    "https://archive.ph/newest/https://example.com/roundtrip"
  );

  // Simulate clicking again while viewing the resulting archive URL.
  listener({ id: 9, url: archiveUrl });
  await flush();

  check("(e) second click de-archives via tabs.update", h.calls.tabsUpdate.length, 2);
  check(
    "(e) second click returns to original url",
    h.calls.tabsUpdate[1] && h.calls.tabsUpdate[1].url,
    "https://example.com/roundtrip"
  );
  check("(e) no tabs.create used in same-tab round trip", h.calls.tabsCreate.length, 0);
}

// --- (f) override registry: hasManualOverride reflects (b)'s recording ---
//
// Nothing in this bead consumes the registry yet (6kl.4 will), so we assert
// its storage contract directly via the two functions background.js
// attaches to globalThis for exactly this purpose (see the comment above
// `globalThis.recordManualOverride = ...` in background.js).
async function testOverrideRegistry() {
  const h = loadBackground({ newTabSetting: false });
  const listener = h.getOnClickedListener();

  listener({ id: 42, url: "https://archive.ph/AbC12/https://example.com/x" });
  await flush();

  const { sandbox } = h;
  assertTrue(
    "(f) hasManualOverride true for same domain, different path",
    sandbox.hasManualOverride(42, "https://example.com/other")
  );
  check(
    "(f) hasManualOverride false for unrelated domain",
    sandbox.hasManualOverride(42, "https://other.com/other"),
    false
  );
  check(
    "(f) hasManualOverride false for unknown tab",
    sandbox.hasManualOverride(999, "https://example.com/other"),
    false
  );
}

// --- (g) tabs.onRemoved clears the entry ----------------------------------

async function testOnRemovedClearsEntry() {
  const h = loadBackground({ newTabSetting: false });
  const listener = h.getOnClickedListener();

  listener({ id: 42, url: "https://archive.ph/AbC12/https://example.com/x" });
  await flush();

  const { sandbox } = h;
  assertTrue(
    "(g) override present before removal",
    sandbox.hasManualOverride(42, "https://example.com/other")
  );

  const onRemoved = h.getOnRemovedListener();
  onRemoved(42);

  check(
    "(g) override cleared after tabs.onRemoved",
    sandbox.hasManualOverride(42, "https://example.com/other"),
    false
  );
}

// --- (g2) tabs.onRemoved also clears the engine-marker registry ----------
//
// DEVIATION NOTE (6kl.4 second fix pass, item 3): the STOPPED note's
// suggested construction -- "trigger rule (b), replay that exact archive-URL
// marker on a reused tab id, expect a rule to fire because the marker was
// cleared" -- is structurally IMPOSSIBLE for any list configuration, proven
// below, so it is not what this case does. Rule (b) only fires when
// matchesAnyDomain(url, alwaysArchiveDomains) is true for the pre-archive
// url, and its marker is exactly buildArchiveUrl(mirror0, url), whose
// extracted original is that same url. Replaying the marker sends it through
// rule (a)'s isArchiveUrl branch, which requires
// matchesAnyDomain(original, alwaysOriginalDomains) true AND
// matchesAnyDomain(original, alwaysArchiveDomains) false to fire -- but
// rule (b) having fired already forces the second condition to be true
// (original === url, and url matched alwaysArchiveDomains), so rule (a) can
// never both match alwaysOriginalDomains and pass its own corrupted-storage
// guard on a rule (b)-produced marker. The symmetric attempt (set the marker
// via rule (a), replay it expecting rule (b) to fire) is contradictory for
// the identical reason in the other direction. This is not a bug -- it's the
// same list mutual-exclusivity invariant (l) documents, just reached from a
// different starting rule.
//
// What IS achievable, and is what this case now does: use the NESTED
// archive-of-archive construction from case (m), where the marker set by
// rule (a)'s first hop is independently load-bearing (m proved this with
// the tab kept alive). Here we additionally remove the tab between the
// first hop and the replay: fire the nested URL on tab 60 (rule (a) peels
// one layer, marker set to the once-unwrapped URL), remove tab 60 (must
// clear engineMarkers[60]), then fire onUpdated with that EXACT marker url
// on the reused tab id 60. If onRemoved had NOT cleared the marker, this
// replay would be silently consumed (marker match) and the total would stay
// at 1. Because removal must clear it, the url is evaluated fresh: it is
// still an archive url, so rule (a) peels the SECOND layer and fires again,
// making the total 2. This pins engineMarkers.delete in onRemoved as
// independently observable -- mutation-verified in the report (removing
// engineMarkers.delete from onRemoved's listener makes this case fail, total
// stays at 1 instead of reaching 2).

async function testOnRemovedClearsEngineMarker() {
  const h = loadBackground({
    alwaysOriginalDomains: ["example.com", "archive.ph"],
    alwaysArchiveDomains: [],
  });
  const onUpdated = h.getOnUpdatedListener();
  const onRemoved = h.getOnRemovedListener();

  const nestedUrl =
    "https://archive.ph/newest/https://archive.ph/newest/https://example.com/a";
  onUpdated(60, { url: nestedUrl }, { id: 60, url: nestedUrl });
  await flush();
  check("(g2) rule (a) de-archives one layer, marker set", h.calls.tabsUpdate.length, 1);
  const markerUrl = h.calls.tabsUpdate[0].url;
  check(
    "(g2) marker url is the once-unwrapped archive.ph url",
    markerUrl,
    "https://archive.ph/newest/https://example.com/a"
  );

  onRemoved(60);

  // Replay the EXACT marker url on the SAME reused tabId. With a working
  // onRemoved cleanup, the marker is gone, so this is evaluated fresh by
  // rule (a) and peels the second layer -> a second tabs.update. With a
  // stale (uncleared) marker, this would be silently swallowed and the
  // count would stay at 1.
  onUpdated(60, { url: markerUrl }, { id: 60, url: markerUrl });
  await flush();
  check(
    "(g2) reused tabId's replay of the marker url is evaluated fresh, not swallowed (onRemoved cleared the marker)",
    h.calls.tabsUpdate.length,
    2
  );
  check(
    "(g2) second update peels the remaining layer down to the plain original",
    h.calls.tabsUpdate[1] && h.calls.tabsUpdate[1].url,
    "https://example.com/a"
  );
}

// --- (h) context-menu click on a link records override for the NEW tab ---

async function testContextMenuLinkRecordsNewTabOverride() {
  const h = loadBackground({ newTabSetting: false });
  const menuListener = h.getMenuOnClickedListener();

  assertTrue("(h) context menu registered", Boolean(h.getCreatedMenu()));
  check(
    "(h) context menu id",
    h.getCreatedMenu() && h.getCreatedMenu().id,
    "open-in-archive-ph"
  );

  // Link archiving always forces a new tab regardless of newTab=false.
  menuListener(
    { linkUrl: "https://example.com/link-target" },
    { id: 1, url: "https://unrelated.com/current-page" }
  );
  await flush();

  check("(h) link archive always creates a new tab", h.calls.tabsCreate.length, 1);
  check("(h) tabs.update not used for link archiving", h.calls.tabsUpdate.length, 0);

  const newTabId = h.calls.tabsCreate[0].id;
  const { sandbox } = h;
  assertTrue(
    "(h) override recorded against the NEW tab id",
    sandbox.hasManualOverride(newTabId, "https://example.com/other-page")
  );
  check(
    "(h) override NOT recorded against the triggering tab id",
    sandbox.hasManualOverride(1, "https://example.com/other-page"),
    false
  );
}

// --- Auto-redirect engine (bead 6kl.4) ------------------------------------
//
// Drives the REAL api.tabs.onUpdated listener background.js registers,
// against a mock storage.local seeded with the domain lists. Fires the
// captured listener manually with (tabId, {url}, tab) the way the browser
// would on a navigation's URL-changing event.

// --- (a) nav to always-archive domain -> tabs.update to archive.ph -------

async function testEngineArchivesListedDomain() {
  const h = loadBackground({ alwaysArchiveDomains: ["example.com"] });
  const onUpdated = h.getOnUpdatedListener();

  onUpdated(1, { url: "https://example.com/article" }, { id: 1, url: "https://example.com/article" });
  await flush();

  check("(engine-a) tabs.update called once", h.calls.tabsUpdate.length, 1);
  check("(engine-a) tabs.update targets same tab", h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].tabId, 1);
  check(
    "(engine-a) tabs.update url is archive.ph/newest/<url>",
    h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].url,
    "https://archive.ph/newest/https://example.com/article"
  );
  check("(engine-a) tabs.create not called", h.calls.tabsCreate.length, 0);
}

// --- (b) nav to archive URL of always-original domain -> tabs.update to
//     original, same tab even when newTab=true in storage -----------------

async function testEngineDeArchivesListedDomainIgnoresNewTab() {
  const h = loadBackground({
    alwaysOriginalDomains: ["news.example"],
    newTabSetting: true,
  });
  const onUpdated = h.getOnUpdatedListener();

  const archiveUrl = "https://archive.ph/AbC12/https://news.example/story";
  onUpdated(2, { url: archiveUrl }, { id: 2, url: archiveUrl });
  await flush();

  check("(engine-b) tabs.update called once", h.calls.tabsUpdate.length, 1);
  check("(engine-b) tabs.update targets same tab despite newTab=true", h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].tabId, 2);
  check(
    "(engine-b) tabs.update url is the original",
    h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].url,
    "https://news.example/story"
  );
  check("(engine-b) tabs.create not called (newTab setting does not apply)", h.calls.tabsCreate.length, 0);
}

// --- (c) unlisted domain -> no calls ---------------------------------------

async function testEngineIgnoresUnlistedDomain() {
  const h = loadBackground({ alwaysArchiveDomains: ["example.com"] });
  const onUpdated = h.getOnUpdatedListener();

  onUpdated(3, { url: "https://unlisted.test/page" }, { id: 3, url: "https://unlisted.test/page" });
  await flush();

  check("(engine-c) tabs.update not called", h.calls.tabsUpdate.length, 0);
  check("(engine-c) tabs.create not called", h.calls.tabsCreate.length, 0);
}

// --- (d) archive URL of an UNLISTED original -> no calls -------------------

async function testEngineIgnoresArchiveOfUnlistedOriginal() {
  const h = loadBackground({ alwaysOriginalDomains: ["news.example"] });
  const onUpdated = h.getOnUpdatedListener();

  const archiveUrl = "https://archive.ph/AbC12/https://unlisted.test/story";
  onUpdated(4, { url: archiveUrl }, { id: 4, url: archiveUrl });
  await flush();

  check("(engine-d) tabs.update not called", h.calls.tabsUpdate.length, 0);
  check("(engine-d) tabs.create not called", h.calls.tabsCreate.length, 0);
}

// --- (e) manual-override precedence: toolbar de-archive click on an
//     always-archive domain's archive page (records override), then
//     onUpdated for the resulting original URL must NOT bounce it back ----

async function testEngineRespectsManualOverride() {
  const h = loadBackground({
    alwaysArchiveDomains: ["example.com"],
    newTabSetting: false,
  });
  const onClicked = h.getOnClickedListener();
  const onUpdated = h.getOnUpdatedListener();

  // Simulate the user manually de-archiving via the toolbar toggle.
  const archiveUrl = "https://archive.ph/AbC12/https://example.com/article";
  onClicked({ id: 5, url: archiveUrl });
  await flush();

  check("(engine-e) manual de-archive click updates tab", h.calls.tabsUpdate.length, 1);
  check(
    "(engine-e) manual de-archive lands on original",
    h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].url,
    "https://example.com/article"
  );

  // Browser now reports the navigation onUpdated fired for -- the engine
  // must recognize the manual override and NOT re-archive it.
  onUpdated(5, { url: "https://example.com/article" }, { id: 5, url: "https://example.com/article" });
  await flush();

  check(
    "(engine-e) engine does not bounce a manually-overridden nav back to archive",
    h.calls.tabsUpdate.length,
    1
  );
  check("(engine-e) tabs.create still not called", h.calls.tabsCreate.length, 0);
}

// --- (f) engine-marker: after rule-b redirect, firing onUpdated with the
//     engine's own target URL must not cause a second update (marker
//     consumed); a SUBSEQUENT identical nav (marker gone) DOES redirect
//     again -------------------------------------------------------------

async function testEngineMarkerConsumedOnce() {
  const h = loadBackground({ alwaysArchiveDomains: ["example.com"] });
  const onUpdated = h.getOnUpdatedListener();

  onUpdated(6, { url: "https://example.com/article" }, { id: 6, url: "https://example.com/article" });
  await flush();

  check("(engine-f) first nav triggers one redirect", h.calls.tabsUpdate.length, 1);
  const targetUrl = h.calls.tabsUpdate[0].url;

  // Browser reports the engine's own redirect landing -- marker should
  // consume this and NOT trigger a second update.
  onUpdated(6, { url: targetUrl }, { id: 6, url: targetUrl });
  await flush();

  check("(engine-f) engine's own redirect landing does not re-trigger", h.calls.tabsUpdate.length, 1);

  // A later, separate nav back to the same original URL (marker already
  // consumed above) DOES get redirected again -- the marker is one-shot,
  // not a permanent suppression.
  onUpdated(6, { url: "https://example.com/article" }, { id: 6, url: "https://example.com/article" });
  await flush();

  check("(engine-f) subsequent identical nav redirects again (marker was consumed)", h.calls.tabsUpdate.length, 2);
  check(
    "(engine-f) second redirect url matches the first",
    h.calls.tabsUpdate[1] && h.calls.tabsUpdate[1].url,
    targetUrl
  );
}

// --- (g) mirrors in alwaysArchiveDomains are skipped ------------------------
//
// Uses a mirror SUBDOMAIN (sub.archive.ph) rather than archive.ph itself:
// isArchiveUrl is false for a mirror subdomain (MIRROR_HOSTS only lists the
// bare mirror hosts), so this nav does NOT take the de-archive branch --
// it reaches the archive rule, where urlMatchesDomain("archive.ph") still
// matches the subdomain. The mirror-host guard in the archive rule is the
// only thing preventing an archive-the-archive redirect here.

async function testEngineSkipsMirrorHostInArchiveList() {
  const h = loadBackground({ alwaysArchiveDomains: ["archive.ph"] });
  const onUpdated = h.getOnUpdatedListener();

  onUpdated(
    7,
    { url: "https://sub.archive.ph/page" },
    { id: 7, url: "https://sub.archive.ph/page" }
  );
  await flush();

  check("(engine-g) mirror subdomain nav NOT archived", h.calls.tabsUpdate.length, 0);
  check("(engine-g) tabs.create not called either", h.calls.tabsCreate.length, 0);
}

// --- (h) storage.get rejecting -> no calls, no unhandled rejection --------

async function testEngineStorageRejectionIsSafe() {
  const h = loadBackground({ storageGetShouldReject: true });
  const onUpdated = h.getOnUpdatedListener();

  onUpdated(8, { url: "https://example.com/article" }, { id: 8, url: "https://example.com/article" });
  await flush();

  check("(engine-h) tabs.update not called on storage rejection", h.calls.tabsUpdate.length, 0);
  check("(engine-h) tabs.create not called on storage rejection", h.calls.tabsCreate.length, 0);
}

// --- (i) non-http scheme -> no calls ----------------------------------------

async function testEngineIgnoresNonHttpScheme() {
  const h = loadBackground({ alwaysArchiveDomains: ["example.com"] });
  const onUpdated = h.getOnUpdatedListener();

  onUpdated(9, { url: "about:blank" }, { id: 9, url: "about:blank" });
  await flush();

  check("(engine-i) tabs.update not called for non-http scheme", h.calls.tabsUpdate.length, 0);
  check("(engine-i) tabs.create not called for non-http scheme", h.calls.tabsCreate.length, 0);
}

// --- (j) subdomain matching: sub.example.com redirects when example.com is
//     listed -----------------------------------------------------------

async function testEngineMatchesSubdomain() {
  const h = loadBackground({ alwaysArchiveDomains: ["example.com"] });
  const onUpdated = h.getOnUpdatedListener();

  onUpdated(10, { url: "https://sub.example.com/page" }, { id: 10, url: "https://sub.example.com/page" });
  await flush();

  check("(engine-j) subdomain nav triggers archive redirect", h.calls.tabsUpdate.length, 1);
  check(
    "(engine-j) redirect url archives the subdomain url",
    h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].url,
    "https://archive.ph/newest/https://sub.example.com/page"
  );
}

// --- (k) loop-drill: domain on alwaysOriginalDomains, fire archive URL ->
//     update to original; fire the original nav (engine marker) -> consumed,
//     no further update --------------------------------------------------

async function testEngineLoopDrillDeArchiveMarker() {
  const h = loadBackground({ alwaysOriginalDomains: ["news.example"] });
  const onUpdated = h.getOnUpdatedListener();

  const archiveUrl = "https://archive.ph/AbC12/https://news.example/story";
  onUpdated(11, { url: archiveUrl }, { id: 11, url: archiveUrl });
  await flush();

  check("(engine-k) de-archive rule fires once", h.calls.tabsUpdate.length, 1);
  const originalUrl = h.calls.tabsUpdate[0].url;
  check("(engine-k) redirected to original", originalUrl, "https://news.example/story");

  // Browser reports the engine's own redirect landing.
  onUpdated(11, { url: originalUrl }, { id: 11, url: originalUrl });
  await flush();

  check("(engine-k) engine's own de-archive landing does not re-trigger", h.calls.tabsUpdate.length, 1);
}

// --- (l) corrupted storage, NON-NESTED case: domain on BOTH lists -- rule
//     (a)'s own corrupted-storage guard (not the engine marker) is what
//     prevents a second update when the engine's own archive-URL landing is
//     replayed. This scopes the claim to exactly what this case covers: a
//     single-layer archive URL whose extracted original's domain is on both
//     lists, so rule (a)'s defensive "original also on alwaysArchiveDomains"
//     check independently subsumes the marker here. This does NOT generalize
//     to every scenario -- case (m) below constructs a NESTED archive-of-
//     archive sequence where the marker IS independently load-bearing (the
//     rule-a guard does not subsume it there, because the second layer's
//     extracted original lands on a domain that is on alwaysOriginalDomains
//     and NOT on alwaysArchiveDomains, so the guard has nothing to block on).
//     -----------------------------------------------------------------------

async function testEngineCorruptedBothListsGuardedByRuleA() {
  const h = loadBackground({
    alwaysArchiveDomains: ["example.com"],
    alwaysOriginalDomains: ["example.com"],
  });
  const onUpdated = h.getOnUpdatedListener();

  // Plain nav to the both-listed domain -> rule (b) fires (archive rule
  // runs first for non-archive URLs) and marks the engine navigation.
  onUpdated(12, { url: "https://example.com/article" }, { id: 12, url: "https://example.com/article" });
  await flush();

  check("(engine-l) rule (b) fires once for both-listed domain", h.calls.tabsUpdate.length, 1);
  const archiveUrl = h.calls.tabsUpdate[0].url;

  // Browser reports the engine's own redirect landing on the archive URL.
  // The marker guard consumes this. Even if it didn't, rule (a)'s own
  // corrupted-storage guard (original's domain ALSO on alwaysArchiveDomains)
  // independently returns before issuing a second tabs.update in THIS
  // non-nested scenario -- verified by mutation-testing a throwaway copy
  // with the marker-consume block removed, which produced the identical
  // call count. This subsumption is specific to the single-layer,
  // both-listed-domain case; it does not hold for the nested archive-of-
  // archive sequence in case (m) below, where the marker is independently
  // load-bearing.
  onUpdated(12, { url: archiveUrl }, { id: 12, url: archiveUrl });
  await flush();

  check(
    "(engine-l) no second update on the engine's own landing (marker and rule-a guard both hold)",
    h.calls.tabsUpdate.length,
    1
  );
}

// --- (m) NESTED archive-of-archive: the engine marker IS independently
//     load-bearing here, unlike case (l) above -----------------------------
//
// alwaysOriginalDomains = ["example.com", "archive.ph"], alwaysArchiveDomains
// = []. Firing onUpdated with the doubly-nested URL
// https://archive.ph/newest/https://archive.ph/newest/https://example.com/a
// makes rule (a) de-archive ONE layer: extractOriginalUrl peels off the
// outermost "https://archive.ph/newest/" wrapper, yielding
// https://archive.ph/newest/https://example.com/a, whose host (archive.ph)
// matches alwaysOriginalDomains and is NOT on alwaysArchiveDomains (empty),
// so the corrupted-storage guard does not block -- tabs.update #1 fires and
// the marker is set to that once-unwrapped URL.
//
// Replaying that landed URL (simulating the browser reporting the engine's
// own navigation) must be swallowed by the marker. Without the marker, rule
// (a) would evaluate it fresh: it is STILL an archive URL (host archive.ph),
// so extractOriginalUrl peels the SECOND layer, yielding
// https://example.com/a, whose domain (example.com) is on
// alwaysOriginalDomains and NOT on alwaysArchiveDomains -- the
// corrupted-storage guard has nothing to block on, so rule (a) would fire a
// SECOND tabs.update. This is exactly the divergence case (l)'s guard could
// not produce: here there is no both-listed domain for the guard to catch,
// because each layer's host matches a *different* list entry. This is why
// the marker is independently load-bearing for this sequence, unlike (l).

async function testEngineMarkerLoadBearingOnNestedArchiveOfArchive() {
  const h = loadBackground({
    alwaysOriginalDomains: ["example.com", "archive.ph"],
    alwaysArchiveDomains: [],
  });
  const onUpdated = h.getOnUpdatedListener();

  const nestedUrl =
    "https://archive.ph/newest/https://archive.ph/newest/https://example.com/a";
  onUpdated(13, { url: nestedUrl }, { id: 13, url: nestedUrl });
  await flush();

  check("(engine-m) rule (a) de-archives one layer", h.calls.tabsUpdate.length, 1);
  const onceUnwrapped = h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].url;
  check(
    "(engine-m) landed on the once-unwrapped archive.ph URL",
    onceUnwrapped,
    "https://archive.ph/newest/https://example.com/a"
  );

  // Browser reports the engine's own redirect landing. The marker must
  // consume this; without it, rule (a) would peel the second layer and fire
  // again (see the comment above for why the corrupted-storage guard does
  // not catch this sequence the way it does in case (l)).
  onUpdated(13, { url: onceUnwrapped }, { id: 13, url: onceUnwrapped });
  await flush();

  check(
    "(engine-m) marker swallows the replayed landing; no second update",
    h.calls.tabsUpdate.length,
    1
  );
}

// --- Snapshot-probe message path (bead 6kl.6) -----------------------------
//
// Drives the REAL api.runtime.onMessage listener background.js registers,
// simulating {type:'snapshot-original', originalUrl} reports from the
// content script for bare short-code archive tabs.

// --- (n) message + domain on alwaysOriginalDomains -> tabs.update to
//     original, engine marker set ------------------------------------------

async function testSnapshotMessageDeArchivesListedDomain() {
  const h = loadBackground({ alwaysOriginalDomains: ["news.example"] });

  await dispatchMessage(
    h,
    { type: "snapshot-original", originalUrl: "https://news.example/story" },
    20
  );

  check("(snapshot-n) tabs.update called once", h.calls.tabsUpdate.length, 1);
  check("(snapshot-n) tabs.update targets the reporting tab", h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].tabId, 20);
  check(
    "(snapshot-n) tabs.update url is the reported original",
    h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].url,
    "https://news.example/story"
  );
  check("(snapshot-n) tabs.create not called", h.calls.tabsCreate.length, 0);

  // The engine marker must also be set so a subsequent tabs.onUpdated event
  // reporting this same navigation landing (if the browser fires one) is
  // recognized as engine-initiated and not re-evaluated.
  const onUpdated = h.getOnUpdatedListener();
  onUpdated(20, { url: "https://news.example/story" }, { id: 20, url: "https://news.example/story" });
  await flush();
  check(
    "(snapshot-n) engine marker set by the message path suppresses a follow-up onUpdated for the same landing",
    h.calls.tabsUpdate.length,
    1
  );
}

// --- (o) manual override suppresses the message-path redirect -------------

async function testSnapshotMessageSuppressedByManualOverride() {
  const h = loadBackground({ alwaysOriginalDomains: ["news.example"] });
  const { sandbox } = h;

  // Simulate a prior manual toggle that recorded an override for this tab
  // against news.example (e.g. the user manually re-archived it already).
  sandbox.recordManualOverride(21, "https://news.example/story");

  await dispatchMessage(
    h,
    { type: "snapshot-original", originalUrl: "https://news.example/story" },
    21
  );

  check(
    "(snapshot-o) manual override suppresses the auto de-archive",
    h.calls.tabsUpdate.length,
    0
  );
  check("(snapshot-o) tabs.create not called either", h.calls.tabsCreate.length, 0);
}

// --- (p) unlisted domain -> no tabs call, but still stored for the toggle
//     fallback (case (s) below exercises the fallback read) ----------------

async function testSnapshotMessageUnlistedDomainNoCall() {
  const h = loadBackground({ alwaysOriginalDomains: ["news.example"] });

  await dispatchMessage(
    h,
    { type: "snapshot-original", originalUrl: "https://unlisted.test/story" },
    22
  );

  check("(snapshot-p) tabs.update not called for unlisted domain", h.calls.tabsUpdate.length, 0);
  check("(snapshot-p) tabs.create not called for unlisted domain", h.calls.tabsCreate.length, 0);
}

// --- (q) mirror-host originalUrl is rejected (never trust content-script
//     input blindly) --------------------------------------------------------

async function testSnapshotMessageRejectsMirrorHostOriginal() {
  const h = loadBackground({ alwaysOriginalDomains: ["archive.ph"] });

  await dispatchMessage(
    h,
    { type: "snapshot-original", originalUrl: "https://archive.ph/newest/https://example.com/x" },
    23
  );

  check(
    "(snapshot-q) mirror-host originalUrl rejected, no tabs.update",
    h.calls.tabsUpdate.length,
    0
  );

  // Also must not be stored for the toggle fallback -- verified via the
  // toggle path itself: a bare short-code tab click after this rejected
  // report must still no-op.
  const onClicked = h.getOnClickedListener();
  onClicked({ id: 23, url: "https://archive.ph/AbC12" });
  await flush();
  check(
    "(snapshot-q) rejected report is not stored; toggle still no-ops",
    h.calls.tabsUpdate.length,
    0
  );
  check("(snapshot-q) toggle still does not create a tab either", h.calls.tabsCreate.length, 0);
}

// --- (r) non-http(s) scheme originalUrl is rejected ------------------------

async function testSnapshotMessageRejectsNonHttpOriginal() {
  const h = loadBackground({ alwaysOriginalDomains: ["example.com"] });

  await dispatchMessage(h, { type: "snapshot-original", originalUrl: "javascript:alert(1)" }, 24);

  check(
    "(snapshot-r) non-http(s) originalUrl rejected, no tabs.update",
    h.calls.tabsUpdate.length,
    0
  );
}

// --- (v) mirror-SUBDOMAIN originalUrl is rejected (bead ut7 item 1/4):
//     the probe rejects mirror subdomains via subdomain-aware
//     urlMatchesDomain; background revalidation must reject them too, not
//     just exact mirror hosts. ------------------------------------------

async function testSnapshotMessageRejectsMirrorSubdomainOriginal() {
  const h = loadBackground({ alwaysOriginalDomains: ["archive.is"] });

  await dispatchMessage(
    h,
    { type: "snapshot-original", originalUrl: "https://news.archive.is/x" },
    28
  );

  check(
    "(snapshot-v) mirror-subdomain originalUrl rejected, no tabs.update",
    h.calls.tabsUpdate.length,
    0
  );

  // Also must not be stored for the toggle fallback.
  const onClicked = h.getOnClickedListener();
  onClicked({ id: 28, url: "https://archive.ph/AbC12" });
  await flush();
  check(
    "(snapshot-v) rejected mirror-subdomain report is not stored; toggle still no-ops",
    h.calls.tabsUpdate.length,
    0
  );
}

// --- (w) scheme guard: ftp:// originalUrl is rejected (bead ut7 item 2) ----
//     Pins isHttpUrl's presence in the handler: deleting that guard would
//     let a non-http(s) scheme reach tabs.update via the de-archive rule
//     below (unlike case (r)'s javascript: which the earlier isHttpUrl
//     check already covers, this locks the guard against a *plausible-
//     looking* scheme rather than an obviously-inert one). ----------------

async function testSnapshotMessageRejectsFtpScheme() {
  const h = loadBackground({ alwaysOriginalDomains: ["example.com"] });

  await dispatchMessage(
    h,
    { type: "snapshot-original", originalUrl: "ftp://x.example.com/" },
    29
  );

  check(
    "(snapshot-w) ftp:// originalUrl rejected, no tabs.update",
    h.calls.tabsUpdate.length,
    0
  );
  check("(snapshot-w) ftp:// originalUrl rejected, no tabs.create", h.calls.tabsCreate.length, 0);
}

// --- (x) sender.tab.url present but NOT a mirror-host page -> message
//     ignored (bead ut7 item 3): a snapshot-original report can only
//     legitimately originate from a mirror page. ---------------------------

async function testSnapshotMessageIgnoredWhenSenderTabNotMirror() {
  const h = loadBackground({ alwaysOriginalDomains: ["news.example"] });

  await dispatchMessage(
    h,
    { type: "snapshot-original", originalUrl: "https://news.example/story" },
    30,
    "https://not-a-mirror.example/some-page"
  );

  check(
    "(snapshot-x) non-mirror sender.tab.url -> message ignored, no tabs.update",
    h.calls.tabsUpdate.length,
    0
  );

  // Also must not be stored for the toggle fallback.
  const onClicked = h.getOnClickedListener();
  onClicked({ id: 30, url: "https://archive.ph/AbC12" });
  await flush();
  check(
    "(snapshot-x) ignored report is not stored; toggle still no-ops",
    h.calls.tabsUpdate.length,
    0
  );
}

// --- (y) sender.tab.url absent -> message still processed (tolerant path,
//     some Safari contexts omit tab.url) ------------------------------------

async function testSnapshotMessageProcessedWhenSenderTabUrlAbsent() {
  const h = loadBackground({ alwaysOriginalDomains: ["news.example"] });

  await dispatchMessage(
    h,
    { type: "snapshot-original", originalUrl: "https://news.example/story" },
    31
  );

  check(
    "(snapshot-y) absent sender.tab.url does not block processing",
    h.calls.tabsUpdate.length,
    1
  );
  check(
    "(snapshot-y) tabs.update targets the reporting tab",
    h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].tabId,
    31
  );
}

// --- (s) toggle fallback: bare short-code tab, AFTER a message stored the
//     original, navigates to it (and records a manual override) ------------

async function testToggleFallsBackToStoredSnapshotOriginal() {
  const h = loadBackground({ newTabSetting: false });

  // Unlisted-domain report (case p's scenario): stored but does not itself
  // trigger a redirect since no domain-list rule matches.
  await dispatchMessage(
    h,
    { type: "snapshot-original", originalUrl: "https://example.com/bare-code-story" },
    25
  );
  check(
    "(snapshot-s) storing report alone does not navigate",
    h.calls.tabsUpdate.length,
    0
  );

  const onClicked = h.getOnClickedListener();
  onClicked({ id: 25, url: "https://archive.ph/f0rxt" });
  await flush();

  check("(snapshot-s) toggle click uses the stored original", h.calls.tabsUpdate.length, 1);
  check(
    "(snapshot-s) toggle click navigates to the stored original url",
    h.calls.tabsUpdate[0] && h.calls.tabsUpdate[0].url,
    "https://example.com/bare-code-story"
  );
  check("(snapshot-s) toggle click did not open a new tab", h.calls.tabsCreate.length, 0);

  const { sandbox } = h;
  assertTrue(
    "(snapshot-s) toggle click records a manual override for the de-archived domain",
    sandbox.hasManualOverride(25, "https://example.com/bare-code-story")
  );
}

// --- (t) toggle fallback: no message ever stored -> still no-op -----------

async function testToggleNoFallbackWhenNoMessageStored() {
  const h = loadBackground({});
  const onClicked = h.getOnClickedListener();

  onClicked({ id: 26, url: "https://archive.ph/f0rxt" });
  await flush();

  check(
    "(snapshot-t) no stored original -> toggle still no-ops",
    h.calls.tabsUpdate.length,
    0
  );
  check("(snapshot-t) toggle still does not create a tab", h.calls.tabsCreate.length, 0);
}

// --- (u) tabs.onRemoved clears the stored snapshot original ----------------

async function testOnRemovedClearsSnapshotOriginal() {
  const h = loadBackground({});

  await dispatchMessage(
    h,
    { type: "snapshot-original", originalUrl: "https://example.com/cleared-story" },
    27
  );

  const onRemoved = h.getOnRemovedListener();
  onRemoved(27);

  const onClicked = h.getOnClickedListener();
  onClicked({ id: 27, url: "https://archive.ph/f0rxt" });
  await flush();

  check(
    "(snapshot-u) stored original cleared by tabs.onRemoved; toggle no-ops",
    h.calls.tabsUpdate.length,
    0
  );
}

// --- run all cases ---------------------------------------------------------

async function main() {
  testSharedScopeLoadDoesNotThrow();

  await testNormalPageDefaultNewTab();
  await testStorageGetReturnsEmptyObjectDefaultsToSameTab();
  await testDeArchiveSameTab();
  await testDeArchiveNewTab();
  await testBareShortCodeNoOp();
  await testToggleRoundTrip();
  await testOverrideRegistry();
  await testOnRemovedClearsEntry();
  await testOnRemovedClearsEngineMarker();
  await testContextMenuLinkRecordsNewTabOverride();

  await testEngineArchivesListedDomain();
  await testEngineDeArchivesListedDomainIgnoresNewTab();
  await testEngineIgnoresUnlistedDomain();
  await testEngineIgnoresArchiveOfUnlistedOriginal();
  await testEngineRespectsManualOverride();
  await testEngineMarkerConsumedOnce();
  await testEngineSkipsMirrorHostInArchiveList();
  await testEngineStorageRejectionIsSafe();
  await testEngineIgnoresNonHttpScheme();
  await testEngineMatchesSubdomain();
  await testEngineLoopDrillDeArchiveMarker();
  await testEngineCorruptedBothListsGuardedByRuleA();
  await testEngineMarkerLoadBearingOnNestedArchiveOfArchive();

  await testSnapshotMessageDeArchivesListedDomain();
  await testSnapshotMessageSuppressedByManualOverride();
  await testSnapshotMessageUnlistedDomainNoCall();
  await testSnapshotMessageRejectsMirrorHostOriginal();
  await testSnapshotMessageRejectsNonHttpOriginal();
  await testSnapshotMessageRejectsMirrorSubdomainOriginal();
  await testSnapshotMessageRejectsFtpScheme();
  await testSnapshotMessageIgnoredWhenSenderTabNotMirror();
  await testSnapshotMessageProcessedWhenSenderTabUrlAbsent();
  await testToggleFallsBackToStoredSnapshotOriginal();
  await testToggleNoFallbackWhenNoMessageStored();
  await testOnRemovedClearsSnapshotOriginal();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
