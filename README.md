# Forager 4.1.9 WASM

<p align="center"><img src="public/ui/logo.png" alt="Forager" width="380"></p>

An experimental browser port of **Forager 4.1.9**, the newer version being worked on in this repository. Its native game code is translated into WebAssembly with [ARET](https://github.com/aciderix/Automatic-reverse-engineering-toolkit), with browser graphics, audio, input, and save storage.

**This build is laggy and unfinished.** Expect slow loading, stutters, high resource use, and bugs. It has not reached 60 FPS. The best local Classic-world measurement was about **16 FPS at 1920×1080** on a machine using software graphics. Performance on a hardware GPU has not been verified.

This branch, `codex/forager-4.1.9`, contains the newer build. [`main`](https://github.com/dennisimoo/forager-wasm/tree/main) keeps the older **2.0.0** port and its [existing playable site](https://forager-wasm.4dennisk.workers.dev).

## What works so far

- Intro, main menu, and Classic-world startup.
- Movement, harvesting berries and stone, collecting drops, and visible inventory counts.
- Placing a furnace.
- Reloading the same saved world, position, XP, and inventory after a complete browser restart.
- Fullscreen, native 1920×1080 output, and cached game downloads.
- Audio scheduling without gaps in the captured test. Sound quality on player hardware still needs checking.

Completing crafting recipes, skills, island expansion, and later progression have not been verified. Online networking is disabled. Some native timing features are unsupported, and other compatibility bugs may remain. These checks do not prove the full game works.

## Run locally

Requires Node.js 22 or newer and a current Chrome browser with WebAssembly JSPI and WebGL 2 support.

```sh
git clone --branch codex/forager-4.1.9 https://github.com/dennisimoo/forager-wasm.git
cd forager-wasm
npm ci
npm run dev
```

Open **http://localhost:8767**. The game starts automatically. Click or press a key to enable audio. Use WASD to move, the left mouse button to harvest or interact, and Esc for the inventory/menu. The bottom-right button toggles fullscreen.

The compiled WASM module and game data are included as compressed files in `artifacts/`. Starting the server unpacks them and checks their hashes. No game compilation is needed to run this build.

Downloads are cached and reused on the same site. Saves stay in that browser's storage for that origin. Clearing site data, using private browsing, or changing the hostname can remove or separate saves. Saves from the older port are not verified as compatible with this version.

## Deploy this branch

This branch uses a separate Worker, **`forager-wasm-4-1-9`**, and a separate R2 bucket. It does not replace the older site's Worker.

```sh
npx wrangler login
npx wrangler r2 bucket create forager-wasm-4-1-9-assets
npm run upload:game
npm run deploy
```

R2 serves the WASM module and `data.win`, which exceed Cloudflare's static-file size limit. The Worker serves the remaining files and required isolation headers through the same origin. Upload the two large files again whenever their contents change, then deploy the updated launcher and cache manifest.

Pushing this branch does not deploy the site. Share the URL printed by Wrangler after deployment.

## Source and verification

`public/` contains the browser runtime, shader translations, game assets, and vendored WASI shim. `native-runtime/aret/` contains the modified translator and native runtime source; `native-runtime/aret-base.txt` records the upstream base commit. The changes to tracked upstream files are also in `patches/aret-forager.patch`.

The precompiled module contains 168 optimized native code chunks. Regenerating it requires the original executable, Emscripten, and the translation/build pipeline; this branch is packaged for running the current build, not as a one-command native rebuild.

`verification/` contains the completion audit, native API checks, audio measurements, performance comparison, and inventory/building screenshots. Full playability and 60 FPS remain incomplete.

Forager and its game assets belong to their original creators. Dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The older Butterscotch source remains in `runtime/` from main.
