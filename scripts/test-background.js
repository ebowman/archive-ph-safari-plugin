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
// default, matching "unset" -> defaults to true per shouldUseNewTab).
function makeMockChrome({ newTabSetting } = {}) {
  let nextTabId = 100;

  const calls = {
    tabsUpdate: [], // { tabId, url }
    tabsCreate: [], // { url }
  };

  let onClickedListener = null;
  let onRemovedListener = null;
  let menuOnClickedListener = null;
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
    },
    storage: {
      local: {
        get(key) {
          if (key === "newTab") {
            return Promise.resolve(
              newTabSetting === undefined ? {} : { newTab: newTabSetting }
            );
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
    },
  };

  return {
    chromeMock,
    calls,
    getOnClickedListener: () => onClickedListener,
    getOnRemovedListener: () => onRemovedListener,
    getMenuOnClickedListener: () => menuOnClickedListener,
    getCreatedMenu: () => createdMenu,
  };
}

// Loads archive-url.js then background.js into one fresh vm context wired
// to the given mock chrome global. Returns the harness handles plus the
// sandbox (for globalThis inspection, unused today but handy for debugging).
function loadBackground({ newTabSetting } = {}) {
  const harness = makeMockChrome({ newTabSetting });

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

  // Both files declare top-level `const`/`function` bindings (e.g. MIRRORS
  // in both, `api` in background.js) that would collide as duplicate
  // lexical declarations if run as two top-level scripts in the same vm
  // context (Safari avoids this by giving each <script> tag its own
  // top-level scope, which vm.runInContext does not do across separate
  // calls). Wrapping each in an IIFE isolates its lexical scope the same
  // way; both files already communicate solely via explicit
  // `globalThis.X = ...` assignments (ArchiveUrl, recordManualOverride,
  // hasManualOverride), so this doesn't change observable behavior.
  const archiveUrlSource = fs.readFileSync(ARCHIVE_URL_PATH, "utf8");
  vm.runInContext(`(function(){\n${archiveUrlSource}\n})();`, sandbox, {
    filename: ARCHIVE_URL_PATH,
  });

  const backgroundSource = fs.readFileSync(BACKGROUND_PATH, "utf8");
  vm.runInContext(`(function(){\n${backgroundSource}\n})();`, sandbox, {
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

// --- (a) normal page + newTab default -> tabs.create with archive.ph -----

async function testNormalPageDefaultNewTab() {
  const h = loadBackground({});
  const listener = h.getOnClickedListener();
  listener({ id: 1, url: "https://example.com/article" });
  await flush();

  check("(a) tabs.update not called", h.calls.tabsUpdate.length, 0);
  check("(a) tabs.create called once", h.calls.tabsCreate.length, 1);
  check(
    "(a) tabs.create url is archive.ph/newest/<url>",
    h.calls.tabsCreate[0] && h.calls.tabsCreate[0].url,
    "https://archive.ph/newest/https://example.com/article"
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

// --- run all cases ---------------------------------------------------------

async function main() {
  await testNormalPageDefaultNewTab();
  await testDeArchiveSameTab();
  await testDeArchiveNewTab();
  await testBareShortCodeNoOp();
  await testToggleRoundTrip();
  await testOverrideRegistry();
  await testOnRemovedClearsEntry();
  await testContextMenuLinkRecordsNewTabOverride();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
