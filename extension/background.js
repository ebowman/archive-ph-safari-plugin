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

api.tabs.onRemoved.addListener((tabId) => {
  manualOverrides.delete(tabId);
});

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
