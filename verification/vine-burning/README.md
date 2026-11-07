# Vine collision regression

The fixture retains the original vine wall Create, Step, and fireball-collision bytecode, the original fireball Create/collision bytecode, and the original sprite masks. It replaces unrelated world bookkeeping, projectile movement, explosion damage, and UI events in a temporary game file. Two overlapping wall/fireball pairs use opposite creation orders; a third wall receives no hit.

Generate the fixture and run it with a native noop build:

```sh
UndertaleModCli load public/assets/game.unx --scripts verification/vine-burning/fixture.csx --output /tmp/forager-vines.unx
butterscotch /tmp/forager-vines.unx --headless --exit-at-frame 200 --disable-log-colors --save-folder /tmp/forager-vines-save
```

The old runner reports `VINES ignition FAIL` and `VINES countdown FAIL destroyed=0`. The fixed runner must report both `VINES ignition PASS` and `VINES countdown PASS`: both hit walls ignite, burn for the original two-second countdown, and are destroyed; the unhit wall remains unlit and alive.

For the browser check, serve the launcher on a separate test origin and intercept only its `assets/game.unx` request with the temporary fixture. Evaluate `browser-check.js` as a function after startup. This checks the compiled WASM without replacing the shipped game file or touching players' saves. Before/after native and Chromium results are recorded in `results.json`.
