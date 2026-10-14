# Forager 2.0 runtime regression checks

The native check calls the runner's actual registered builtins and collision grid. It checks array ownership when deleting list entries, collision membership through movement/activation/destruction, and smoke/sparkle type registration, pool reuse, and expiry.

Build a native runner with Clang and the noop backend, then run:

```sh
cmake -S runtime -B /tmp/forager-runtime-check -DCMAKE_C_COMPILER=clang -DCMAKE_BUILD_TYPE=Release -DPLATFORM=cli -DBACKEND=noop -DAUDIO_BACKEND=none -DVIDEO_BACKEND=none -DENABLE_MODERN_GL=OFF -DENABLE_LEGACY_GL=OFF
cmake --build /tmp/forager-runtime-check -j4
python3 verification/runtime-fixes/run-native.py /tmp/forager-runtime-check
```

`browser-fixture.csx` uses UndertaleModCli to create a separate diagnostic game file. It exercises the real WASM input queue and WebGL particle textures. Apply it to a temporary copy, never overwrite the shipped game data. Its bridge object records input state and release counts, while the draw event shows smoke and the three sparkle sizes. Evaluate `browser-check.js` as a function on this fixture page to send 2,002 events and verify that both inputs are released.

Particle textures are the original Apache-2.0 GameMaker HTML5 textures, embedded with their license and source revision in `runtime/vendor/gamemaker-particles`. The supported built-in effect is kind 7, the sparkle effect used by Forager; all 14 particle shapes are available.

`room-fixture.csx` checks collision membership after restoring a persistent room with an instance moved immediately before the transition. The gameplay source patch applies after `butterscotch-forager.patch` using `git apply --unidiff-zero`; its additional particle textures are included under `runtime/vendor/gamemaker-particles/`.
