# Open Next to Parent

A tiny JavaScript mod for [Zen Browser](https://zen-browser.app) that places
tabs opened from links, and duplicated tabs, **right next to their parent tab
inside the parent's folder** — instead of at the end of the folder.

> **Zen Browser only.** Sine runs on many Firefox-based browsers, but this mod
> exists to fix the behavior of Zen's *folders* feature. On other browsers it
> loads and harmlessly does nothing, because they have no Zen folders.

## What it does

Zen has a hidden built-in setting, `zen.folders.owned-tabs-in-folder`, that
adopts new "child" tabs (link-opened or duplicated) into the same folder as the
tab that spawned them. This mod fixes the one thing that setting gets wrong:
Zen appends the new tab at the **end** of the folder, and this script moves it
to sit **immediately after its parent** instead. Opening several links in a row
from the same tab keeps them in the order you clicked them.

It deliberately does nothing else: no visual changes, no handling of plain
Ctrl/Cmd+T tabs, no adopting tabs on its own. If a Zen update ever changes the
internals this script relies on, it fails silently and you just get the default
end-of-folder behavior back — nothing breaks.

## Requirements

1. Zen Browser (stable release).
2. The hidden setting turned on: open `about:config`, search for
   `zen.folders.owned-tabs-in-folder`, set it to `true`. **The mod does nothing
   without this** — the setting does the adopting, the mod does the
   positioning.
3. [Sine](https://github.com/CosmoCreeper/Sine), the community mod manager,
   which loads the script into Zen.

## Installation

1. Install Sine using the installer for your operating system from the
   [Sine releases page](https://github.com/CosmoCreeper/Sine/releases/latest),
   then restart Zen.
2. In Zen, go to Settings → Sine Mods, and in the "install from repository"
   field paste this repository's address:
   `https://github.com/Nikoneshot/zen-open-next-to-parent`
3. Restart Zen (or follow Sine's prompt).
4. Make sure `zen.folders.owned-tabs-in-folder` is `true` in `about:config`
   (step 2 of Requirements).

## Testing checklist

- Duplicate a tab that lives inside a folder → the copy appears directly
  below the original, in the same folder.
- Cmd/Ctrl+click (or middle-click) a link from a tab inside a folder → the
  new tab appears directly below that tab.
- Open three links in a row from the same tab → they appear below it in the
  order you clicked them.
- Click a link from a tab that is **not** in any folder → behavior unchanged.
- Drag a tab into a folder by hand → it stays exactly where you dropped it
  (the mod only touches tabs that have a parent in the folder).

## Troubleshooting

Set `zen.open-next-to-parent.debug` to `true` in `about:config` (create it as
a Boolean if it doesn't exist), then open the Browser Console
(Tools → Browser Tools → Browser Console) and watch for lines starting with
`[OpenNextToParent]` while you open tabs.

If repositioning stops working after a Zen update, the browser is fine — a
Zen internal this script uses probably got renamed. Check this repository for
an update, or open an issue.

## Files

- `open-next-to-parent.uc.mjs` — the script itself (heavily commented).
- `theme.json` — the metadata Sine reads: what the mod is called, which script
  file to load, and where updates come from.

*Maintainer note: when shipping an update, bump `version` and set `updatedAt`
in `theme.json` so Sine notices it.*

## License

[MIT](LICENSE) — use it however you like, including commercially; just keep
the copyright notice intact.
