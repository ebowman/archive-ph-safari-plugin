#!/usr/bin/env node
// Zero-dependency fixture test for extension/snapshot-probe.js's pure
// extraction function (SnapshotProbe.extractFromDocument). Loads
// archive-url.js then snapshot-probe.js into a single vm context (mirroring
// how the manifest orders them as content scripts), and drives
// extractFromDocument with minimal duck-typed fake "document" objects --
// no jsdom -- exposing only querySelectorAll/querySelector returning stub
// elements with value/href/getAttribute, matching what snapshot-probe.js
// actually calls.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ARCHIVE_URL_PATH = path.join(__dirname, "..", "extension", "archive-url.js");
const SNAPSHOT_PROBE_PATH = path.join(__dirname, "..", "extension", "snapshot-probe.js");

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

// --- load archive-url.js + snapshot-probe.js into one sandbox ------------
//
// snapshot-probe.js's thin wiring only runs when `typeof document !==
// "undefined"`, so this sandbox deliberately omits `document` (and
// `browser`/`chrome`) -- the file loads without attempting to message
// anything, leaving only the pure SnapshotProbe global to drive directly.

const sandbox = { URL, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const archiveUrlSource = fs.readFileSync(ARCHIVE_URL_PATH, "utf8");
vm.runInContext(archiveUrlSource, sandbox, { filename: ARCHIVE_URL_PATH });

const snapshotProbeSource = fs.readFileSync(SNAPSHOT_PROBE_PATH, "utf8");
vm.runInContext(snapshotProbeSource, sandbox, { filename: SNAPSHOT_PROBE_PATH });

const SnapshotProbe = sandbox.SnapshotProbe;
if (!SnapshotProbe || typeof SnapshotProbe.extractFromDocument !== "function") {
  console.error(
    "FAIL: extension/snapshot-probe.js did not define globalThis.SnapshotProbe.extractFromDocument"
  );
  process.exit(1);
}

// --- fake DOM builders -----------------------------------------------------

// A minimal duck-typed stub for an <input> element: value + attribute
// lookups snapshot-probe.js's nearbyLabelText() and isPlausibleOriginal()
// actually read. readOnly defaults to false to mirror a real <input>
// element's default DOM property (fixtures that don't care about the
// readonly tier don't need to set it).
function fakeInput({ value, placeholder, ariaLabel, title, name, id, readOnly = false } = {}) {
  const attrs = {
    placeholder,
    "aria-label": ariaLabel,
    title,
    name,
    id,
  };
  return {
    value,
    readOnly,
    getAttribute(attr) {
      return attrs[attr] || null;
    },
  };
}

// A minimal duck-typed stub for an <a> element.
function fakeAnchor(href) {
  return {
    getAttribute(attr) {
      return attr === "href" ? href : null;
    },
  };
}

// A minimal duck-typed stub for a <meta>/<link> element.
function fakeMeta(attrName, value) {
  return {
    getAttribute(attr) {
      return attr === attrName ? value : null;
    },
  };
}

// Builds a fake document exposing querySelectorAll("input"),
// querySelectorAll("a"), querySelector('meta[property="og:url"]'), and
// querySelector('link[rel="canonical"]') -- the exact selector strings
// snapshot-probe.js uses.
function fakeDocument({ inputs = [], anchors = [], ogUrl = null, canonical = null } = {}) {
  return {
    querySelectorAll(selector) {
      if (selector === "input") return inputs;
      if (selector === "a") return anchors;
      return [];
    },
    querySelector(selector) {
      if (selector === 'meta[property="og:url"]') {
        return ogUrl !== null ? fakeMeta("content", ogUrl) : null;
      }
      if (selector === 'link[rel="canonical"]') {
        return canonical !== null ? fakeMeta("href", canonical) : null;
      }
      return null;
    },
  };
}

const MIRROR = "https://archive.ph";

// --- cases -------------------------------------------------------------

function testRedirectedFromWinsOverSavedFromWithTracking() {
  const doc = fakeDocument({
    inputs: [
      fakeInput({
        value: "https://www.ft.com/content/abc?syn-tracking=1",
        placeholder: "Saved from",
      }),
      fakeInput({
        value: "https://www.ft.com/content/abc",
        placeholder: "Redirected from",
      }),
    ],
  });
  check(
    "redirected-from wins over saved-from with tracking param",
    SnapshotProbe.extractFromDocument(doc),
    "https://www.ft.com/content/abc"
  );
}

function testSavedFromUsedWhenOnlyPresent() {
  const doc = fakeDocument({
    inputs: [fakeInput({ value: "https://www.ft.com/content/xyz", placeholder: "Saved from" })],
  });
  check(
    "saved-from used when it's the only labeled candidate",
    SnapshotProbe.extractFromDocument(doc),
    "https://www.ft.com/content/xyz"
  );
}

function testHeaderAnchorUsedWhenNoInputs() {
  const doc = fakeDocument({
    inputs: [],
    anchors: [fakeAnchor("https://example.com/article")],
  });
  check(
    "header anchor used when no plausible input candidates exist",
    SnapshotProbe.extractFromDocument(doc),
    "https://example.com/article"
  );
}

function testOnlyMirrorHostUrlsYieldsNull() {
  const doc = fakeDocument({
    inputs: [fakeInput({ value: "https://archive.ph/newest/foo", placeholder: "Saved from" })],
    anchors: [fakeAnchor("https://archive.today/some/path")],
    ogUrl: "https://archive.is/AbC12",
    canonical: "https://archive.md/AbC12",
  });
  check("only mirror-host URLs present -> null", SnapshotProbe.extractFromDocument(doc), null);
}

function testGarbageValuesYieldNull() {
  const doc = fakeDocument({
    inputs: [
      fakeInput({ value: "not a url", placeholder: "Redirected from" }),
      fakeInput({ value: "javascript:alert(1)", placeholder: "Saved from" }),
      fakeInput({ value: "", placeholder: "Saved from" }),
      fakeInput({ value: undefined }),
    ],
    anchors: [fakeAnchor("ftp://example.com/file"), fakeAnchor(null)],
  });
  check("garbage values -> null", SnapshotProbe.extractFromDocument(doc), null);
}

// --- extra coverage beyond the bead's explicit list --------------------

function testUnlabeledInputFallsBackToFirstPlausibleInDomOrder() {
  const doc = fakeDocument({
    inputs: [
      fakeInput({ value: "https://example.com/first" }),
      fakeInput({ value: "https://example.com/second" }),
    ],
  });
  check(
    "unlabeled inputs fall back to first plausible candidate in DOM order",
    SnapshotProbe.extractFromDocument(doc),
    "https://example.com/first"
  );
}

function testMetaOgUrlFallbackWhenNoInputsOrAnchors() {
  const doc = fakeDocument({ ogUrl: "https://example.com/og" });
  check(
    "og:url meta fallback used when no inputs/anchors match",
    SnapshotProbe.extractFromDocument(doc),
    "https://example.com/og"
  );
}

function testMetaCanonicalFallbackWhenNoOgUrl() {
  const doc = fakeDocument({ canonical: "https://example.com/canonical" });
  check(
    "rel=canonical fallback used when og:url absent",
    SnapshotProbe.extractFromDocument(doc),
    "https://example.com/canonical"
  );
}

function testMirrorHostAnchorSkippedInFavorOfLaterNonMirrorAnchor() {
  const doc = fakeDocument({
    anchors: [fakeAnchor("https://archive.ph/newest/foo"), fakeAnchor("https://example.com/real")],
  });
  check(
    "mirror-host anchor skipped, later non-mirror anchor used",
    SnapshotProbe.extractFromDocument(doc),
    "https://example.com/real"
  );
}

function testMirrorSubdomainRejectedByPlausibilityCheck() {
  const doc = fakeDocument({
    inputs: [fakeInput({ value: "https://sub.archive.ph/newest/foo", placeholder: "Saved from" })],
  });
  check(
    "mirror subdomain input value rejected as implausible",
    SnapshotProbe.extractFromDocument(doc),
    null
  );
}

function testEmptyDocumentYieldsNull() {
  const doc = fakeDocument();
  check("completely empty document -> null", SnapshotProbe.extractFromDocument(doc), null);
}

// --- real archive.today DOM shape (bead otu, live-verified 2026-08-10) -----

// Models the actual snapshot-page markup: the "Saved from" box is
// input[name=q] carrying a ?syn- tracking param and is NOT readonly; the
// "Redirected from" box is an attribute-less READONLY input with the clean
// URL (no placeholder/aria-label/title, name/id absent -- label association
// can't find it); SHARE_SHORTLINK/SHARE_LONGLINK/SHARE_MARKDOWN inputs carry
// archive.today mirror URLs (already filtered out by isPlausibleOriginal);
// and the FT article's own on-page search inputs are empty. Expects the
// clean, readonly URL to win via the new readonly tier -- neither label tier
// matches on this real shape, so without the readonly tier this would fall
// back to DOM order and return the tracking-decorated variant.
function testRealArchiveTodayDomShapePrefersReadonlyCleanUrl() {
  const doc = fakeDocument({
    inputs: [
      fakeInput({ value: "https://www.ft.com/content/abc?syn-tracking=1", name: "q" }),
      fakeInput({ value: "https://www.ft.com/content/abc", readOnly: true }),
      fakeInput({ value: "https://archive.ph/f0rxt", name: "SHARE_SHORTLINK" }),
      fakeInput({ value: "https://archive.ph/f0rxt/https://www.ft.com/content/abc", name: "SHARE_LONGLINK" }),
      fakeInput({ value: "[archived]", name: "SHARE_MARKDOWN" }),
      fakeInput({ value: "" }),
      fakeInput({ value: "" }),
    ],
  });
  check(
    "real archive.today DOM shape: readonly clean URL wins over ?syn- tracking variant",
    SnapshotProbe.extractFromDocument(doc),
    "https://www.ft.com/content/abc"
  );
}

// Pins tier order: a labeled "redirected from" input that is NOT readonly
// must still beat a readonly input with no label, confirming the label
// tiers are checked before the readonly tier.
function testLabeledRedirectedFromBeatsUnlabeledReadonly() {
  const doc = fakeDocument({
    inputs: [
      fakeInput({ value: "https://www.ft.com/content/readonly-variant", readOnly: true }),
      fakeInput({
        value: "https://www.ft.com/content/labeled-variant",
        placeholder: "Redirected from",
        readOnly: false,
      }),
    ],
  });
  check(
    "labeled redirected-from input (non-readonly) beats an unlabeled readonly input",
    SnapshotProbe.extractFromDocument(doc),
    "https://www.ft.com/content/labeled-variant"
  );
}

// --- run all cases ---------------------------------------------------------

testRedirectedFromWinsOverSavedFromWithTracking();
testSavedFromUsedWhenOnlyPresent();
testHeaderAnchorUsedWhenNoInputs();
testOnlyMirrorHostUrlsYieldsNull();
testGarbageValuesYieldNull();
testUnlabeledInputFallsBackToFirstPlausibleInDomOrder();
testMetaOgUrlFallbackWhenNoInputsOrAnchors();
testMetaCanonicalFallbackWhenNoOgUrl();
testMirrorHostAnchorSkippedInFavorOfLaterNonMirrorAnchor();
testMirrorSubdomainRejectedByPlausibilityCheck();
testEmptyDocumentYieldsNull();
testRealArchiveTodayDomShapePrefersReadonlyCleanUrl();
testLabeledRedirectedFromBeatsUnlabeledReadonly();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
