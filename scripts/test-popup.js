#!/usr/bin/env node
// Zero-dependency fixture test for extension/popup/popup.js's pure,
// DOM-free logic (globalThis.PopupLogic).
//
// Approach mirrors scripts/test-settings.js: popup.js is structured as an
// IIFE that (a) always defines globalThis.PopupLogic -- pure functions with
// no DOM/storage access -- and (b) only wires up DOM event listeners and
// browser.storage/runtime.sendMessage calls if `typeof document !==
// "undefined"`. This harness loads archive-url.js, then settings.js (whose
// SettingsLogic popup.js's DOM-wiring half relies on -- not exercised by
// this pure-logic harness, but loaded here so the shared-scope load itself
// is exercised the same way Safari loads popup.html's three <script> tags),
// then popup.js RAW into one vm context that has no `document` global at
// all, so the DOM-wiring half of popup.js is skipped entirely and only
// PopupLogic gets attached.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ARCHIVE_URL_PATH = path.join(__dirname, "..", "extension", "archive-url.js");
const SETTINGS_JS_PATH = path.join(__dirname, "..", "extension", "settings", "settings.js");
const POPUP_JS_PATH = path.join(__dirname, "..", "extension", "popup", "popup.js");

const archiveUrlSource = fs.readFileSync(ARCHIVE_URL_PATH, "utf8");
const settingsSource = fs.readFileSync(SETTINGS_JS_PATH, "utf8");
const popupSource = fs.readFileSync(POPUP_JS_PATH, "utf8");

// No `document` in the sandbox -> both settings.js's and popup.js's
// DOM-wiring branches are skipped (each early-returns after defining its
// globalThis.*Logic object).
const sandbox = { URL };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// Loaded RAW (no per-file wrapping) into one shared vm context, exactly
// like Safari loads popup.html's <script src="../archive-url.js">,
// <script src="../settings/settings.js">, <script src="popup.js"> as
// sequential tags sharing one top-level lexical scope. This also guards
// against the bead 9k9 shared-scope hazard: if popup.js (or a future edit
// to it) reintroduced a top-level const/let/function/class name that
// collides with one already declared top-level in archive-url.js or
// settings.js, this raw load would throw "Can't create duplicate
// variable" and fail the whole suite, not just silently pass.
vm.runInContext(archiveUrlSource, sandbox, { filename: ARCHIVE_URL_PATH });
vm.runInContext(settingsSource, sandbox, { filename: SETTINGS_JS_PATH });
vm.runInContext(popupSource, sandbox, { filename: POPUP_JS_PATH });

const PopupLogic = sandbox.PopupLogic;
if (!PopupLogic) {
  console.error("FAIL: extension/popup/popup.js did not define globalThis.PopupLogic");
  process.exit(1);
}
const SettingsLogic = sandbox.SettingsLogic;
if (!SettingsLogic) {
  console.error("FAIL: extension/settings/settings.js did not define globalThis.SettingsLogic");
  process.exit(1);
}
if (typeof sandbox.document !== "undefined") {
  console.error("FAIL: harness sandbox unexpectedly has a `document` global");
  process.exit(1);
}

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

// --- labelFor ----------------------------------------------------------------

{
  check(
    "labelFor: normal https url -> 'Open in archive.ph'",
    PopupLogic.labelFor("https://example.com/article"),
    "Open in archive.ph"
  );
}

{
  check(
    "labelFor: archive.ph url -> 'Back to original'",
    PopupLogic.labelFor("https://archive.ph/AbC12/https://example.com/article"),
    "Back to original"
  );
}

{
  check(
    "labelFor: another mirror host url -> 'Back to original'",
    PopupLogic.labelFor("https://archive.is/AbC12/https://example.com/article"),
    "Back to original"
  );
}

{
  check("labelFor: null -> 'Cannot access this page'", PopupLogic.labelFor(null), "Cannot access this page");
}

