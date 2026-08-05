/* Copies the CAD translators' WASM payloads out of node_modules into public/.
   Runs from `prebuild`, so a production build always ships the same binaries the
   installed packages provide.

   These deliberately do *not* go through the bundler. Both are fetched at
   runtime, and only when someone actually opens a model of that format:
     - occt-import-js: its emscripten glue is injected as a <script> by
       lib/model-loaders.ts, which then finds the .wasm sitting next to it.
     - rhino3dm: three's Rhino3dmLoader fetches rhino3dm.js + rhino3dm.wasm from
       whatever setLibraryPath() points at and builds its own worker from them.
   Keeping them out of the graph is what stops ~13 MB of OpenCascade from ever
   reaching someone who only ever looks at an OBJ.                              */

import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ASSETS = [
  ["node_modules/occt-import-js/dist/occt-import-js.js", "public/wasm/occt/occt-import-js.js"],
  ["node_modules/occt-import-js/dist/occt-import-js.wasm", "public/wasm/occt/occt-import-js.wasm"],
  ["node_modules/rhino3dm/rhino3dm.js", "public/wasm/rhino3dm/rhino3dm.js"],
  ["node_modules/rhino3dm/rhino3dm.wasm", "public/wasm/rhino3dm/rhino3dm.wasm"],
];

for (const [from, to] of ASSETS) {
  const target = join(root, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, from), target);
  const kb = Math.round(statSync(target).size / 1024);
  console.log(`wasm: ${to} (${kb} kB)`);
}
