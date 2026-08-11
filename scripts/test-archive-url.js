#!/usr/bin/env node
// Zero-dependency fixture test for extension/archive-url.js. Loads the
// extension source into a vm context (it assigns to globalThis, not
// module.exports, since it's a plain browser script) and runs a table of
// input/expected-output cases against each exported function.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SOURCE_PATH = path.join(__dirname, "..", "extension", "archive-url.js");
const source = fs.readFileSync(SOURCE_PATH, "utf8");

// archive-url.js is a plain browser script (no requires/exports) that
// relies on the ambient URL global; vm.createContext() sandboxes start
// empty, so seed it with node's URL implementation.
const sandbox = { URL };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: SOURCE_PATH });

const ArchiveUrl = sandbox.ArchiveUrl;
if (!ArchiveUrl) {
  console.error("FAIL: extension/archive-url.js did not define globalThis.ArchiveUrl");
  process.exit(1);
}

let passed = 0;
let failed = 0;

// Deep-ish equality good enough for strings/nulls/arrays/booleans.
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

// --- MIRRORS ---------------------------------------------------------

check("MIRRORS starts with archive.ph", ArchiveUrl.MIRRORS[0], "https://archive.ph");
check("MIRRORS has 7 entries", ArchiveUrl.MIRRORS.length, 7);
check("MIRRORS order preserved", ArchiveUrl.MIRRORS, [
  "https://archive.ph",
  "https://archive.today",
  "https://archive.fo",
  "https://archive.is",
  "https://archive.li",
  "https://archive.md",
  "https://archive.vn",
]);

// --- isArchiveUrl ------------------------------------------------------

const mirrorHosts = [
  "archive.ph",
  "archive.today",
  "archive.fo",
  "archive.is",
  "archive.li",
  "archive.md",
  "archive.vn",
];
for (const host of mirrorHosts) {
  check(
    `isArchiveUrl recognizes ${host}`,
    ArchiveUrl.isArchiveUrl(`https://${host}/newest/https://example.com`),
    true
  );
}
check(
  "isArchiveUrl rejects non-mirror host",
  ArchiveUrl.isArchiveUrl("https://example.com/newest/https://example.com"),
  false
);
check("isArchiveUrl handles unparseable input", ArchiveUrl.isArchiveUrl("not a url"), false);

// --- extractOriginalUrl --------------------------------------------------

check(
  "extractOriginalUrl: newest/ form",
  ArchiveUrl.extractOriginalUrl("https://archive.ph/newest/https://example.com/page"),
  "https://example.com/page"
);
check(
  "extractOriginalUrl: wip/ form",
  ArchiveUrl.extractOriginalUrl("https://archive.today/wip/https://example.com/page"),
  "https://example.com/page"
);
check(
  "extractOriginalUrl: 14-digit timestamp form",
  ArchiveUrl.extractOriginalUrl("https://archive.ph/20240115120000/https://example.com/page"),
  "https://example.com/page"
);
check(
  "extractOriginalUrl: short-code/<url> form",
  ArchiveUrl.extractOriginalUrl("https://archive.ph/AbCdE/https://example.com/page"),
  "https://example.com/page"
);
check(
  "extractOriginalUrl: o/<code>/<url> form",
  ArchiveUrl.extractOriginalUrl("https://archive.ph/o/AbCdE/https://example.com/page"),
  "https://example.com/page"
);
check(
  "extractOriginalUrl: non-archive host -> null",
  ArchiveUrl.extractOriginalUrl("https://example.com/newest/https://example.com/page"),
  null
);
check(
  "extractOriginalUrl: bare short code, no embedded url -> null",
  ArchiveUrl.extractOriginalUrl("https://archive.ph/AbCdE"),
  null
);
check(
  "extractOriginalUrl: javascript: embedded scheme -> null",
  ArchiveUrl.extractOriginalUrl("https://archive.ph/newest/javascript:alert(1)"),
  null
);
check(
  "extractOriginalUrl: unparseable input -> null",
  ArchiveUrl.extractOriginalUrl("not a url"),
  null
);

// --- buildArchiveUrl + extractOriginalUrl round trip (# <-> %23) ---------

