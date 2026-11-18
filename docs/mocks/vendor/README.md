# Vendored three.js

`three.min.js` is a minified classic-script bundle of the symbols listed in `three-subset.js`, taken from the `three@0.187.0` npm package (MIT, see `three.LICENSE`). A classic script is used because browsers block ES modules loaded from `file://`, and these mocks must open straight from the file system.

Rebuild (from a scratch directory that has `three@0.187.0` and `esbuild` installed; the paths are placeholders):

```bash
esbuild three-subset.js --bundle --minify --format=iife --global-name=THREE \
  --alias:three=/path/to/node_modules/three/build/three.module.js --legal-comments=none \
  --banner:js="/* three.js r187 (MIT), subset bundle built from three@0.187.0; see three.LICENSE and README.md in this folder */" \
  --outfile=three.min.js
```

When a mock needs another `THREE.*` symbol, add it to `three-subset.js` and rebuild. Nothing here is a runtime dependency of the dashboard service: it is not in `package.json` and is only used by the mocks. If the 3D body is approved, slice 2 decides how three.js is shipped.
