// iOS action popup logic (bead 5xt.14). Safari on iOS/iPadOS doesn't
// surface options_ui in a toolbar menu, so this popup -- set as the
// extension's action popup only on iOS, see background.js's
// getPlatformInfo()-gated setPopup call -- is the only entry point to the
// toggle and the quick domain-list toggles there. macOS keeps
// action.onClicked's instant one-click toggle (no popup).
//
// Structured like extension/settings/settings.js: the pure, DOM-free
// functions live on globalThis.PopupLogic so they can be loaded and
// exercised directly under plain node (see scripts/test-popup.js). DOM
// wiring (reading the response from the background page, rendering, and
// persisting the quick-toggle checkboxes) is kept separate in init()
// below, guarded on `typeof document !== "undefined"` the same way
// settings.js is, so this file can be loaded document-less in the test
// harness.
//
// Wrapped in an IIFE, and even the DOM-wiring half's `api` binding is kept
// INSIDE that IIFE (not top-level): popup.html loads archive-url.js,
// settings.js, and this file as sibling <script> tags sharing one top-level
// lexical scope, and background.js -- never co-loaded with this file at
// runtime, but co-checked with it by the tsc structural-lint gate (see
// scripts/tsconfig.extension.json) -- already declares a top-level `const
// api`. A second top-level `const api` here would collide under that gate
// even though the two files never actually share a real page. See bead 9k9
// for the underlying shared-scope hazard this avoids.
(function () {
  // Returns the primary button's label for `url`:
  //  - "Cannot access this page" when url is missing, not a string, or not
  //    an http(s) url (e.g. Safari's start page, about:blank, or a tab
  //    Safari withheld the url for without per-site access -- see bead
  //    5xt.13).
  //  - "Back to original" when url is currently an archive-mirror page.
  //  - "Open in archive.ph" for any other http(s) page.
  function labelFor(url) {
    if (typeof url !== "string" || !url) return "Cannot access this page";

    let protocol;
    try {
      protocol = new URL(url).protocol;
    } catch (e) {
      return "Cannot access this page";
    }
    if (protocol !== "http:" && protocol !== "https:") {
      return "Cannot access this page";
    }

    return ArchiveUrl.isArchiveUrl(url) ? "Back to original" : "Open in archive.ph";
  }

  // Returns the normalized domain the quick-toggle checkboxes apply to for
  // `url`: for an archive-mirror url, this is the EXTRACTED ORIGINAL's
  // domain (the site the user actually cares about listing), not
  // archive.ph's own domain. Returns null when url is missing, not a
  // string, an archive url with no extractable original (bare short-code
  // pages), or doesn't normalize to a plausible domain.
  function domainFor(url) {
    if (typeof url !== "string" || !url) return null;

    const original = ArchiveUrl.isArchiveUrl(url) ? ArchiveUrl.extractOriginalUrl(url) : url;
    if (!original) return null;

    return ArchiveUrl.normalizeDomain(original);
  }

  // Derives the quick-toggle checkboxes' checked state for `domain` from a
  // SettingsLogic-shaped state object (the same {alwaysArchiveDomains,
  // alwaysOriginalDomains, ...} shape settings.js persists to and loads
  // from storage.local). Pure function of (state, domain); does not read
  // or write storage itself.
  function quickToggleState(state, domain) {
    const archiveDomains = (state && state.alwaysArchiveDomains) || [];
    const originalDomains = (state && state.alwaysOriginalDomains) || [];
    return {
      alwaysArchive: Boolean(domain) && archiveDomains.includes(domain),
      alwaysOriginal: Boolean(domain) && originalDomains.includes(domain),
    };
  }

  const PopupLogic = { labelFor, domainFor, quickToggleState };

  globalThis.PopupLogic = PopupLogic;

  // --- DOM wiring -----------------------------------------------------
  // Only runs when a `document` is present; the test harness loads this
  // file under plain node with no `document` global, mirroring
  // settings.js's own document-less test harness.

  if (typeof document === "undefined") return;

  const api = typeof browser !== "undefined" ? browser : chrome;

  // Reads both domain lists from storage.local into a SettingsLogic-shaped
  // state object, the same way settings.js's init() does, so
  // SettingsLogic.addDomain/removeDomain and PopupLogic.quickToggleState
  // can operate on it directly.
  function readDomainListState() {
    return api.storage.local
      .get(["alwaysArchiveDomains", "alwaysOriginalDomains"])
      .then((result) => ({
        ...SettingsLogic.emptyState(),
        alwaysArchiveDomains: Array.isArray(result.alwaysArchiveDomains)
          ? result.alwaysArchiveDomains
          : [],
        alwaysOriginalDomains: Array.isArray(result.alwaysOriginalDomains)
          ? result.alwaysOriginalDomains
          : [],
      }));
  }

  function persistDomainListState(state) {
    return api.storage.local.set({
      alwaysArchiveDomains: state.alwaysArchiveDomains,
      alwaysOriginalDomains: state.alwaysOriginalDomains,
    });
  }

  function init() {
    // JSDoc-cast to HTMLButtonElement (not just HTMLElement) only so the
    // tsc --checkJs gate (bead archive-ph-safari-plugin-umg) can see
    // `.disabled` below; does not change runtime behavior.
    const primaryButton = /** @type {HTMLButtonElement | null} */ (
      document.getElementById("primary-button")
    );
    if (!primaryButton) return;

    const needsAccessNotice = document.getElementById("needs-access-notice");
    const quickToggles = document.getElementById("quick-toggles");
    const domainLabel = document.getElementById("domain-label");
    const allSettingsLink = document.getElementById("all-settings-link");
    // JSDoc-cast to HTMLInputElement (not just HTMLElement) only so the
    // tsc --checkJs gate (bead archive-ph-safari-plugin-umg) can see
    // `.checked` below; does not change runtime behavior.
    const alwaysArchiveCheckbox = /** @type {HTMLInputElement | null} */ (
      document.getElementById("always-archive-checkbox")
    );
    const alwaysOriginalCheckbox = /** @type {HTMLInputElement | null} */ (
      document.getElementById("always-original-checkbox")
    );

    let currentDomain = null;

    // `disabled` drives the primary button and the quick-toggle checkboxes:
    // it's true whenever the popup can't act on the current tab at all,
    // which is broader than "url is null" (bead 5xt.15's fix) -- it also
    // covers a resolved but non-http url (e.g. about:blank, or a page
    // Safari's per-site permission withheld the url for) via canAct below.
    // `showNeedsAccessNotice` is narrower and only true when url is exactly
    // null (no url could be resolved at all): a non-null non-http url still
    // shows its own "Cannot access this page" label text on the button, so
    // the needs-access hint (which specifically explains the Safari
    // per-site permission flow) would be misleading there.
    function setAccessDisabled(disabled, showNeedsAccessNotice) {
      // Redundant with init()'s own early return above, but narrows
      // primaryButton back to non-null inside this nested closure for the
      // tsc --checkJs gate (TS doesn't carry a `const` outer narrowing into
      // a function declared after it).
      if (!primaryButton) return;
      primaryButton.disabled = disabled;
      if (alwaysArchiveCheckbox) alwaysArchiveCheckbox.disabled = disabled;
      if (alwaysOriginalCheckbox) alwaysOriginalCheckbox.disabled = disabled;
      if (needsAccessNotice) needsAccessNotice.hidden = !showNeedsAccessNotice;
    }

    function renderQuickToggleCheckboxes() {
      if (!currentDomain) return;
      readDomainListState().then((state) => {
        const toggles = PopupLogic.quickToggleState(state, currentDomain);
        if (alwaysArchiveCheckbox) alwaysArchiveCheckbox.checked = toggles.alwaysArchive;
        if (alwaysOriginalCheckbox) alwaysOriginalCheckbox.checked = toggles.alwaysOriginal;
      });
    }

    function toggleDomainList(listName, checked) {
      if (!currentDomain) return;
      readDomainListState()
        .then((state) =>
          checked
            ? SettingsLogic.addDomain(state, listName, currentDomain)
            : SettingsLogic.removeDomain(state, listName, currentDomain)
        )
        .then((state) => persistDomainListState(state).then(() => state))
        .then((state) => {
          const toggles = PopupLogic.quickToggleState(state, currentDomain);
          if (alwaysArchiveCheckbox) alwaysArchiveCheckbox.checked = toggles.alwaysArchive;
          if (alwaysOriginalCheckbox) alwaysOriginalCheckbox.checked = toggles.alwaysOriginal;
        });
    }

    if (alwaysArchiveCheckbox) {
      alwaysArchiveCheckbox.addEventListener("change", () => {
        toggleDomainList("alwaysArchiveDomains", alwaysArchiveCheckbox.checked);
      });
    }
    if (alwaysOriginalCheckbox) {
      alwaysOriginalCheckbox.addEventListener("change", () => {
        toggleDomainList("alwaysOriginalDomains", alwaysOriginalCheckbox.checked);
      });
    }

    primaryButton.addEventListener("click", () => {
      primaryButton.disabled = true;
      api.runtime
        .sendMessage({ type: "toggle-archive" })
        .catch(() => {
          // Best-effort: even if the round trip fails, still close --
          // there's nothing more the popup can usefully do.
        })
        .then(() => {
          window.close();
        });
    });

    if (allSettingsLink) {
      allSettingsLink.addEventListener("click", (event) => {
        event.preventDefault();
        api.tabs.create({ url: api.runtime.getURL("settings/settings.html") });
        window.close();
      });
    }

    // No tabId is sent: the popup has no reliable tab id of its own to
    // report (see background.js's resolvePopupTab), so it relies entirely
    // on the background page's activeTab-granted access, falling back to
    // querying the active tab in the current window.
    api.runtime
      .sendMessage({ type: "get-action-state" })
      .then((response) => {
        const url = response && response.url ? response.url : null;
        currentDomain = PopupLogic.domainFor(url);
        // True only for a url the popup can actually act on (a resolved
        // http(s) url); false for both url === null (no url at all) and a
        // resolved-but-non-http url (e.g. about:blank) -- see
        // setAccessDisabled's comment for how those two false cases differ
        // in what's shown.
        const canAct = url && PopupLogic.labelFor(url) !== "Cannot access this page";

        primaryButton.textContent = PopupLogic.labelFor(url);
        setAccessDisabled(!canAct, url === null);

        if (domainLabel) domainLabel.textContent = currentDomain || "";
        // Hide the quick-toggle section entirely (rather than rendering
        // blank checkboxes/labels) whenever domainFor couldn't resolve a
        // domain to apply them to -- e.g. a bare short-code archive url
        // with no extractable original, or any url canAct is false for.
        if (quickToggles) quickToggles.hidden = !currentDomain;
        renderQuickToggleCheckboxes();
      })
      .catch(() => {
        primaryButton.textContent = PopupLogic.labelFor(null);
        setAccessDisabled(true, true);
        if (quickToggles) quickToggles.hidden = true;
      });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
