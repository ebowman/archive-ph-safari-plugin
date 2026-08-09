#!/usr/bin/env node
// Zero-dependency fixture test for extension/settings/settings.js's pure
// state-transition logic (globalThis.SettingsLogic).
//
// Approach: settings.js is structured as an IIFE that (a) always defines
// globalThis.SettingsLogic — pure functions of the form (state, ...) ->
// newState, with no DOM/storage access — and (b) only wires up DOM event
// listeners and browser.storage calls if `typeof document !== "undefined"`.
// This harness loads archive-url.js (SettingsLogic.addDomain calls
// ArchiveUrl.normalizeDomain) then settings.js into a vm context that has
// no `document` global at all, so the DOM-wiring half of settings.js is
// skipped entirely and only SettingsLogic gets attached. This keeps
// settings.js itself readable (no separate "logic module" file to keep in
// sync) while letting the logic be exercised directly under plain node,
// mirroring the vm-context approach used by test-archive-url.js and
// test-background.js.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ARCHIVE_URL_PATH = path.join(__dirname, "..", "extension", "archive-url.js");
const SETTINGS_JS_PATH = path.join(__dirname, "..", "extension", "settings", "settings.js");

const archiveUrlSource = fs.readFileSync(ARCHIVE_URL_PATH, "utf8");
const settingsSource = fs.readFileSync(SETTINGS_JS_PATH, "utf8");

// No `document` in the sandbox -> settings.js's DOM-wiring branch is
// skipped (it early-returns after defining globalThis.SettingsLogic).
const sandbox = { URL };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(archiveUrlSource, sandbox, { filename: ARCHIVE_URL_PATH });
vm.runInContext(settingsSource, sandbox, { filename: SETTINGS_JS_PATH });

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

function eq(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => eq(v, b[i]));
  }
  return Object.is(a, b);
}

