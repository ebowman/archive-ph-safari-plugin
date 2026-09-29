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

// --- summary -----------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
