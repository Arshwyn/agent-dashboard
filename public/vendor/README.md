# Vendored three.js

`three.min.js` is a minified classic-script bundle of the symbols listed in `three-subset.js` (including `GLTFLoader`), built from the `three@0.187.0` npm package (MIT, see `three.LICENSE`). It is served by the app itself, with no CDN and no network use at runtime.

Rebuild (from a scratch directory that has `three@0.187.0` and `esbuild` installed; the paths are placeholders):

```bash
esbuild three-subset.js --bundle --minify --format=iife --global-name=THREE \
  --alias:three=/path/to/node_modules/three/build/three.module.js \
  --alias:three-loaders=/path/to/node_modules/three/examples/jsm/loaders --legal-comments=none \
  --banner:js="/* three.js r187 (MIT), subset bundle built from three@0.187.0 incl. GLTFLoader; see three.LICENSE and README.md in this folder */" \
  --outfile=three.min.js
```

When the viewer needs another `THREE.*` symbol, add it to `three-subset.js` and rebuild. The bundle is not in `package.json`; the committed file is the reference (`sha256sum public/vendor/three.min.js` to compare after a rebuild).
