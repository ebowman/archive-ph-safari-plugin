// Safari loads background.scripts as separate <script> tags so ArchiveUrl
// is already a global by the time this file runs; Chrome's service_worker
// path loads only this one file, so pull archive-url.js in manually there.
if (typeof importScripts === "function" && typeof ArchiveUrl === "undefined") {
  importScripts("archive-url.js");
}

const api = typeof browser !== "undefined" ? browser : chrome;

// Mirror domains in order of preference; archive.ph is tried first since
// it's the canonical/most commonly used mirror. Lives in archive-url.js so
// the settings page and background script share one source of truth.
const MIRRORS = ArchiveUrl.MIRRORS;

// Returns true if the origin responds to an HTTP HEAD request at all, even
// with an error status (e.g. 429/503) -- that still means the host is up.
// Only network-level failures (DNS errors, connection refused, timeouts)
// count as unreachable.
async function reachable(origin) {
  try {
    await fetch(origin, { method: "HEAD", signal: AbortSignal.timeout(2500) });
    return true;
  } catch (e) {
    return false;
  }
}

// Sequentially probes mirrors in preference order and returns the first
// reachable one. If none are reachable, falls back to the first mirror
// (archive.ph) so a tab is still opened rather than doing nothing.
async function pickMirror() {
  for (const mirror of MIRRORS) {
    if (await reachable(mirror)) {
      return mirror;
    }
  }
  return MIRRORS[0];
}

// Reads the "open in a new tab" preference from storage.local, defaulting
// to true (current/legacy behavior) when unset or when storage is
// unavailable (e.g. in a test harness or an older browser build).
async function shouldUseNewTab() {
  if (!api.storage || !api.storage.local) return true;
  try {
    const { newTab } = await api.storage.local.get("newTab");
    return newTab !== false;
  } catch (e) {
    return true;
  }
}

