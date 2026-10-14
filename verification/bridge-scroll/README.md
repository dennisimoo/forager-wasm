# Bridge collision and browser wheel verification

`fixture.csx` installs `crossing.gml` in a temporary game file. It retains the original collision scripts and bridge sprite/mask metadata, disables bridge lifecycle side effects, and enables the room-gated queries in the fixture room. It samples the player mask across two bridges between grass tiles in both directions and along both axes at integer, quarter-, half-, and three-quarter-pixel coordinates, and checks adjacent open water remains blocked.

From the repository root, use UndertaleModCli and a native build of the checked-in runner:

```sh
UndertaleModCli load game.unx --scripts verification/bridge-scroll/fixture.csx --output /tmp/bridge-fixture.unx
butterscotch /tmp/bridge-fixture.unx --exit-at-frame 2 --disable-log-colors
```

The native unpatched file reports `BRIDGE checks=792 failures=8`; the patched file reports `BRIDGE checks=792 failures=0`. The same patched fixture also reports zero failures in the browser WASM runner. This is a focused game-script/runner reproduction, not an exhaustive playthrough or the user's saved world.

`wheel-fixture.csx` creates `objGame` at zoom 2 and `objSkillGridControl`, retaining its original Mouse 60/61 handlers while clearing unrelated events. Load that temporary fixture through the browser launcher on a separate test origin. Dispatching a cancelable canvas WheelEvent with deltaY 100 changes zoom to 2.1; deltaY -100 returns it to 2. The downward event is defaultPrevented, so it does not scroll the webpage. Results are recorded in `results.json`.

Temporary fixture game data must never replace the shipped game file or enter a deployment.
