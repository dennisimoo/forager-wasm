# Credits and licensing

- **Forager 2.0.0** and its artwork, audio, and game data belong to their respective rights holders. The bundled game assets retain their original rights; they are not licensed under this repository's software license.
- **Butterscotch**: [ButterscotchRunner/Butterscotch](https://github.com/ButterscotchRunner/Butterscotch), base commit `fcc295961097b801e24f3dd2f9a41851db899ac2`. The modified source is included in `runtime/`, and the changes are recorded in `patches/butterscotch-forager.patch`. Its license is GNU AGPL v3; see `LICENSE` and `runtime/LICENSE`.
- Bundled runtime dependencies retain their upstream license notices in `runtime/vendor/` and in their source files.

The launcher and hosting code are distributed under the GNU AGPL v3 in `LICENSE`. That license does not grant rights to Forager's proprietary game assets.

## Experimental 4.1.9 branch

- **Forager 4.1.9** and its translated game code, artwork, audio, and data retain their original rights. They are not licensed under this repository's software license.
- **ARET**: https://github.com/aciderix/Automatic-reverse-engineering-toolkit. The upstream project declares the MIT license in its README and Cargo manifest. The modified source is in `native-runtime/aret/`; its upstream base commit is in `native-runtime/aret-base.txt`.
- **browser_wasi_shim 0.4.2**: https://github.com/bjorn3/browser_wasi_shim, licensed MIT OR Apache-2.0. The bundled distribution and both license texts are in `public/vendor/browser-wasi-shim/`.
