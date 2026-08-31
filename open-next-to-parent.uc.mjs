// ==UserScript==
// @name           Open Next to Parent
// @description    Tabs opened from links or duplication are placed right after their parent tab inside Zen folders, instead of at the end of the folder.
// @include        chrome://browser/content/browser.xhtml
// ==/UserScript==

// HOW THIS WORKS
// --------------
// Zen's built-in hidden setting `zen.folders.owned-tabs-in-folder` (which you
// must turn on in about:config) adopts link-opened tabs into the parent tab's
// folder — but appends them at the END of the folder (ZenFolders.mjs calls
// group.addTabs([tab]), which appends). This script listens for Zen's
// "TabGrouped" event, waits one tick so Zen finishes its own handling, then
// moves the new tab to sit immediately after its parent.
//
// Duplicated tabs are different: they are created unpinned and ungrouped in
// the regular tab list, so Zen never adopts them at all. We wrap the two
// per-window entry points for duplication — the window-global duplicateTabIn()
// (used by the tab context menu) and gBrowser.duplicateTab() (used by Zen's
// keyboard shortcut) — to flag that a duplicate is coming, claim the next
// TabOpen as that duplicate, then adopt it into the parent's folder ourselves
// (pin + addTabs, mirroring Zen's own adoption code) and position it.
//
// If a Zen update changes any internal this script relies on, every step fails
// silently and you get default behavior back — nothing breaks.