{
  check(
    "labelFor: undefined -> 'Cannot access this page'",
    PopupLogic.labelFor(undefined),
    "Cannot access this page"
  );
}

{
  check(
    "labelFor: non-http url (about:blank) -> 'Cannot access this page'",
    PopupLogic.labelFor("about:blank"),
    "Cannot access this page"
  );
}

{
  check(
    "labelFor: unparseable string -> 'Cannot access this page'",
    PopupLogic.labelFor("not a url"),
    "Cannot access this page"
  );
}

// --- domainFor -----------------------------------------------------------

{
  check(
    "domainFor: normal https url -> its own domain",
    PopupLogic.domainFor("https://example.com/article"),
    "example.com"
  );
}

{
  check(
    "domainFor: normal https url with www -> normalized without www",
    PopupLogic.domainFor("https://www.example.com/article"),
    "example.com"
  );
}

{
  check(
    "domainFor: archive.ph url -> the EXTRACTED ORIGINAL's domain, not archive.ph",
    PopupLogic.domainFor("https://archive.ph/AbC12/https://news.example.com/story"),
    "news.example.com"
  );
}

{
  check(
    "domainFor: bare short-code archive url (no embedded original) -> null",
    PopupLogic.domainFor("https://archive.ph/AbC12"),
    null
  );
}

{
  check("domainFor: null -> null", PopupLogic.domainFor(null), null);
}

{
  check("domainFor: non-http url -> null (normalizeDomain rejects it)", PopupLogic.domainFor("about:blank"), null);
}

// --- quickToggleState ------------------------------------------------------

{
  const state = SettingsLogic.emptyState();
  const toggles = PopupLogic.quickToggleState(state, "example.com");
  check("quickToggleState: empty state -> both false", toggles, {
    alwaysArchive: false,
    alwaysOriginal: false,
  });
}

{
  let state = SettingsLogic.emptyState();
  state = SettingsLogic.addDomain(state, "alwaysArchiveDomains", "example.com");
  const toggles = PopupLogic.quickToggleState(state, "example.com");
  check("quickToggleState: domain on alwaysArchiveDomains -> alwaysArchive true", toggles, {
    alwaysArchive: true,
    alwaysOriginal: false,
  });
}

{
  let state = SettingsLogic.emptyState();
  state = SettingsLogic.addDomain(state, "alwaysOriginalDomains", "example.com");
  const toggles = PopupLogic.quickToggleState(state, "example.com");
  check("quickToggleState: domain on alwaysOriginalDomains -> alwaysOriginal true", toggles, {
    alwaysArchive: false,
    alwaysOriginal: true,
  });
}

{
  // Transition: start on alwaysOriginalDomains, then addDomain into
  // alwaysArchiveDomains (mutual exclusivity moves it, per SettingsLogic's
  // own contract) -- quickToggleState must reflect the POST-move state.
  let state = SettingsLogic.emptyState();
  state = SettingsLogic.addDomain(state, "alwaysOriginalDomains", "example.com");
  state = SettingsLogic.addDomain(state, "alwaysArchiveDomains", "example.com");
  const toggles = PopupLogic.quickToggleState(state, "example.com");
  check("quickToggleState: transition moves alwaysOriginal -> alwaysArchive", toggles, {
    alwaysArchive: true,
    alwaysOriginal: false,
  });
}

{
  // Transition: remove a domain that was on alwaysArchiveDomains -> both
  // false again.
  let state = SettingsLogic.emptyState();
  state = SettingsLogic.addDomain(state, "alwaysArchiveDomains", "example.com");
  state = SettingsLogic.removeDomain(state, "alwaysArchiveDomains", "example.com");
  const toggles = PopupLogic.quickToggleState(state, "example.com");
  check("quickToggleState: transition removes from alwaysArchiveDomains -> both false", toggles, {
    alwaysArchive: false,
    alwaysOriginal: false,
  });
}

