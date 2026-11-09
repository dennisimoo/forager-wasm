# Forager WASM

**[Open the runner](https://forager-wasm.4dennisk.workers.dev)**

An unofficial runner that plays **Forager 2.0** in a browser, using a modified [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) WebAssembly runtime.

**No game files are included or hosted.** You need your own copy of Forager. When the page opens, pick your Forager install folder (Steam: right-click Forager → Manage → Browse local files) or drag it onto the page. The runner needs:

- `game.unx` (Linux), `data.win` (Windows) or `game.ios` (macOS, inside `Forager.app/Contents/Resources`)
- `audiogroup1.dat`
- optionally `options.ini` and the `local/` translation files

The files are copied into the browser's private storage (OPFS) on your computer and loaded from there on later visits. They are never uploaded. "Remove saved files" deletes them.

Forager is owned by HopFrog. This project is not affiliated with or endorsed by HopFrog.

## Run locally

Requires Node.js 22 or newer.

```sh
git clone https://github.com/dennisimoo/forager-wasm.git
cd forager-wasm
npm ci
npm run dev
```

Open **http://localhost:8767** in current Chrome or Firefox, then choose your Forager folder. The server supplies the isolation headers the runner needs; opening the HTML file directly will not work.

| Action               | Control           |
| -------------------- | ----------------- |
| Move                 | WASD              |
| Harvest and interact | Left mouse button |
| Inventory and menu   | Esc               |
| Zoom / scroll menus  | Mouse wheel       |

Saves stay in the browser's storage for that site. Changing domains, clearing site data, or using a different browser gives you separate saves.

## Deploy to Cloudflare

The Worker serves only the launcher and the WASM runner.

```sh
npx wrangler login
npm run deploy
```

## What is included

```text
public/       Launcher and compiled WASM runner (no game files)
src/          Cloudflare Worker
scripts/      Local server and WASM build script
runtime/      Complete modified Butterscotch source
patches/      Runtime changes against the upstream base commit
```

## Rebuild the runner

The checked-in build uses **Emscripten 6.0.12**. Install that version with [emsdk](https://github.com/emscripten-core/emsdk), activate its environment, then run:

```sh
source /path/to/emsdk/emsdk_env.sh
npm run build:wasm
```

This compiles `runtime/`, updates the files in `public/`, and refreshes the loading-size manifest. No decompilation step is needed: the runner executes the original GameMaker VM bytecode.

## Status

This is a community test build. Browser checks confirmed fresh Classic-game startup, movement, harvesting, inventory, audio output, saved-slot thumbnails, and persistent save/reload. Runtime fixes also address recipe lists, HUD text alignment, array cleanup, collision-grid updates, and queued input releases. Built-in particle textures and the player/droid sparkle effect are supported. The lighting controller resets its overlay on room entry so world lighting does not darken the skills screen. Water and bridge checks use matching pixel coordinates to avoid getting stuck at bridge edges; browser wheel input reaches the original game handlers. Collision responders run in object-index order so fireballs ignite vine walls before being destroyed. Full building/crafting progression and every late-game feature have not been verified. Actual Chromebook and MacBook hardware testing remains outstanding.

## Credits

Forager belongs to HopFrog. This repository contains no Forager game files.

The modified Butterscotch runner and launcher/hosting code use **GNU AGPL v3**. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md). Complete runner source is included in `runtime/`.
