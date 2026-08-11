// Content script for archive.today mirror pages. Extracts the original
// article URL from a bare short-code snapshot page (e.g.
// https://archive.is/f0rxt) whose tab URL never carries the embedded
// original the way /newest/<url> or /o/<code>/<url> forms do (see bead
// 6kl.6). Reports the result to the background script so the toolbar
// toggle (6kl.2) and the auto-redirect engine (6kl.4) can still act on
// pages that would otherwise be a silent no-op.
//
// Extraction-tolerance strategy: the real archive.today page (verified via
// user screenshot, not fetchable here -- curl gets HTTP 429) renders labels
// like "Redirected from" and "Saved from" next to <input> elements in the
// page's top header/form area, but the exact markup (element ids, classes,
// nesting) is undocumented and could drift across archive.today's own
// front-end changes. Rather than hard-coding brittle selectors, this file:
//   1. Scans ALL <input> elements in the document for values that parse as
//      absolute http(s) URLs pointing at a non-mirror host (candidates).
//   2. Tries to associate each candidate with its nearby label text ("look
//      left/up" via a text-scan of the input's own attributes plus its
//      preceding sibling/container text) to identify "Redirected from" and
//      "Saved from" inputs specifically, without depending on precise DOM
//      structure.
//   3. Falls back, in order, to: any header <a> with an absolute http(s)
//      href to a non-mirror host, then og:url / rel=canonical meta/link
//      tags with a non-mirror http(s) value.
// This degrades gracefully: if archive.today's markup changes such that
// label association fails, candidates are still found by DOM order alone
// (first non-mirror http(s) input value wins), and if that also fails, the
// header-anchor and meta-tag fallbacks still have a shot. Total failure
// (interstitial/CAPTCHA page, or a genuinely different layout) yields null,
// which is the same no-op behavior as before this bead.

