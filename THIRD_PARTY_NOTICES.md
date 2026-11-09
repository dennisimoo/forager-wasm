# Credits and licensing

- **Forager** and its artwork, audio, and game data belong to HopFrog. This repository contains none of them; players supply files from their own copy of the game.
- **Butterscotch**: [ButterscotchRunner/Butterscotch](https://github.com/ButterscotchRunner/Butterscotch), base commit `fcc295961097b801e24f3dd2f9a41851db899ac2`. The modified source is included in `runtime/`, and the changes are recorded in `patches/butterscotch-forager.patch`, `patches/butterscotch-gameplay-fixes.patch`, `patches/butterscotch-wheel.patch`, and `patches/butterscotch-vine-collisions.patch`. Its license is GNU AGPL v3; see `LICENSE` and `runtime/LICENSE`.
- **GameMaker particle textures**: Copyright 2021–2022 YoYo Games Ltd., Apache License 2.0. Original textures are embedded in `runtime/vendor/gamemaker-particles/images.h`; the source revision, notice, and license are included beside it.
- Bundled runtime dependencies retain their upstream license notices in `runtime/vendor/` and in their source files.

The launcher and hosting code are distributed under the GNU AGPL v3 in `LICENSE`. That license grants no rights to Forager or its game files.
