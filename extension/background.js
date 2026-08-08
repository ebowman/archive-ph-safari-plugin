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

  const archiveUrl = "https://archive.ph/newest/" + tab.url;
  api.tabs.create({ url: archiveUrl });
});