(function () {
  // --- pure extraction logic ------------------------------------------

  const SnapshotProbe = {};

  // Returns true iff rawUrl parses as an absolute http(s) URL whose host is
  // NOT one of the archive.today mirror hosts (ArchiveUrl.MIRRORS). Used to
  // filter extraction candidates down to plausible "original article"
  // URLs. Depends on the ArchiveUrl global (archive-url.js), which must be
  // loaded before this file -- see manifest.json's content_scripts order.
  function isPlausibleOriginal(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl) return false;
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (e) {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (typeof ArchiveUrl === "undefined") return false;
    // ArchiveUrl.isMirrorHostUrl checks exact-or-subdomain against every
    // mirror host; reject if the URL's host matches (or is a subdomain of)
    // ANY mirror host.
    return !ArchiveUrl.isMirrorHostUrl(rawUrl);
  }

  // Best-effort text used to associate an <input> with its label, gathered
  // from attributes commonly used to hold label-ish text plus (if present)
  // a duck-typed "previous element sibling" or container text hook. Tests
  // drive this with a minimal fake document, so this only reads
  // properties/methods a real DOM element also exposes.
  function nearbyLabelText(input) {
    const parts = [];
    if (typeof input.getAttribute === "function") {
      const attrCandidates = ["placeholder", "aria-label", "title", "name", "id"];
      for (const attr of attrCandidates) {
        const value = input.getAttribute(attr);
        if (value) parts.push(value);
      }
    }
    // Fake/real documents may expose a synthetic "labelText" hook for
    // fixtures that don't want to model full DOM traversal; harmless no-op
    // for a real DOM element, which simply won't have this property.
    if (typeof input.labelText === "string") parts.push(input.labelText);
    return parts.join(" ").toLowerCase();
  }

  // Scans all <input> elements in doc for the best original-URL candidate,
  // preferring one whose nearby label text mentions "redirected from" (a
  // clean URL with no tracking params) over one mentioning "saved from"
  // (often decorated with a tracking query string, e.g. "?syn-..."), then
  // falling back to the first READONLY plausible candidate, and finally to
  // first-in-DOM-order among any remaining plausible candidates. The
  // readonly tier exists because live inspection of the real archive.today
  // snapshot page (bead otu; see bd memory
  // archive-today-snapshot-page-dom-verified-live-2026) found that its
  // "Redirected from" box carries NO label-ish attribute at all
  // (placeholder/aria-label/title/name/id all absent or unhelpful --
  // name="q" is shared with the tracking-decorated "Saved from" input) and
  // is thus invisible to nearbyLabelText(); the only reliable marker
  // distinguishing it from the "Saved from" input on that real page is that
  // it is readonly. Returns null if no <input> yields a plausible
  // candidate.
  function extractFromInputs(doc) {
    if (!doc || typeof doc.querySelectorAll !== "function") return null;

    let inputs;
    try {
      inputs = Array.from(doc.querySelectorAll("input"));
    } catch (e) {
      return null;
    }

    let redirectedFromCandidate = null;
    let savedFromCandidate = null;
    let firstReadonlyCandidate = null;
    let firstPlausibleCandidate = null;

    for (const input of inputs) {
      const value = input && input.value;
      if (!isPlausibleOriginal(value)) continue;

      if (firstPlausibleCandidate === null) firstPlausibleCandidate = value;
      // Duck-typed: real DOM input elements always expose readOnly as a
      // boolean, but harness fixtures may omit the property entirely, so
      // require a strict === true rather than a truthy check.
      if (firstReadonlyCandidate === null && input && input.readOnly === true) {
        firstReadonlyCandidate = value;
      }

      const label = nearbyLabelText(input);
      if (redirectedFromCandidate === null && label.includes("redirected from")) {
        redirectedFromCandidate = value;
      } else if (savedFromCandidate === null && label.includes("saved from")) {
        savedFromCandidate = value;
      }
    }

    if (redirectedFromCandidate !== null) return redirectedFromCandidate;
    if (savedFromCandidate !== null) return savedFromCandidate;
    if (firstReadonlyCandidate !== null) return firstReadonlyCandidate;
    return firstPlausibleCandidate;
  }

  // Fallback: any <a> element (intended to be scoped to the page's header
  // area, but we don't rely on precise structure -- see file-level comment)
  // whose href is a plausible non-mirror http(s) URL. Returns the first
  // match in DOM order, or null.
  function extractFromHeaderAnchor(doc) {
    if (!doc || typeof doc.querySelectorAll !== "function") return null;

    let anchors;
    try {
      anchors = Array.from(doc.querySelectorAll("a"));
    } catch (e) {
      return null;
    }

    for (const anchor of anchors) {
      const href =
        typeof anchor.getAttribute === "function" ? anchor.getAttribute("href") : anchor.href;
      if (isPlausibleOriginal(href)) return href;
    }
    return null;
  }

  // Fallback: <meta property="og:url"> or <link rel="canonical"> carrying a
  // plausible non-mirror http(s) URL. Tries og:url first, then canonical.
  function extractFromMetaTags(doc) {
    if (!doc || typeof doc.querySelector !== "function") return null;

    try {
      const ogUrl = doc.querySelector('meta[property="og:url"]');
      if (ogUrl) {
        const content =
          typeof ogUrl.getAttribute === "function" ? ogUrl.getAttribute("content") : ogUrl.content;
        if (isPlausibleOriginal(content)) return content;
      }
    } catch (e) {
      // fall through to canonical
    }

    try {
      const canonical = doc.querySelector('link[rel="canonical"]');
      if (canonical) {
        const href =
          typeof canonical.getAttribute === "function"
            ? canonical.getAttribute("href")
            : canonical.href;
        if (isPlausibleOriginal(href)) return href;
      }
    } catch (e) {
      // no canonical either
    }

    return null;
  }

  // Pure entry point: runs the full extraction order against a document-like
  // object (real DOM Document or a duck-typed fake with querySelectorAll /
  // querySelector). Returns the original URL string, or null if nothing
  // plausible was found. No browser-messaging side effects here so this can
  // be driven directly by the node test harness.
  SnapshotProbe.extractFromDocument = function extractFromDocument(doc) {
    const fromInputs = extractFromInputs(doc);
    if (fromInputs !== null) return fromInputs;

    const fromAnchor = extractFromHeaderAnchor(doc);
    if (fromAnchor !== null) return fromAnchor;

    const fromMeta = extractFromMetaTags(doc);
    if (fromMeta !== null) return fromMeta;

    return null;
  };

  globalThis.SnapshotProbe = SnapshotProbe;

  // --- thin wiring: only runs in a real extension content-script context --

  if (typeof document !== "undefined") {
    const api = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : undefined;
    if (api && typeof api.runtime !== "undefined") {
      const originalUrl = SnapshotProbe.extractFromDocument(document);
      if (originalUrl) {
        try {
          api.runtime.sendMessage({ type: "snapshot-original", originalUrl });
        } catch (e) {
          // Messaging can throw/reject if the background page isn't ready
          // or the extension context is being torn down; nothing useful to
          // do about it here.
        }
      }
    }
  }
})();