{
  // A domain not present in either list is false regardless of unrelated
  // entries in state.
  let state = SettingsLogic.emptyState();
  state = SettingsLogic.addDomain(state, "alwaysArchiveDomains", "other.com");
  const toggles = PopupLogic.quickToggleState(state, "example.com");
  check("quickToggleState: unrelated domain -> both false", toggles, {
    alwaysArchive: false,
    alwaysOriginal: false,
  });
}

{
  // null domain (e.g. a bare short-code archive tab domainFor couldn't
  // resolve) -> both false, never throws.
  let state = SettingsLogic.emptyState();
  state = SettingsLogic.addDomain(state, "alwaysArchiveDomains", "example.com");
  assertTrue(
    "quickToggleState: null domain does not throw and reports both false",
    (() => {
      const toggles = PopupLogic.quickToggleState(state, null);
      return toggles.alwaysArchive === false && toggles.alwaysOriginal === false;
    })()
  );
}

// --- DOM-level tests (bead 5xt.15) ------------------------------------------
//
// The tests above load popup.js with no `document` global, so only
// PopupLogic's pure functions get exercised. These tests instead build a
// second, separate vm context PER CASE with a minimal fake `document` (just
// enough getElementById-able stub elements for popup.js's init() to wire up
// without throwing), a fake `window.close` spy, and a fake `browser` whose
// runtime.sendMessage/storage.local.get resolve canned values -- mirroring
// how scripts/test-background.js fakes `chrome`. archive-url.js, settings.js,
// and popup.js are loaded raw into that one context, same as above and same
// as popup.html's three sequential <script> tags, so this also re-exercises
// the bead 9k9 shared-scope hazard under a `document`-having context (the
// pure-logic harness above only exercises it under a document-less one).
//
// popup.js registers its DOM-wiring init() via
// `document.addEventListener("DOMContentLoaded", init)`; the fake document's
// addEventListener below just records the last-registered listener for a
// given event type instead of actually dispatching anything, so a test
// triggers init() by calling that recorded listener directly. (settings.js
// registers its own DOMContentLoaded listener for its own init() first, but
// popup.js is loaded after settings.js and registers second, so the fake's
// "last listener wins" recording ends up holding popup.js's init -- exactly
// the one these tests want to trigger. settings.js's own init(), which would
// throw on this harness's fake document since it reads `location.search`, is
// deliberately never invoked.)

function makeFakeElement(id) {
  const listeners = {};
  return {
    id,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    dispatch(type, event) {
      (listeners[type] || []).forEach((fn) => fn(event));
    },
    click() {
      this.dispatch("click", { preventDefault() {} });
    },
    setAttribute() {},
    removeAttribute() {},
    classList: {
      add() {},
      remove() {},
      contains() {
        return false;
      },
      toggle() {},
    },
    textContent: "",
    disabled: false,
    hidden: false,
    checked: false,
  };
}

const POPUP_ELEMENT_IDS = [
  "primary-button",
  "needs-access-notice",
  "quick-toggles",
  "domain-label",
  "all-settings-link",
  "always-archive-checkbox",
  "always-original-checkbox",
];

