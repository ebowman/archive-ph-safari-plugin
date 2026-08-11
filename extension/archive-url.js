// Pure URL helpers shared by background.js and (in a later bead) the
// settings page. No browser APIs are touched here so this file can be
// loaded standalone under plain node for testing.
//
// Wrapped in an IIFE so only globalThis.ArchiveUrl escapes this file's
// scope: Safari loads archive-url.js as a sibling <script> alongside
// background.js (and, in other contexts, settings.js / snapshot-probe.js),
// all sharing ONE top-level lexical scope. An unwrapped top-level const
// here (e.g. MIRRORS) would collide with any same-named top-level
// declaration in a sibling script and throw "Can't create duplicate
// variable", killing the whole shared scope (see bead 9k9).
(function () {

// Mirror domains in order of preference; archive.ph is tried first since
// it's the canonical/most commonly used mirror.
const MIRRORS = [
  "https://archive.ph",
  "https://archive.today",
  "https://archive.fo",
  "https://archive.is",
  "https://archive.li",
  "https://archive.md",
  "https://archive.vn",
];

// Hostnames of the mirrors above, used for membership checks without
// re-parsing the MIRRORS URLs on every call.
const MIRROR_HOSTS = MIRRORS.map((m) => new URL(m).hostname);

// Returns true iff url's host is one of the archive.ph mirror hosts.
// Returns false (not throws) for unparseable input.
function isArchiveUrl(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch (e) {
    return false;
  }
  return MIRROR_HOSTS.includes(host);
}

// Archive mirror paths look like one of:
//   /newest/<original-url>
//   /wip/<original-url>
//   /<14-digit-timestamp>/<original-url>
//   /<short-code>/<original-url>
//   /o/<short-code>/<original-url>
// In every case the original URL is embedded verbatim (not encoded) after
// some path prefix. Find the first embedded http:// or https:// occurrence
// in the path and return everything from there, decoding %23 back to '#'
// (the inverse of the '#'->'%23' encoding buildArchiveUrl applies). Returns
// null for non-archive hosts, bare short-code paths with no embedded URL,
// and embedded non-http(s) schemes (e.g. javascript:).
function extractOriginalUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return null;
  }

  if (!MIRROR_HOSTS.includes(parsed.hostname)) return null;

  // Search the raw path+query+hash (not just pathname) since a short code
  // could theoretically be followed by an embedded URL containing its own
  // query string that the URL parser has already split off.
  const rest = parsed.pathname + parsed.search + parsed.hash;

  const match = rest.match(/https?:\/\//);
  if (!match) return null;

  const embedded = rest.slice(match.index);

  // Guard against a non-http(s) scheme appearing earlier in the path that
  // would make this an invalid extraction target (e.g. .../javascript:...).
  // Since we search for http(s):// directly this can't actually happen for
  // the embedded URL itself, but confirm the result parses as http(s).
  const decoded = embedded.replaceAll("%23", "#");
  try {
    const embeddedProtocol = new URL(decoded).protocol;
    if (embeddedProtocol !== "http:" && embeddedProtocol !== "https:") {
      return null;
    }
  } catch (e) {
    return null;
  }

  return decoded;
}

// Builds a "newest" archive URL for the given mirror base and original url.
// Percent-encodes only '#' so a URL fragment isn't swallowed as the archive
// page's own fragment; everything else is appended raw since archive.ph
// expects an un-encoded URL.
function buildArchiveUrl(mirrorBase, url) {
  const safeUrl = url.replaceAll("#", "%23");
  return `${mirrorBase}/newest/${safeUrl}`;
}

// Normalizes a user-entered domain for settings storage/comparison: trims
// whitespace, lowercases, strips a leading scheme (e.g. "https://"), strips
// any path/query/hash, strips a trailing port, strips trailing dots, and
// strips a leading "www.". Returns null when the result is empty or not a
// plausible domain (no dot, or contains whitespace/invalid characters).
function normalizeDomain(input) {
  if (typeof input !== "string") return null;

  let value = input.trim().toLowerCase();
  if (!value) return null;

  // Strip a leading scheme if present (e.g. "https://example.com").
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");

  // Strip any path/query/hash by keeping only the authority segment.
  value = value.split(/[/?#]/)[0];

  // Strip userinfo if present (e.g. "user@example.com"). split() always
  // returns a non-empty array so pop() can't actually be undefined here;
  // the `?? value` fallback just satisfies the type checker (TS7 can't
  // infer split()'s result is non-empty) without changing behavior.
  value = value.split("@").pop() ?? value;

  // Strip a trailing port (e.g. "example.com:8080"), but not IPv6 brackets.
  if (!value.startsWith("[")) {
    value = value.replace(/:\d+$/, "");
  }

  // Strip trailing dots (e.g. "example.com.").
  value = value.replace(/\.+$/, "");

  // Strip a single leading "www.".
  value = value.replace(/^www\./, "");

  if (!value) return null;

  // Must look like a plausible domain: no whitespace, at least one dot,
  // and only characters valid in a hostname label.
  if (/\s/.test(value)) return null;
  if (!/^[a-z0-9.-]+$/.test(value)) return null;
  if (!value.includes(".")) return null;
  if (value.startsWith(".") || value.startsWith("-")) return null;

  return value;
}

// Returns true if url's host is exactly domain, or is a subdomain of it
// (host ends with '.' + domain). Returns false for unparseable input.
function urlMatchesDomain(url, domain) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (e) {
    return false;
  }
  const d = domain.toLowerCase();
  return host === d || host.endsWith("." + d);
}

// Returns true iff url's host is one of the archive.ph mirror hosts, OR a
// subdomain of one (e.g. https://news.archive.is/x). Broader than
// isArchiveUrl (which is exact-host only): this is the check to use at
// trust boundaries where a reported/candidate URL must be confirmed to NOT
// be a mirror-hosted page in any form, mirror subdomains included. Shared
// by snapshot-probe.js's isPlausibleOriginal and background.js's
// handleSnapshotOriginalMessage so both sides of that boundary agree on
// exactly the same definition of "is a mirror host". Returns false for
// unparseable input (urlMatchesDomain's own contract).
function isMirrorHostUrl(url) {
  return MIRROR_HOSTS.some((mirrorHost) => urlMatchesDomain(url, mirrorHost));
}

globalThis.ArchiveUrl = {
  MIRRORS,
  isArchiveUrl,
  extractOriginalUrl,
  buildArchiveUrl,
  normalizeDomain,
  urlMatchesDomain,
  isMirrorHostUrl,
};

})();