function check(name, actual, expected) {
  if (eq(actual, expected)) {
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

// --- add: valid domain -----------------------------------------------------

{
  const state = SettingsLogic.emptyState();
  const next = SettingsLogic.addDomain(state, "alwaysArchiveDomains", "example.com");
  check("add valid domain: added to alwaysArchiveDomains", next.alwaysArchiveDomains, [
    "example.com",
  ]);
  check("add valid domain: other list untouched", next.alwaysOriginalDomains, []);
  check("add valid domain: no error", next.error, null);
  check("add valid domain: no notice", next.notice, null);
}

// --- add: full URL gets normalized -----------------------------------------

{
  const state = SettingsLogic.emptyState();
  const next = SettingsLogic.addDomain(
    state,
    "alwaysOriginalDomains",
    "HTTPS://WWW.Example.COM:443/foo/bar?x=1#y"
  );
  check("add full URL: normalized into alwaysOriginalDomains", next.alwaysOriginalDomains, [
    "example.com",
  ]);
  check("add full URL: no error", next.error, null);
}

// --- add: duplicate is a no-op with a friendly notice -----------------------
// Policy chosen: adding a domain already present in the *same* list leaves
// the list unchanged (no duplicate entry) and surfaces a friendly
// "already in this list" notice (state.notice), not an error.

{
  let state = SettingsLogic.emptyState();
  state = SettingsLogic.addDomain(state, "alwaysArchiveDomains", "example.com");
  const next = SettingsLogic.addDomain(state, "alwaysArchiveDomains", "example.com");
  check("add duplicate: list unchanged", next.alwaysArchiveDomains, ["example.com"]);
  check("add duplicate: no error", next.error, null);
  assertTrue(
    "add duplicate: friendly notice mentions 'already'",
    typeof next.notice === "string" && next.notice.toLowerCase().includes("already")
  );
}

// --- add: invalid input -> error path, state unchanged ---------------------

{
  const state = SettingsLogic.emptyState();
  const next = SettingsLogic.addDomain(state, "alwaysArchiveDomains", "!!!not a domain!!!");
  check("add invalid: alwaysArchiveDomains unchanged", next.alwaysArchiveDomains, []);
  check("add invalid: alwaysOriginalDomains unchanged", next.alwaysOriginalDomains, []);
  assertTrue("add invalid: error is set", typeof next.error === "string" && next.error.length > 0);
  check("add invalid: no notice", next.notice, null);
}

{
  // Also cover whitespace-only and empty-string invalid input.
  const state = SettingsLogic.emptyState();
  const next = SettingsLogic.addDomain(state, "alwaysArchiveDomains", "   ");
  check("add invalid (whitespace only): list unchanged", next.alwaysArchiveDomains, []);
  assertTrue("add invalid (whitespace only): error is set", typeof next.error === "string");
}

// --- remove ------------------------------------------------------------------

{
  let state = SettingsLogic.emptyState();
  state = SettingsLogic.addDomain(state, "alwaysArchiveDomains", "example.com");
  state = SettingsLogic.addDomain(state, "alwaysArchiveDomains", "other.com");
  const next = SettingsLogic.removeDomain(state, "alwaysArchiveDomains", "example.com");
  check("remove: entry removed", next.alwaysArchiveDomains, ["other.com"]);
}

{
  // Removing a domain not present is a harmless no-op.
  let state = SettingsLogic.emptyState();
  state = SettingsLogic.addDomain(state, "alwaysArchiveDomains", "example.com");
  const next = SettingsLogic.removeDomain(state, "alwaysArchiveDomains", "missing.com");
  check("remove: no-op for absent domain", next.alwaysArchiveDomains, ["example.com"]);
}

// --- add to list A a domain already on list B -> moves + notice ------------

{
  let state = SettingsLogic.emptyState();
  state = SettingsLogic.addDomain(state, "alwaysOriginalDomains", "paidsite.com");
  const next = SettingsLogic.addDomain(state, "alwaysArchiveDomains", "paidsite.com");
  check("mutual exclusivity: added to alwaysArchiveDomains", next.alwaysArchiveDomains, [
    "paidsite.com",
  ]);
  check("mutual exclusivity: removed from alwaysOriginalDomains", next.alwaysOriginalDomains, []);
  assertTrue(
    "mutual exclusivity: notice flag set and mentions moved",
    typeof next.notice === "string" && next.notice.toLowerCase().includes("moved")
  );
  check("mutual exclusivity: no error", next.error, null);
}

{
  // And the reverse direction.
  let state = SettingsLogic.emptyState();
  state = SettingsLogic.addDomain(state, "alwaysArchiveDomains", "freesite.com");
  const next = SettingsLogic.addDomain(state, "alwaysOriginalDomains", "freesite.com");
  check(
    "mutual exclusivity (reverse): added to alwaysOriginalDomains",
    next.alwaysOriginalDomains,
    ["freesite.com"]
  );
  check(
    "mutual exclusivity (reverse): removed from alwaysArchiveDomains",
    next.alwaysArchiveDomains,
    []
  );
  assertTrue(
    "mutual exclusivity (reverse): notice flag set",
    typeof next.notice === "string" && next.notice.toLowerCase().includes("moved")
  );
}

// --- self-heal on load: domain in both lists -> kept in alwaysOriginalDomains

{
  const dirtyState = {
    alwaysArchiveDomains: ["example.com", "other.com"],
    alwaysOriginalDomains: ["example.com", "paid.com"],
    notice: null,
    error: null,
  };
  const healed = SettingsLogic.selfHeal(dirtyState);
  check(
    "self-heal: dropped from alwaysArchiveDomains",
    healed.alwaysArchiveDomains,
    ["other.com"]
  );
  check(
    "self-heal: kept in alwaysOriginalDomains",
    healed.alwaysOriginalDomains,
    ["example.com", "paid.com"]
  );
}

{
  // No overlap -> selfHeal is a no-op.
  const cleanState = {
    alwaysArchiveDomains: ["a.com"],
    alwaysOriginalDomains: ["b.com"],
    notice: null,
    error: null,
  };
  const healed = SettingsLogic.selfHeal(cleanState);
  check("self-heal: no-op when no overlap (archive list)", healed.alwaysArchiveDomains, ["a.com"]);
  check("self-heal: no-op when no overlap (original list)", healed.alwaysOriginalDomains, ["b.com"]);
}

// --- summary -----------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
