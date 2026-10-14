# Forager WASM

<p align="center"><img src="public/ui/logo.png" alt="Forager" width="380"></p>

**[Play Forager](https://forager-wasm.4dennisk.workers.dev)**

Run **Forager 2.0.0** in a browser using a modified [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) WebAssembly runner.

The game starts automatically behind a blue loading screen with the original logo, a progress bar, and download percentage. No game installation is needed on the player's computer.

## Run locally

Requires Node.js 22 or newer. The game data and compiled WASM runner are included.

```sh
git clone https://github.com/dennisimoo/forager-wasm.git
cd forager-wasm
npm ci
npm run dev
```

Open **http://localhost:8767** in current Chrome or Firefox. The server supplies the isolation headers required by the runner; opening the HTML file directly will not work.

| Action               | Control           |
| -------------------- | ----------------- |
| Move                 | WASD              |
| Harvest and interact | Left mouse button |
| Inventory and menu   | Esc               |

Downloaded game files are cached in the browser and reused on reload. Rebuilding the runner refreshes the cache version automatically.

Saves stay in the browser's storage for that site. Changing domains, clearing site data, or using a different browser gives you separate saves.

## Deploy to Cloudflare

The Worker serves the launcher and WASM runner. R2 stores `assets/game.unx`, which exceeds Cloudflare's 25 MiB static-file limit. The complete file is also included in this GitHub repository.

Sign into a Cloudflare account with R2 enabled, then run:

```sh
npx wrangler login
npx wrangler r2 bucket create forager-wasm-assets
npm run upload:game
npm run deploy
```

Wrangler prints the permanent `workers.dev` URL. Share that URL; the local server and temporary tunnel are no longer needed. You can attach a custom domain in Cloudflare afterward.

For later updates, run `npm run deploy`. Run `npm run upload:game` again only when the game data changes. Keep the same hostname to preserve players' browser saves.

## What is included

```text
public/       Launcher, compiled WASM, original game assets
src/          Cloudflare Worker
scripts/      Local server and WASM build script
runtime/      Complete modified Butterscotch source
patches/      Runtime changes against the upstream base commit
```

The Worker streams the large game file from R2 and serves all files through the same origin with `COOP`, `COEP`, and `CORP` headers.

## Rebuild the runner

The checked-in build uses **Emscripten 6.0.12**. Install that version with [emsdk](https://github.com/emscripten-core/emsdk), activate its environment, then run:

```sh
source /path/to/emsdk/emsdk_env.sh
npm run build:wasm
```

This compiles `runtime/`, updates the files in `public/`, and refreshes the loading-size manifest. No decompilation step is needed: the runner executes the original GameMaker VM bytecode.

## Status

This is a community test build. Browser checks confirmed fresh Classic-game startup, movement, harvesting, inventory, audio output, saved-slot thumbnails, and persistent save/reload. Runtime fixes also address recipe lists, HUD text alignment, array cleanup, collision-grid updates, and queued input releases. Built-in particle textures and the player/droid sparkle effect are supported. The lighting controller resets its overlay on room entry so world lighting does not darken the skills screen. Full building/crafting progression and every late-game feature have not been verified. Actual Chromebook and MacBook hardware testing remains outstanding.

## Credits

Forager belongs to its original creators. Game assets retain their original rights.

The modified Butterscotch runner and launcher/hosting code use **GNU AGPL v3**. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md). Complete runner source is included in `runtime/`.
