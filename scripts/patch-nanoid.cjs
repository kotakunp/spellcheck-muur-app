// nanoid v3.3.18+ exports an object instead of a callable function.
// hunspell-asm / emscripten-wasm-loader still do `const nanoid = require("nanoid")`
// and call it directly. Rewrite to the named import so the security-patched
// nanoid (override ^3.3.19) keeps working. Idempotent.
const fs = require("node:fs");
const path = require("node:path");

const FROM_CJS = 'const nanoid = require("nanoid");';
const TO_CJS = 'const { nanoid } = require("nanoid");';
const FROM_ESM = 'import nanoid from "nanoid";';
const TO_ESM = 'import { nanoid } from "nanoid";';

const roots = [
  "node_modules/hunspell-asm/dist",
  "node_modules/emscripten-wasm-loader/dist",
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".js")) yield full;
  }
}

let patched = 0;
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    const src = fs.readFileSync(file, "utf8");
    const out = src.split(FROM_CJS).join(TO_CJS).split(FROM_ESM).join(TO_ESM);
    if (out !== src) {
      fs.writeFileSync(file, out);
      console.log(`patched nanoid import: ${file}`);
      patched++;
    }
  }
}
console.log(`nanoid import patch: ${patched} file(s) updated`);
