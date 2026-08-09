const api = typeof browser !== "undefined" ? browser : chrome;

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

// options.tabId: the id of the tab the action was triggered from, used to
// update that tab in place when the "reuse current tab" setting is on.
// options.forceNewTab: when true, always opens a new tab regardless of the
// setting -- used for context-menu link archiving, where reusing the
// current tab would destroy the page the user is reading in order to show
// an archive of a *different* URL (the link's target, not the page itself).
async function openArchive(rawUrl, { tabId, forceNewTab = false } = {}) {
  if (!rawUrl) return;

  let isHttp = false;
  try {
    const protocol = new URL(rawUrl).protocol;
    isHttp = protocol === "http:" || protocol === "https:";
  } catch (e) {
    isHttp = false;
  }

  if (!isHttp) return;

  // Percent-encode only '#' so a URL fragment isn't swallowed as the
  // archive.ph page's own fragment; everything else is appended raw
  // since archive.ph expects an un-encoded URL.
  const safeUrl = rawUrl.replaceAll("#", "%23");
  const base = await pickMirror();
  const archiveUrl = `${base}/newest/${safeUrl}`;

  const useNewTab = forceNewTab || (await shouldUseNewTab());

  if (!useNewTab && tabId !== undefined && tabId !== null) {
    api.tabs.update(tabId, { url: archiveUrl });
  } else {
    api.tabs.create({ url: archiveUrl });
  }
}

// Callers treat this as fire-and-forget; ensure rejections never surface
// as unhandled promise rejections.
function openArchiveSafe(rawUrl, options) {
  openArchive(rawUrl, options).catch(() => {});
}

api.action.onClicked.addListener((tab) => {
  if (!tab || !tab.url) return;
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