(() => {
  "use strict";

  const LOG = "[OpenNextToParent]";

  // Set the about:config preference `zen.open-next-to-parent.debug` to true to
  // see what the script is doing in the Browser Console (enable the "Debug"
  // log level in the console's filter bar).
  const debug = (...args) => {
    try {
      if (Services.prefs.getBoolPref("zen.open-next-to-parent.debug", false)) {
        console.log(LOG, ...args);
      }
    } catch {}
  };

  // Short description of a tab for debug lines.
  const tag = tab => {
    try {
      return `"${tab?.label}"[${tab?.pinned ? "P" : ""}${tab?.hidden ? "H" : ""}${
        tab?.hasAttribute?.("zen-empty-tab") ? "E" : ""
      }]`;
    } catch {
      return "<?>";
    }
  };

  // Remembers, for each parent tab, the most recent child we placed — so that
  // opening several links in a row keeps them in the order you clicked them.
  // Cleared whenever you switch tabs, matching how Firefox itself handles
  // "related tab" ordering.
  let lastPlacedChild = new WeakMap();

  const isAlive = tab => tab && tab.isConnected && !tab.closing;

  // Zen marks its per-folder hidden bookkeeping tab with either of these
  // (ZenFolders.mjs checks `tab.hidden || tab.hasAttribute("zen-empty-tab")`).
  const isBookkeeping = tab => tab.hidden || tab.hasAttribute?.("zen-empty-tab");

  // The Zen folder a tab belongs to, looking through split-view groups
  // (a split view is itself a small group that can sit inside a folder).
  function folderOf(tab) {
    let group = tab?.group;
    if (group?.hasAttribute?.("split-view-group")) {
      group = group.group;
    }
    return group?.isZenFolder ? group : null;
  }

  // The sidebar element we should place the new tab after. If the parent is
  // part of a split view, we must not drop the new tab into the middle of the
  // split — we target the whole split group instead.
  function placementTarget(tab) {
    const group = tab?.group;
    if (group?.hasAttribute?.("split-view-group")) {
      return group;
    }
    return tab;
  }

  // Resolve the tab's window defensively: Zen tab elements have been observed
  // with an undefined ownerGlobal, and this script's window is correct for
  // every tab it hears about via its (window-scoped) listeners.
  const windowFor = tab => tab.ownerGlobal ?? tab.ownerDocument?.defaultView ?? window;

  function moveAfter(tab, target) {
    const gb = windowFor(tab).gBrowser;
    if (typeof gb.moveTabAfter === "function") {
      gb.moveTabAfter(tab, target);
    } else if (typeof target.elementIndex === "number") {
      // Same call Zen's own folder code uses to position tabs.
      gb.moveTabTo(tab, { elementIndex: target.elementIndex + 1 });
    } else {
      debug("no usable tab-move API; leaving tab where it is");
    }
  }

  function maybeReposition(tab) {
    try {
      if (!isAlive(tab)) {
        return;
      }
      const folder = folderOf(tab);
      if (!folder) {
        debug("tab", tag(tab), "is not in a Zen folder; nothing to do");
        return;
      }

      // The parent: set explicitly by the duplicate detection below, otherwise
      // the tab Firefox recorded as having opened this one (link clicks).
      const parent = tab._ontpParent || tab.openerTab || tab.owner;
      delete tab._ontpParent;
      if (!isAlive(parent) || parent === tab) {
        debug("tab", tag(tab), "has no usable parent tab; leaving it alone");
        return;
      }
      if (folderOf(parent) !== folder) {
        debug("parent of", tag(tab), "is not in the same folder; leaving it alone");
        return;
      }

      // Anchor on the last child we placed for this parent (click order),
      // falling back to the parent itself.
      let anchor = lastPlacedChild.get(parent);
      if (!(isAlive(anchor) && anchor !== tab && folderOf(anchor) === folder)) {
        anchor = parent;
      }

      const target = placementTarget(anchor);
      if (!target || target === tab) {
        return;
      }
      if (target.nextElementSibling !== tab) {
        moveAfter(tab, target);
        debug("moved", tag(tab), "to sit after", tag(anchor), "in folder", folder.label);
      } else {
        debug("tab", tag(tab), "is already right after", tag(anchor), "in folder", folder.label);
      }
      lastPlacedChild.set(parent, tab);
    } catch (e) {
      console.warn(LOG, "could not reposition tab (harmless):", e);
    }
  }

  function onTabGrouped(event) {
    try {
      const tab = event.detail;
      if (!folderOf(tab) || isBookkeeping(tab)) {
        return;
      }
      // Let Zen completely finish its own adoption (pinning + appending),
      // then fix the position.
      setTimeout(() => maybeReposition(tab), 0);
    } catch (e) {
      console.warn(LOG, "TabGrouped handler failed (harmless):", e);
    }
  }

  function onTabSelect() {
    // Reset click-order tracking when you switch tabs (mirrors Firefox).
    lastPlacedChild = new WeakMap();
  }

  // Zen won't adopt duplicates into folders on its own (its adoption only
  // reacts to tabs that are already inside a folder when they open). Mirror
  // Zen's own adoption for owned tabs — pin, then add to the folder — and
  // then position the copy after its original.
  function adoptDuplicate(tab, parent) {
    try {
      if (!isAlive(tab) || !isAlive(parent)) {
        return;
      }
      const folder = folderOf(parent);
      if (!folder) {
        debug("duplicated tab's original is not in a folder; nothing to do");
        return;
      }
      if (folderOf(tab) === folder) {
        // Already adopted (e.g. a future Zen version fixes this) — just place it.
        maybeReposition(tab);
        return;
      }
      if (tab.group) {
        debug("duplicate ended up in a different group; leaving it alone");
        return;
      }
      if (!tab.pinned) {
        windowFor(tab).gBrowser.pinTab(tab);
      }
      folder.addTabs([tab]);
      debug("adopted duplicate", tag(tab), "into folder", folder.label);
      maybeReposition(tab);
    } catch (e) {
      console.warn(LOG, "could not adopt duplicate (harmless):", e);
    }
  }

  // --- duplicate detection ---------------------------------------------
  // Wrapping is per-window and directly verifiable: duplicateTabIn() is the
  // window-global the tab context menu calls, and gBrowser.duplicateTab() is
  // what Zen's keyboard shortcut uses. Each wrapper raises a short-lived
  // "duplicate incoming" flag; the next TabOpen in this window claims it.
  let pendingDuplicate = null; // { parent, until }
  let originalDuplicateTabIn = null;
  let originalGBDuplicateTab = null;

  function markPendingDuplicate(parent) {
    if (isAlive(parent)) {
      pendingDuplicate = { parent, until: Date.now() + 1000 };
    }
  }

  function onTabOpen(event) {
    try {
      if (!pendingDuplicate) {
        return;
      }
      if (Date.now() > pendingDuplicate.until) {
        pendingDuplicate = null;
        return;
      }
      const tab = event.target;
      if (isBookkeeping(tab)) {
        return;
      }
      const { parent } = pendingDuplicate;
      pendingDuplicate = null;
      debug("duplicate of", tag(parent), "detected:", tag(tab));
      tab._ontpParent = parent;
      setTimeout(() => adoptDuplicate(tab, parent), 0);
    } catch (e) {
      console.warn(LOG, "TabOpen handler failed (harmless):", e);
    }
  }

  function hookDuplicate() {
    try {
      if (typeof window.duplicateTabIn === "function") {
        originalDuplicateTabIn = window.duplicateTabIn;
        window.duplicateTabIn = function (aTab, ...rest) {
          try {
            markPendingDuplicate(aTab);
          } catch {}
          return originalDuplicateTabIn.call(this, aTab, ...rest);
        };
      }
      if (typeof gBrowser?.duplicateTab === "function") {
        originalGBDuplicateTab = gBrowser.duplicateTab;
        gBrowser.duplicateTab = function (aTab, ...rest) {
          try {
            markPendingDuplicate(aTab);
          } catch {}
          return originalGBDuplicateTab.call(this, aTab, ...rest);
        };
      }
      debug(
        "duplicate hooks installed: duplicateTabIn=" +
          !!originalDuplicateTabIn +
          " gBrowser.duplicateTab=" +
          !!originalGBDuplicateTab
      );
    } catch (e) {
      console.warn(LOG, "could not hook duplication (harmless):", e);
    }
  }

  // Sine re-imports this script after every mod update. It calls the cleanup
  // we register here first, so the old copy tears itself down instead of
  // stacking listeners next to the new one.
  function registerCleanup() {
    if (typeof window.addUnloadListener !== "function") {
      return;
    }
    window.addUnloadListener(() => {
      try {
        window.removeEventListener("TabGrouped", onTabGrouped);
        window.removeEventListener("TabSelect", onTabSelect);
        window.removeEventListener("TabOpen", onTabOpen);
        if (originalDuplicateTabIn) {
          window.duplicateTabIn = originalDuplicateTabIn;
        }
        if (originalGBDuplicateTab && typeof gBrowser === "object") {
          gBrowser.duplicateTab = originalGBDuplicateTab;
        }
        debug("unloaded old instance");
      } catch (e) {
        console.warn(LOG, "cleanup failed (harmless):", e);
      }
    });
  }

  function init() {
    try {
      window.addEventListener("TabGrouped", onTabGrouped);
      window.addEventListener("TabSelect", onTabSelect);
      window.addEventListener("TabOpen", onTabOpen);
      hookDuplicate();
      registerCleanup();
      console.debug(LOG, "initialized");
    } catch (e) {
      console.warn(LOG, "failed to initialize:", e);
    }
  }

  // Wait until the browser window has fully started before touching anything.
  if (typeof gBrowserInit !== "undefined" && gBrowserInit.delayedStartupFinished) {
    init();
  } else {
    const obs = subject => {
      if (subject === window) {
        Services.obs.removeObserver(obs, "browser-delayed-startup-finished");
        init();
      }
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }
})();
