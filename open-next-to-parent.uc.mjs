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
//
// Duplicated tabs don't record which tab they came from, so we also wrap
// SessionStore.duplicateTab — the single function every duplicate path funnels
// into (the right-click menu via duplicateTabIn(), and Zen's keyboard shortcut
// via gBrowser.duplicateTab, which calls it internally) — to stamp the new tab
// with a reference to its original.

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

  // Resolve the tab's window defensively: Zen tab elements have been observed
  // with an undefined ownerGlobal, and this script's window is correct for
  // every tab it hears about via its (window-scoped) TabGrouped listener.
  function moveAfter(tab, target) {
    const win = tab.ownerGlobal ?? tab.ownerDocument?.defaultView ?? window;
    const gb = win.gBrowser;
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
      // Never touch Zen's hidden bookkeeping tab — every folder keeps one,
      // labeled "New Tab", and Zen relies on where it sits.
      if (tab.hasAttribute?.("zen-empty-tab")) {
        return;
      }
      const folder = folderOf(tab);
      if (!folder) {
        debug("tab", tab.label, "is not in a Zen folder; nothing to do");
        return;
      }

      // The parent: set explicitly by the duplicate-tab hook below, otherwise
      // the tab Firefox recorded as having opened this one (link clicks).
      const parent = tab._ontpParent || tab.openerTab || tab.owner;
      delete tab._ontpParent;
      if (!isAlive(parent) || parent === tab) {
        debug("tab", tab.label, "has no usable parent tab; leaving it alone");
        return;
      }
      if (folderOf(parent) !== folder) {
        debug("parent of", tab.label, "is not in the same folder; leaving it alone");
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
      } else {
        debug("tab", tab.label, "is already right after", anchor.label);
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

  function onTabSelect() {
    // Reset click-order tracking when you switch tabs (mirrors Firefox).
    lastPlacedChild = new WeakMap();
  }

  // Zen's owned-tabs-in-folder setting only adopts tabs that are ALREADY in a
  // folder the moment they're created (which is how link-opened tabs arrive).
  // A real duplicate is created unpinned and ungrouped in the regular tab
  // list, so Zen never adopts it. For duplicates we therefore do the adoption
  // ourselves, mirroring Zen's own code for owned tabs (ZenFolders.on_TabOpen:
  // pin, then add to the folder), and then position it after the original.
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
      const win = tab.ownerGlobal ?? tab.ownerDocument?.defaultView ?? window;
      if (!tab.pinned) {
        win.gBrowser.pinTab(tab);
      }
      folder.addTabs([tab]);
      debug("adopted duplicate", tab.label, "into folder", folder.label);
      maybeReposition(tab);
    } catch (e) {
      console.warn(LOG, "could not adopt duplicate (harmless):", e);
    }
  }

  // Every way of duplicating a tab (right-click menu, keyboard shortcut)
  // ultimately calls SessionStore.duplicateTab, so that is where we stamp the
  // new tab with its original. SessionStore is one shared object used by all
  // windows, so guard against wrapping it more than once.
  function hookDuplicate() {
    try {
      if (typeof SessionStore?.duplicateTab !== "function") {
        debug("SessionStore.duplicateTab not found; duplicates won't reposition");
        return;
      }
      if (SessionStore.duplicateTab._ontpWrapped) {
        return;
      }
      const original = SessionStore.duplicateTab;
      const wrapped = function (aWindow, aTab, ...rest) {
        const newTab = original.call(this, aWindow, aTab, ...rest);
        try {
          if (newTab && isAlive(aTab)) {
            newTab._ontpParent = aTab;
            debug("duplicate detected:", aTab.label);
            // Zen won't adopt duplicates into folders on its own — do it
            // (and the positioning) once the current call stack settles.
            setTimeout(() => adoptDuplicate(newTab, aTab), 0);
          }
        } catch (e) {
          console.warn(LOG, "duplicate hook failed (harmless):", e);
        }
        return newTab;
      };
      wrapped._ontpWrapped = true;
      wrapped._ontpOriginal = original;
      SessionStore.duplicateTab = wrapped;
    } catch (e) {
      console.warn(LOG, "could not hook duplicateTab (harmless):", e);
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
        if (SessionStore?.duplicateTab?._ontpOriginal) {
          SessionStore.duplicateTab = SessionStore.duplicateTab._ontpOriginal;
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
