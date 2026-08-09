const api = typeof browser !== "undefined" ? browser : chrome;

function openArchive(rawUrl) {
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
  const archiveUrl = "https://archive.ph/newest/" + safeUrl;
  api.tabs.create({ url: archiveUrl });
}

api.action.onClicked.addListener((tab) => {
  if (!tab || !tab.url) return;
  openArchive(tab.url);
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
    openArchive(targetUrl);
  });
}
