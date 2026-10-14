# Forager 2.0.0 room lighting

The persistent `LightControl` object kept its world `overlayAlpha` when entering the skills room. Its normal Draw event multiplied the skill tree by that stale lighting overlay; the GUI header and controls were drawn afterward and stayed bright.

The patch prepends `overlayAlpha = 0;` to the controller's Room Start event, `gml_Object_LightControl_Other_4`. The original Draw event still calculates world lighting from `TimeControl` and enables the existing dungeon lighting paths. No global brightness filter or renderer override is added.

The checked-in `public/assets/game.unx` includes this patch. To apply it to the unpatched 2.0.0 file, use UndertaleModCli built from UndertaleModTool commit `f43e12c445c37d50dc6244caa12ccab232983f3f` with .NET 10:

```sh
UndertaleModCli load original-game.unx \
  --scripts patches/forager-reset-room-lighting.csx \
  --output public/assets/game.unx
node scripts/update-loading-manifest.mjs
```

The script rejects a Room Start event that already changes `overlayAlpha`. Review the existing event before applying it to another build. The loading manifest gives the patched data a new browser-cache version.
