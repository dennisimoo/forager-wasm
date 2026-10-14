# Forager 2.0.0 bridge edges

The runner's GameMaker compatibility mode rounds point-collision coordinates to integer pixels. Terrain lookup floors the original coordinates into tile cells. At a bridge ending at pixel 720, a sample at 719.5 or 719.75 therefore queried water at pixel 719 and tested the bridge at pixel 720. Neither query found walkable ground, blocking the bridge/shore transition.

The patch makes `WaterCollision` and the four `EntityWaterCollision` samples round once before both terrain and bridge queries. Integer positions retain their previous behavior, and adjacent open water still blocks movement. It does not change global collision semantics or disable collision checks.

The checked-in `public/assets/game.unx` includes this patch and the separate room-lighting patch. With UndertaleModCli from UndertaleModTool commit `f43e12c445c37d50dc6244caa12ccab232983f3f` and .NET 10:

```sh
UndertaleModCli load game-with-room-lighting.unx \
  --scripts patches/forager-consistent-water-collision.csx \
  --output public/assets/game.unx
node scripts/update-loading-manifest.mjs
```

The script rejects already rounded or unexpectedly changed scripts. See `verification/bridge-scroll/` for the focused reproduction. This fixes a reproduced runner/game query mismatch; it is not a comparison with the original proprietary native runner.

Browser wheel input is forwarded to the runner's existing mouse events 60/61. The original skills, feats, gallery, extras, and player handlers determine what each screen does with the wheel.

`butterscotch-wheel.patch` records the wheel export and queue changes against the runner after `butterscotch-gameplay-fixes.patch`. Apply it from the runtime root with `git apply --unidiff-zero`. The source and compiled runner already include it.
