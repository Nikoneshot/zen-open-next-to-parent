// ==UserScript==
// @name           Open Next to Parent
// @description    Tabs opened from links or duplication are placed right after their parent tab inside Zen folders, instead of at the end of the folder.
// @include        chrome://browser/content/browser.xhtml
// ==/UserScript==

// HOW THIS WORKS
// --------------
// Zen's built-in hidden setting `zen.folders.owned-tabs-in-folder` (which you
// must turn on in about:config) already adopts link-opened and duplicated tabs
// into the parent tab's folder — but Zen's code appends them at the END of the
// folder (ZenFolders.mjs calls group.addTabs([tab]), which appends).
//
// This script listens for Zen's "TabGrouped" event (fired whenever a tab joins
// a folder), waits one tick so Zen finishes its own handling, then moves the
// new tab to sit immediately after its parent. If anything about Zen's
// internals changes in a future update, every step here fails silently and you
// simply get today's default behavior back (tab at end of folder).

(() => {
  "use strict";

  const LOG = "[OpenNextToParent]";

  // Set the about:config preference `zen.open-next-to-parent.debug` to true to
  // see what the script is doing in the Browser Console.
  const debug = (...args) => {
    try {
      if (Services.prefs.getBoolPref("zen.open-next-to-parent.debug", false)) {
        console.log(LOG, ...args);
      }
    } catch {}
  };

  // Remembers, for each parent tab, the most recent child we placed — so that
  // opening several links in a row keeps them in the order you clicked them
  // (each new tab goes after the previous one, not squeezed in reverse order
  // right after the parent). Cleared whenever you switch tabs, matching how
  // Firefox itself handles "related tab" ordering.
  let lastPlacedChild = new WeakMap();

  const isAlive = tab => tab && tab.isConnected && !tab.closing;

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

  function moveAfter(tab, target) {
    if (typeof gBrowser.moveTabAfter === "function") {
      gBrowser.moveTabAfter(tab, target);
    } else if (typeof target.elementIndex === "number") {
      // Same call Zen's own folder code uses to position tabs.
      gBrowser.moveTabTo(tab, { elementIndex: target.elementIndex + 1 });
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
        return;
      }

      // The parent: set explicitly by the duplicate-tab hook below, otherwise
      // the tab Firefox recorded as having opened this one (link clicks).
      const parent = tab._ontpParent || tab.openerTab || tab.owner;
      delete tab._ontpParent;
      if (!isAlive(parent) || parent === tab || folderOf(parent) !== folder) {
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
        debug("moved", tab.label, "to sit after", anchor.label);
      }
      lastPlacedChild.set(parent, tab);
    } catch (e) {
      console.warn(LOG, "could not reposition tab (harmless):", e);
    }
  }

  function onTabGrouped(event) {
    try {
      const tab = event.detail;
      if (!folderOf(tab)) {
        return;
      }
      // Let Zen completely finish its own adoption (pinning + appending),
      // then fix the position.
      setTimeout(() => maybeReposition(tab), 0);
    } catch (e) {
      console.warn(LOG, "TabGrouped handler failed (harmless):", e);
    }
  }

  // Duplicated tabs don't always carry an opener reference, so we wrap the
  // duplicate function to remember who the original was.
  function hookDuplicateTab() {
    const original = gBrowser.duplicateTab;
    if (typeof original !== "function") {
      return;
    }
    gBrowser.duplicateTab = function (aTab, ...rest) {
      const newTab = original.call(this, aTab, ...rest);
      try {
        if (newTab && isAlive(aTab)) {
          newTab._ontpParent = aTab;
          setTimeout(() => maybeReposition(newTab), 0);
        }
      } catch (e) {
        console.warn(LOG, "duplicate hook failed (harmless):", e);
      }
      return newTab;
    };
  }

  function init() {
    try {
      window.addEventListener("TabGrouped", onTabGrouped);
      // Reset click-order tracking when you switch tabs (mirrors Firefox).
      window.addEventListener("TabSelect", () => {
        lastPlacedChild = new WeakMap();
      });
      hookDuplicateTab();
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
