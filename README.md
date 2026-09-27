# Plugin Configurator

A local-only dev tool for RPG Maker MV and MZ projects. It:

1. Syncs plugin files into the game's `js/plugins` folder from two sources — a **global** folder (plugins shared across every game you work on) and a **game-specific** folder (plugins meant only for this one game) — copying any that are missing and overwriting any that are outdated (compared by content hash, not by date). A file present in both is taken from the game-specific folder, so it can override a global plugin for just that game.
2. Remembers, per game root, which global/game-specific folder pair you used last time as a **profile** — so switching back to a game you've already set up doesn't mean re-picking folders or re-disabling plugins that actually belong to some other game.
3. Parses each plugin's `@param` header block into a parameter schema.
4. Serves a small local web GUI to view/edit those parameters and each plugin's enabled/disabled status, reading and writing `js/plugins.js` directly — no RPG Maker editor required.

Not intended to be shipped to players — dev/testing tool only.

## MV / MZ compatibility

Works unmodified with both engines — no separate build needed. MV and MZ share
the same `js/plugins.js` array format (`{name, status, description,
parameters}`) and the same `/*: ... */` header-comment convention for
`@param`/`@desc`/`@type`/`@default`/`@min`/`@max`/`@parent`/`@option`/`@value`.
Plugins that skip newer tags (like MZ's `@text`) or use engine-specific
`@type` values still work — unrecognized types just fall back to a plain text
field in the GUI.

## Usage

Double-click `run_plugin_configurator.bat` (Windows) or `run_plugin_configurator.sh` (macOS/Linux) — both live next to the script and launch it with the defaults below, no terminal needed. On macOS/Linux you may need to right-click → Open, or run `chmod +x run_plugin_configurator.sh` once first, if it won't run by double-click alone.

To pass custom arguments, run from a terminal instead:

```
node plugin_configurator.js [gameRoot] [globPluginsDir] [specificPluginsDir] [port]
```

| Argument | Description | Default |
|---|---|---|
| `gameRoot` | Path to the game's root folder (contains `js/plugins.js`) | Your Downloads folder |
| `globPluginsDir` | Folder of plugins shared across every game | A saved profile's value for this `gameRoot`, else a `global-plugins` folder next to this script |
| `specificPluginsDir` | Folder of plugins meant only for this game | A saved profile's value for this `gameRoot`, else `game-plugins/<game folder name>` next to this script (created automatically if missing) |
| `port` | Local server port | `8420`, or an auto-picked free port if `8420` is busy |

If `globPluginsDir` is missing or invalid at startup, the tool logs a warning and starts anyway — use the **Browse...** buttons in the GUI to pick a valid folder. `specificPluginsDir` is created automatically if it doesn't exist yet, since that's the normal case for a game you haven't configured before.

## Profiles

Every time you successfully switch to a set of folders — at startup, or via **Switch to these folders** in the GUI — the tool saves `{ gameRoot → globPluginsDir, specificPluginsDir }` to `profiles.json` next to the script. Point the tool at that same game root again later (by CLI arg, by Browse-ing to it, or by picking it from the **Known games** list in the GUI) and its folders come back automatically — no manual re-entry, and no plugins from some other game cluttering the list.

There's no manual "name your profile" step — a profile is just keyed by the game's resolved root path, so it's created and kept up to date transparently as you use the tool. `profiles.json` is plain JSON if you ever want to inspect or hand-edit it.

One edge case worth knowing: the default `specificPluginsDir` for a new, never-before-seen game is `game-plugins/<basename of gameRoot>`. If you have two different games that happen to share the same folder name (e.g. two `MyGame` folders on different drives), their default game-specific folders would collide — just pick a distinct one via **Browse...** the first time and it'll be remembered correctly from then on.

### Migrating from the single-folder version

If you were using an older version of this tool with one shared `local-plugins` folder: rename that folder to `global-plugins` (or pass its path as `globPluginsDir`), and create a `game-plugins/<game name>` folder — or point `specificPluginsDir` anywhere you like — for anything that should only apply to one game.

## Changelog

- **Global vs. game-specific plugin folders + profiles**: the single `localPluginsDir` is now split into `globPluginsDir` (synced into every game) and `specificPluginsDir` (synced into one game only, and overrides a same-named global plugin). Each `gameRoot` you switch to has its folder pair remembered automatically as a profile, surfaced in the GUI as a "Known games" list. **CLI signature changed** — see the Usage table.
- **Auto port fallback**: if the default port (`8420`) is already in use, the server now automatically picks a free port instead of crashing with `EADDRINUSE`.
- **Fixed Save bug**: `writePluginsJs` had a parameter named `state` that shadowed the outer app state, so saving a plugin's settings always crashed with `The "path" argument must be of type string...`. Renamed the parameter so saves write to the correct `js/plugins.js` path.
- **`gameRoot` default**: now defaults to your Downloads folder instead of the current working directory.
