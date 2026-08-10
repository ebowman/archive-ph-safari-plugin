// Settings page logic. The pure state-transition functions live on
// globalThis.SettingsLogic and take/return plain state objects with no
// DOM or storage access, so they can be loaded and exercised directly
// under plain node (see scripts/test-settings.js). DOM wiring (reading
// inputs, rendering lists, persisting to storage) is kept thin and
// separate in init() below.

(function () {
  // Shape of the domain-list state threaded through SettingsLogic
  // functions:
  //   {
  //     alwaysArchiveDomains: string[],
  //     alwaysOriginalDomains: string[],
  //     notice: string | null,   // one-line UI notice from the last mutation
  //     error: string | null,    // one-line UI error from the last mutation
  //   }

  function emptyState() {
    return {
      alwaysArchiveDomains: [],
      alwaysOriginalDomains: [],
      notice: null,
      error: null,
    };
  }

  // Adds `rawInput` to the list named `listName` ("alwaysArchiveDomains" or
  // "alwaysOriginalDomains"), enforcing:
  //  - normalization via ArchiveUrl.normalizeDomain (invalid input -> error,
  //    state's domain lists unchanged);
  //  - de-duplication (domain already in the target list -> no-op, with a
  //    friendly "already in this list" notice; state's domain lists
  //    unchanged otherwise);
  //  - mutual exclusivity (domain present in the *other* list -> removed
  //    from there, added here, with a "moved from the other list" notice).
  // Returns a new state object; does not mutate `state`.
  function addDomain(state, listName, rawInput) {
    const otherListName =
      listName === "alwaysArchiveDomains"
        ? "alwaysOriginalDomains"
        : "alwaysArchiveDomains";

    const domain = ArchiveUrl.normalizeDomain(rawInput);
    if (!domain) {
      return {
        ...state,
        error: `"${rawInput}" doesn't look like a valid domain.`,
        notice: null,
      };
    }

    if (state[listName].includes(domain)) {
      return {
        ...state,
        error: null,
        notice: `${domain} is already in this list.`,
      };
    }

    const wasInOtherList = state[otherListName].includes(domain);
    const nextOtherList = wasInOtherList
      ? state[otherListName].filter((d) => d !== domain)
      : state[otherListName];

    return {
      ...state,
      [listName]: [...state[listName], domain],
      [otherListName]: nextOtherList,
      error: null,
      notice: wasInOtherList
        ? `${domain} moved from the other list.`
        : null,
    };
  }

  // Removes `domain` from the list named `listName`. Returns a new state
  // object; does not mutate `state`. No-op (aside from clearing
  // notice/error) if the domain isn't present.
  function removeDomain(state, listName, domain) {
    return {
      ...state,
      [listName]: state[listName].filter((d) => d !== domain),
      error: null,
      notice: null,
    };
  }

  // Self-heals state loaded from storage: if a domain is present in both
  // lists (shouldn't normally happen, since addDomain enforces mutual
  // exclusivity on every mutation, but storage could be edited externally
  // or migrated from an older schema), drop it from alwaysArchiveDomains
  // and keep it in alwaysOriginalDomains — we prefer the user reach their
  // paid/original site over an archive mirror. Returns a new state object;
  // does not mutate `state`.
  function selfHeal(state) {
    const originalSet = new Set(state.alwaysOriginalDomains);
    const healedArchiveDomains = state.alwaysArchiveDomains.filter(
      (d) => !originalSet.has(d)
    );
    if (healedArchiveDomains.length === state.alwaysArchiveDomains.length) {
      return state;
    }
    return {
      ...state,
      alwaysArchiveDomains: healedArchiveDomains,
    };
  }

  const SettingsLogic = {
    emptyState,
    addDomain,
    removeDomain,
    selfHeal,
  };

  globalThis.SettingsLogic = SettingsLogic;

  // --- DOM wiring -----------------------------------------------------
  // Only runs when a `document` with the expected elements is present;
  // the test harness stubs `document` so this file can be loaded under
  // node without a browser DOM.

  if (typeof document === "undefined") return;

  const api = typeof browser !== "undefined" ? browser : chrome;

  const LISTS = [
    {
      key: "alwaysArchiveDomains",
      formId: "always-archive-form",
      inputId: "always-archive-input",
      errorId: "always-archive-error",
      noticeId: "always-archive-notice",
      listId: "always-archive-list",
    },
    {
      key: "alwaysOriginalDomains",
      formId: "always-original-form",
      inputId: "always-original-input",
      errorId: "always-original-error",
      noticeId: "always-original-notice",
      listId: "always-original-list",
    },
  ];

  let state = SettingsLogic.emptyState();

  function persist() {
    api.storage.local.set({
      alwaysArchiveDomains: state.alwaysArchiveDomains,
      alwaysOriginalDomains: state.alwaysOriginalDomains,
    });
  }

  function render() {
    for (const cfg of LISTS) {
      const listEl = document.getElementById(cfg.listId);
      const errorEl = document.getElementById(cfg.errorId);
      const noticeEl = document.getElementById(cfg.noticeId);
      if (!listEl || !errorEl || !noticeEl) continue;

      listEl.innerHTML = "";
      for (const domain of state[cfg.key]) {
        const li = document.createElement("li");
        const span = document.createElement("span");
        span.textContent = domain;
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "remove-entry";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", () => {
          state = SettingsLogic.removeDomain(state, cfg.key, domain);
          persist();
          render();
        });
        li.appendChild(span);
        li.appendChild(removeBtn);
        listEl.appendChild(li);
      }

      if (state.error) {
        errorEl.textContent = state.error;
        errorEl.hidden = false;
      } else {
        errorEl.hidden = true;
        errorEl.textContent = "";
      }

      if (state.notice) {
        noticeEl.textContent = state.notice;
        noticeEl.hidden = false;
      } else {
        noticeEl.hidden = true;
        noticeEl.textContent = "";
      }
    }
  }

  function wireDomainLists() {
    for (const cfg of LISTS) {
      const form = document.getElementById(cfg.formId);
      // JSDoc-cast to HTMLInputElement (not just HTMLElement) only so the
      // tsc --checkJs gate (bead archive-ph-safari-plugin-umg) can see
      // `.value` below; does not change runtime behavior.
      const input = /** @type {HTMLInputElement | null} */ (document.getElementById(cfg.inputId));
      if (!form || !input) continue;

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        state = SettingsLogic.addDomain(state, cfg.key, input.value);
        if (!state.error) {
          input.value = "";
        }
        persist();
        render();
      });
    }
  }

  function wireNewTabCheckbox() {
    // JSDoc-cast to HTMLInputElement (not just HTMLElement) only so the
    // tsc --checkJs gate (bead archive-ph-safari-plugin-umg) can see
    // `.checked` below; does not change runtime behavior.
    const checkbox = /** @type {HTMLInputElement | null} */ (
      document.getElementById("new-tab-checkbox")
    );
    if (!checkbox) return;

    api.storage.local.get("newTab").then((result) => {
      checkbox.checked = result.newTab !== false;
    });

    checkbox.addEventListener("change", () => {
      api.storage.local.set({ newTab: checkbox.checked });
    });
  }

  function init() {
    wireNewTabCheckbox();
    wireDomainLists();

    api.storage.local
      .get(["alwaysArchiveDomains", "alwaysOriginalDomains"])
      .then((result) => {
        state = SettingsLogic.selfHeal({
          ...SettingsLogic.emptyState(),
          alwaysArchiveDomains: Array.isArray(result.alwaysArchiveDomains)
            ? result.alwaysArchiveDomains
            : [],
          alwaysOriginalDomains: Array.isArray(result.alwaysOriginalDomains)
            ? result.alwaysOriginalDomains
            : [],
        });
        // Persist immediately in case self-heal changed anything, so
        // storage reflects the healed state right away.
        persist();
        render();
      });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