// Returns true iff rawUrl parses with an http(s) scheme; used to guard
// tabs.update/tabs.create navigations against non-navigable schemes.
function isHttpUrl(rawUrl) {
  try {
    const protocol = new URL(rawUrl).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch (e) {
    return false;
  }
}

// Navigates to destUrl in tabId (reuse) or a new tab, per useNewTab, then
// records a manual override for whichever tab ends up displaying it
// (overrideUrl -- the original article URL in both the archive and
// de-archive directions). Awaits tabs.create's resolved tab so the override
// is recorded against the new tab's id, not the triggering tab's id.
async function navigateAndRecord(destUrl, overrideUrl, { tabId, useNewTab }) {
  if (!useNewTab && tabId !== undefined && tabId !== null) {
    api.tabs.update(tabId, { url: destUrl });
    recordManualOverride(tabId, overrideUrl);
  } else {
    const created = await api.tabs.create({ url: destUrl });
    recordManualOverride(created && created.id, overrideUrl);
  }
}

// options.tabId: the id of the tab the action was triggered from, used to
// update that tab in place when the "reuse current tab" setting is on.
// options.forceNewTab: when true, always opens a new tab regardless of the
// setting -- used for context-menu link archiving, where reusing the
// current tab would destroy the page the user is reading in order to show
// an archive of a *different* URL (the link's target, not the page itself).
// Records a manual override for the tab that ends up displaying the
// archive, keyed by the *original* rawUrl's domain (see manualOverrides).
async function openArchive(rawUrl, { tabId, forceNewTab = false } = {}) {
  if (!rawUrl) return;
  if (!isHttpUrl(rawUrl)) return;

  const base = await pickMirror();
  const archiveUrl = ArchiveUrl.buildArchiveUrl(base, rawUrl);

  const useNewTab = forceNewTab || (await shouldUseNewTab());

  await navigateAndRecord(archiveUrl, rawUrl, { tabId, useNewTab });
}

// Callers treat this as fire-and-forget; ensure rejections never surface
// as unhandled promise rejections.
function openArchiveSafe(rawUrl, options) {
  openArchive(rawUrl, options).catch(() => {});
}

// Per-tab registry of domains the user has manually toggled (archived or
// de-archived) in that tab, keyed by tab id. Consumed by the auto-redirect
// engine (bead 6kl.4) via recordManualOverride/hasManualOverride below, so
// it never fights a manual choice; nothing reads it yet in this bead.
const manualOverrides = new Map();

// Normalizes rawUrl's host via ArchiveUrl.normalizeDomain, returning null
// for unparseable input or hosts that don't normalize to a domain.
function domainOf(rawUrl) {
  try {
    return ArchiveUrl.normalizeDomain(new URL(rawUrl).hostname);
  } catch (e) {
    return null;
  }
}

// Records that tabId now manually displays (or was manually navigated away
// from) rawUrl's domain, so future auto-redirects in that tab should defer
// to the user's choice instead of overriding it.
function recordManualOverride(tabId, rawUrl) {
  if (tabId === undefined || tabId === null) return;
  const domain = domainOf(rawUrl);
  if (!domain) return;

  let domains = manualOverrides.get(tabId);
  if (!domains) {
    domains = new Set();
    manualOverrides.set(tabId, domains);
  }
  domains.add(domain);
}

// Returns true if tabId has a recorded manual override matching rawUrl's
// domain (exact or subdomain, per ArchiveUrl.urlMatchesDomain).
function hasManualOverride(tabId, rawUrl) {
  const domains = manualOverrides.get(tabId);
  if (!domains) return false;
  for (const domain of domains) {
    if (ArchiveUrl.urlMatchesDomain(rawUrl, domain)) return true;
  }
  return false;
}

// Exposed on globalThis so bead 6kl.4's auto-redirect engine can call these
// without a module system, and so scripts/test-background.js can assert
// against the registry directly; nothing in this file reads them back off
// globalThis (they're used as plain in-scope functions above).
globalThis.recordManualOverride = recordManualOverride;
globalThis.hasManualOverride = hasManualOverride;

// De-archives tab.url (an archive.ph/mirror page) by navigating to the
// original article URL, honoring the existing newTab setting the same way
// openArchive does. Records the manual override against whichever tab ends
// up displaying the original (the reused tab, or the freshly created one).
async function deArchive(originalUrl, { tabId } = {}) {
  // extractOriginalUrl's contract guarantees an http(s) scheme, but guard
  // anyway before navigating, mirroring openArchive's own check.
  if (!isHttpUrl(originalUrl)) return;

  const useNewTab = await shouldUseNewTab();

  await navigateAndRecord(originalUrl, originalUrl, { tabId, useNewTab });
}

// Fire-and-forget wrapper matching openArchiveSafe's rejection-swallowing.
function deArchiveSafe(originalUrl, options) {
  deArchive(originalUrl, options).catch(() => {});
}

api.action.onClicked.addListener((tab) => {
  if (!tab || !tab.url) return;

  if (ArchiveUrl.isArchiveUrl(tab.url)) {
    const original = ArchiveUrl.extractOriginalUrl(tab.url);
    // Bare short-code archive URLs (mid-redirect, no embedded original)
    // can't be de-archived; accepted limitation -- do nothing.
    if (original) {
      deArchiveSafe(original, { tabId: tab.id });
    }
    return;
  }

  openArchiveSafe(tab.url, { tabId: tab.id });
});

// ---------------------------------------------------------------------------
// Auto-redirect engine (bead 6kl.4)
//
// Watches navigations via tabs.onUpdated and applies the always-archive /
// always-original domain lists configured on the settings page, without
// fighting a manual toggle-click (see hasManualOverride above) or looping
// on its own redirects (see the engine-initiated marker below).
// ---------------------------------------------------------------------------

// Per-tab marker recording the URL the engine itself just navigated a tab
// to, so the tabs.onUpdated listener can recognize its own redirect and not
// re-evaluate the rules against it. Populated immediately before each
// engine-initiated tabs.update, consumed (deleted) the first time
// onUpdated reports a matching changeInfo.url for that tab, and cleared on
// tabs.onRemoved alongside manualOverrides (see the shared listener below).
//
// Exact-match tradeoff: archive.ph itself may internally redirect the tab
// through further URL changes after we land it on our target (e.g. its own
// "wip" -> permanent snapshot transition), which would arrive as additional
// onUpdated events that no longer equal the recorded marker exactly. A
// prefix match would catch those too, but risks false positives (matching
// an unrelated URL that happens to share a prefix, e.g. a query-string
// variant of a completely different page). We accept the exact-match's
// narrower coverage -- worst case a rare follow-up redirect is briefly
// re-evaluated by the rules below, which is not fought since domain-list
// mutual exclusivity plus this same marker mechanism keep it from
// looping (see the loop analysis at the bottom of this section).
const engineMarkers = new Map();

// Records that tabId is about to be navigated by the engine itself to
// targetUrl, so the onUpdated listener below can consume-and-ignore the
// resulting event instead of treating it as a fresh user navigation.
function markEngineNavigation(tabId, targetUrl) {
  if (tabId === undefined || tabId === null) return;
  engineMarkers.set(tabId, targetUrl);
}

// Shared cleanup: both the manual-override registry and the engine-marker
// map are keyed by tab id and become stale the moment a tab closes.
api.tabs.onRemoved.addListener((tabId) => {
  manualOverrides.delete(tabId);
  engineMarkers.delete(tabId);
});

// Reads a domain list from storage.local, returning [] on a missing key,
// a non-array value, or a rejected read (e.g. storage unavailable in some
// embedding) -- the engine must never throw or block navigation on a
// storage hiccup.
async function readDomainList(key) {
  if (!api.storage || !api.storage.local) return [];
  try {
    const result = await api.storage.local.get(key);
    return Array.isArray(result[key]) ? result[key] : [];
  } catch (e) {
    return [];
  }
}

// Returns true if rawUrl's host matches (exactly or as a subdomain of) any
// entry in domains.
function matchesAnyDomain(rawUrl, domains) {
  return domains.some((domain) => ArchiveUrl.urlMatchesDomain(rawUrl, domain));
}

// Applies the de-archive and archive rules to a single tabs.onUpdated
// navigation event. Both rules read fresh storage.local state each call
// (no caching layer in this bead -- storage.local reads are cheap and the
// lists change rarely, so staleness is a bigger risk than the extra read).
async function applyAutoRedirectRules(tabId, url) {
  const [alwaysArchiveDomains, alwaysOriginalDomains] = await Promise.all([
    readDomainList("alwaysArchiveDomains"),
    readDomainList("alwaysOriginalDomains"),
  ]);

  if (ArchiveUrl.isArchiveUrl(url)) {
    // De-archive rule: an archive URL whose embedded original belongs to a
    // domain the user always wants to read directly -> bounce to the
    // original. Always same tab: this is an automatic redirect *correction*
    // (undoing a redirect the user or a link pushed them into), not a user
    // action opening a fresh archive, so the newTab setting -- which only
    // governs user-initiated archive/de-archive actions -- deliberately
    // does not apply here.
    const original = ArchiveUrl.extractOriginalUrl(url);
    if (!original) return;
    if (!matchesAnyDomain(original, alwaysOriginalDomains)) return;
    // Defensive: if the original's domain is ALSO on alwaysArchiveDomains
    // (should be impossible given 6kl.3's mutual-exclusivity enforcement,
    // but storage can be hand-edited or corrupted), refuse to fire rather
    // than redirect to a page rule (b) would immediately archive again.
    if (matchesAnyDomain(original, alwaysArchiveDomains)) return;

    markEngineNavigation(tabId, original);
    api.tabs.update(tabId, { url: original });
    return;
  }

  // Archive rule: a normal page on a domain the user always wants archived
  // -> redirect to its archive.ph "newest" URL. Uses MIRRORS[0] (archive.ph)
  // directly rather than pickMirror(): pickMirror's sequential HEAD probes
  // across up to 7 mirrors are fine for a single deliberate click, but far
  // too slow/chatty to run on every navigation event in a listed domain;
  // the manual toolbar-click path (openArchive) keeps pickMirror.
  if (!matchesAnyDomain(url, alwaysArchiveDomains)) return;

  // Defensive (6kl.3 review finding): the settings page accepts archive.ph
  // / mirror hosts as list entries since the lists are inert there. Here
  // they are not inert, so guard against a mirror host ending up in
  // alwaysArchiveDomains -- naively archiving it would target the archive
  // site itself. The produced URL would still be recognized as an archive
  // URL by isArchiveUrl, so rule (b) would not fire again on the next
  // event, but it would still waste a redirect and send the user to a
  // nonsensical "archive of archive.ph" page. Skip any matching mirror host
  // entirely.
  const archivesAMirror = alwaysArchiveDomains.some((domain) =>
    ArchiveUrl.MIRRORS.some((mirror) => ArchiveUrl.urlMatchesDomain(mirror, domain))
  );
  if (archivesAMirror && matchesAnyDomain(url, alwaysArchiveDomains)) {
    // Re-check with mirror entries excluded: a list can legitimately
    // contain both a mirror host (to be ignored) and real article domains
    // (to be honored), so only skip when url's OWN matching domain is
    // itself a mirror host, not the whole rule for the whole list.
    const nonMirrorDomains = alwaysArchiveDomains.filter(
      (domain) => !ArchiveUrl.MIRRORS.some((mirror) => ArchiveUrl.urlMatchesDomain(mirror, domain))
    );
    if (!matchesAnyDomain(url, nonMirrorDomains)) return;
  }

  const archiveUrl = ArchiveUrl.buildArchiveUrl(ArchiveUrl.MIRRORS[0], url);
  markEngineNavigation(tabId, archiveUrl);
  api.tabs.update(tabId, { url: archiveUrl });
}

// Loop analysis (encoded here per bead 6kl.4's requirements):
//
// - Cross-rule A -> B -> A loops (e.g. rule (a) sends a tab to an original
//   whose domain rule (b) would then immediately re-archive) are prevented
//   structurally: 6kl.3 enforces that a domain can appear on at most one of
//   alwaysArchiveDomains / alwaysOriginalDomains, so the domain that
//   satisfied rule (a)'s alwaysOriginalDomains match cannot simultaneously
//   satisfy rule (b)'s alwaysArchiveDomains match (barring the corrupted-
//   storage case rule (a) additionally guards against above).
// - Rule (b)'s own output can never re-trigger rule (b): its output is
//   always an archive.ph URL (isArchiveUrl(archiveUrl) === true), and rule
//   (b) only fires for !isArchiveUrl(url).
// - Rule (b)'s output COULD in principle re-trigger rule (a) (it's an
//   archive URL whose embedded original is the same listed domain) --
//   except that domain is on alwaysArchiveDomains, not
//   alwaysOriginalDomains, so rule (a)'s domain check fails; mutual
//   exclusivity again closes the loop.
// - Rule (a)'s output can never re-trigger rule (a): its output is a plain
//   http(s) URL (the extracted original), and rule (a) only fires for
//   isArchiveUrl(url).
// - The engine-initiated marker (engineMarkers, above) is the belt-and-
//   braces backstop for all of the above: even if list mutual exclusivity
//   were ever violated (corrupted storage, a future bug), the very next
//   onUpdated event the engine's own tabs.update produces is consumed by
//   the marker check in the listener below and never reaches these rules,
//   so at worst a loop is cut after one extra hop rather than looping
//   indefinitely.

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo || !changeInfo.url) return;
  const url = changeInfo.url;

  if (!isHttpUrl(url)) return;

  // Manual-override guard: for an archive URL, the "domain" a user's manual
  // toggle would have recorded is the extracted original's domain (that's
  // what recordManualOverride stores for both archive and de-archive
  // clicks -- see navigateAndRecord); for a normal URL, it's the URL's own
  // domain. Use whichever is relevant so a manual de-archive click (which
  // lands the tab on the plain original URL) is recognized by rule (a)'s
  // *input* check too, even though by the time onUpdated fires for that
  // landing the URL itself is no longer an archive URL.
  const relevantUrl = ArchiveUrl.isArchiveUrl(url)
    ? ArchiveUrl.extractOriginalUrl(url) || url
    : url;
  if (hasManualOverride(tabId, relevantUrl)) return;

  // Engine-initiated marker guard: if this event is reporting the engine's
  // own just-issued redirect landing, consume the marker and stop -- don't
  // re-run the rules against a URL we produced ourselves.
  if (engineMarkers.get(tabId) === url) {
    engineMarkers.delete(tabId);
    return;
  }

  applyAutoRedirectRules(tabId, url).catch(() => {
    // Never let a storage or matching error surface as an unhandled
    // rejection or block the navigation the browser is already performing.
  });
});

const menus = api.contextMenus || api.menus;

if (menus) {
  menus.create(
    {
      id: "open-in-archive-ph",
      title: "Open in archive.ph",
      contexts: ["page", "link"],
    },
    () => {
      // Swallow duplicate-id errors that can occur when a non-persistent
      // background worker re-registers the menu on restart.
      void api.runtime.lastError;
    }
  );

  menus.onClicked.addListener((info, tab) => {
    const targetUrl = info.linkUrl || (tab && tab.url);
    // Archiving a link (info.linkUrl set) always opens a new tab: the
    // link's target is a different URL than the page the user is on, so
    // reusing the current tab would replace the page they're reading with
    // an archive of something else entirely. Only "archive this page"
    // (no linkUrl) honors the reuse-current-tab setting.
    const forceNewTab = Boolean(info.linkUrl);
    openArchiveSafe(targetUrl, { tabId: tab && tab.id, forceNewTab });
  });
}