// Builds one fresh vm context with popup.html's three scripts loaded raw,
// backed by a fake document (elements above) and a fake browser whose
// get-action-state response resolves to `actionStateResponse`. Returns the
// stub elements plus recorders for sendMessage calls, storage.local.set
// calls, and window.close calls, and a function to trigger
// DOMContentLoaded (i.e. run popup.js's init()).
function buildDomHarness(actionStateResponse) {
  const elementsById = {};
  for (const id of POPUP_ELEMENT_IDS) {
    elementsById[id] = makeFakeElement(id);
  }

  let domContentLoadedHandler = null;

  const fakeDocument = {
    getElementById(id) {
      return Object.prototype.hasOwnProperty.call(elementsById, id) ? elementsById[id] : null;
    },
    addEventListener(type, fn) {
      if (type === "DOMContentLoaded") domContentLoadedHandler = fn;
    },
  };

  const closeCalls = [];
  const fakeWindow = {
    close() {
      closeCalls.push(true);
    },
  };

  const sentMessages = [];
  const storageSetCalls = [];
  const tabsCreateCalls = [];
  const fakeBrowser = {
    runtime: {
      sendMessage(message) {
        sentMessages.push(message);
        if (message && message.type === "get-action-state") {
          return Promise.resolve(actionStateResponse);
        }
        return Promise.resolve();
      },
      getURL(path) {
        return `safari-web-extension://fake/${path}`;
      },
    },
    storage: {
      local: {
        get() {
          // Empty lists, matching readDomainListState()'s fallback when
          // storage has neither key set.
          return Promise.resolve({});
        },
        set(values) {
          storageSetCalls.push(values);
          return Promise.resolve();
        },
      },
    },
    tabs: {
      create(info) {
        tabsCreateCalls.push(info);
        return Promise.resolve({});
      },
    },
  };

  const sandbox = { URL, document: fakeDocument, window: fakeWindow, browser: fakeBrowser };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  vm.runInContext(archiveUrlSource, sandbox, { filename: ARCHIVE_URL_PATH });
  vm.runInContext(settingsSource, sandbox, { filename: SETTINGS_JS_PATH });
  vm.runInContext(popupSource, sandbox, { filename: POPUP_JS_PATH });

  if (typeof domContentLoadedHandler !== "function") {
    throw new Error("popup.js did not register a DOMContentLoaded listener under the fake document");
  }

  return {
    elementsById,
    closeCalls,
    sentMessages,
    storageSetCalls,
    tabsCreateCalls,
    triggerDomContentLoaded: () => domContentLoadedHandler(),
  };
}

// Flushes pending microtasks so chained .then()/.catch() callbacks (popup.js's
// init() response handling and click handler both chain several) settle
// before assertions run.
function flushMicrotasks(times = 10) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) {
    p = p.then(() => {});
  }
  return p;
}

async function runDomTests() {
  // --- Case 1: normal http url -> click sends toggle-archive and closes ---
  {
    const harness = buildDomHarness({
      url: "https://example.com/x",
      isArchive: false,
      domain: "example.com",
    });
    harness.triggerDomContentLoaded();
    await flushMicrotasks();

    check(
      "DOM: normal http url -> primary button enabled",
      harness.elementsById["primary-button"].disabled,
      false
    );
    check(
      "DOM: normal http url -> quick-toggles section not hidden",
      harness.elementsById["quick-toggles"].hidden,
      false
    );

    harness.elementsById["primary-button"].click();
    await flushMicrotasks();

    const toggleMessages = harness.sentMessages.filter((m) => m && m.type === "toggle-archive");
    assertTrue(
      "DOM: clicking primary button sends {type: 'toggle-archive'}",
      toggleMessages.length === 1
    );
    check("DOM: clicking primary button calls window.close() exactly once", harness.closeCalls.length, 1);
  }

  // --- Case 2: non-http url (about:blank) -> disabled, quick-toggles hidden ---
  {
    const harness = buildDomHarness({
      url: "about:blank",
      isArchive: false,
      domain: null,
    });
    harness.triggerDomContentLoaded();
    await flushMicrotasks();

    check(
      "DOM: non-http url (about:blank) -> primary button disabled",
      harness.elementsById["primary-button"].disabled,
      true
    );
    check(
      "DOM: non-http url (about:blank) -> quick-toggles section hidden",
      harness.elementsById["quick-toggles"].hidden,
      true
    );
    check(
      "DOM: non-http url (about:blank) -> needs-access notice stays hidden (not url === null)",
      harness.elementsById["needs-access-notice"].hidden,
      true
    );
  }
}

// --- summary -----------------------------------------------------------------

runDomTests()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error("FAIL: DOM test harness threw:", err);
    process.exit(1);
  });
