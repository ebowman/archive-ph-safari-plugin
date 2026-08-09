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

async function openArchive(rawUrl) {
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
  api.tabs.create({ url: archiveUrl });
}

// Callers treat this as fire-and-forget; ensure rejections never surface
// as unhandled promise rejections.
function openArchiveSafe(rawUrl) {
  openArchive(rawUrl).catch(() => {});
}

api.action.onClicked.addListener((tab) => {
  if (!tab || !tab.url) return;
  openArchiveSafe(tab.url);
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
    openArchiveSafe(targetUrl);
  });
}
