const api = typeof browser !== "undefined" ? browser : chrome;

api.action.onClicked.addListener((tab) => {
  if (!tab || !tab.url) return;

  let isHttp = false;
  try {
    const protocol = new URL(tab.url).protocol;
    isHttp = protocol === "http:" || protocol === "https:";
  } catch (e) {
    isHttp = false;
  }

  if (!isHttp) return;

  // Percent-encode only '#' so a URL fragment isn't swallowed as the
  // archive.ph page's own fragment; everything else is appended raw
  // since archive.ph expects an un-encoded URL.
  const safeUrl = tab.url.replaceAll("#", "%23");
  const archiveUrl = "https://archive.ph/newest/" + safeUrl;
  api.tabs.create({ url: archiveUrl });
});