const originalWithFragment = "https://example.com/x#frag";
const built = ArchiveUrl.buildArchiveUrl("https://archive.ph", originalWithFragment);
check(
  "buildArchiveUrl encodes # as %23",
  built,
  "https://archive.ph/newest/https://example.com/x%23frag"
);
check(
  "extractOriginalUrl round-trips %23 back to #",
  ArchiveUrl.extractOriginalUrl(built),
  originalWithFragment
);

check(
  "buildArchiveUrl: no fragment, passthrough",
  ArchiveUrl.buildArchiveUrl("https://archive.ph", "https://example.com/plain"),
  "https://archive.ph/newest/https://example.com/plain"
);

// --- normalizeDomain -----------------------------------------------------

check("normalizeDomain: plain domain", ArchiveUrl.normalizeDomain("example.com"), "example.com");
check(
  "normalizeDomain: strips scheme",
  ArchiveUrl.normalizeDomain("https://example.com"),
  "example.com"
);
check(
  "normalizeDomain: strips scheme + path",
  ArchiveUrl.normalizeDomain("https://example.com/some/path?query=1#hash"),
  "example.com"
);
check(
  "normalizeDomain: strips port",
  ArchiveUrl.normalizeDomain("example.com:8080"),
  "example.com"
);
check(
  "normalizeDomain: strips trailing dot",
  ArchiveUrl.normalizeDomain("example.com."),
  "example.com"
);
check(
  "normalizeDomain: strips leading www.",
  ArchiveUrl.normalizeDomain("www.example.com"),
  "example.com"
);
check(
  "normalizeDomain: lowercases",
  ArchiveUrl.normalizeDomain("EXAMPLE.COM"),
  "example.com"
);
check(
  "normalizeDomain: trims whitespace",
  ArchiveUrl.normalizeDomain("  example.com  "),
  "example.com"
);
check("normalizeDomain: empty string -> null", ArchiveUrl.normalizeDomain(""), null);
check("normalizeDomain: whitespace only -> null", ArchiveUrl.normalizeDomain("   "), null);
check("normalizeDomain: garbage -> null", ArchiveUrl.normalizeDomain("!!!not a domain!!!"), null);
check(
  "normalizeDomain: no dot -> null",
  ArchiveUrl.normalizeDomain("localhost"),
  null
);
check(
  "normalizeDomain: combined scheme+www+path+port+trailing dot",
  ArchiveUrl.normalizeDomain("HTTPS://WWW.Example.COM:443/foo/bar."),
  "example.com"
);

// --- urlMatchesDomain ------------------------------------------------------

check(
  "urlMatchesDomain: exact match",
  ArchiveUrl.urlMatchesDomain("https://example.com/page", "example.com"),
  true
);
check(
  "urlMatchesDomain: subdomain match",
  ArchiveUrl.urlMatchesDomain("https://news.example.com/page", "example.com"),
  true
);
check(
  "urlMatchesDomain: no false positive on suffix-but-not-subdomain",
  ArchiveUrl.urlMatchesDomain("https://notexample.com/page", "example.com"),
  false
);
check(
  "urlMatchesDomain: unrelated domain",
  ArchiveUrl.urlMatchesDomain("https://other.com/page", "example.com"),
  false
);
check(
  "urlMatchesDomain: unparseable url -> false",
  ArchiveUrl.urlMatchesDomain("not a url", "example.com"),
  false
);

// --- isMirrorHostUrl (bead ut7) ---------------------------------------------

check(
  "isMirrorHostUrl: exact mirror host",
  ArchiveUrl.isMirrorHostUrl("https://archive.ph/newest/https://example.com"),
  true
);
check(
  "isMirrorHostUrl: mirror subdomain",
  ArchiveUrl.isMirrorHostUrl("https://news.archive.is/x"),
  true
);
check(
  "isMirrorHostUrl: non-mirror host",
  ArchiveUrl.isMirrorHostUrl("https://example.com/story"),
  false
);
check(
  "isMirrorHostUrl: suffix-but-not-subdomain is not a false positive",
  ArchiveUrl.isMirrorHostUrl("https://notarchive.ph/x"),
  false
);
check(
  "isMirrorHostUrl: unparseable url -> false",
  ArchiveUrl.isMirrorHostUrl("not a url"),
  false
);

// --- summary ---------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
