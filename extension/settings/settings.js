const api = typeof browser !== "undefined" ? browser : chrome;

function init() {
  const checkbox = document.getElementById("new-tab-checkbox");
  if (!checkbox) return;

  api.storage.local.get("newTab").then((result) => {
    checkbox.checked = result.newTab !== false;
  });

  checkbox.addEventListener("change", () => {
    api.storage.local.set({ newTab: checkbox.checked });
  });
}

document.addEventListener("DOMContentLoaded", init);
