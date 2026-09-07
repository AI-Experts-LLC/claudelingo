import fs from "node:fs";
import path from "node:path";

// tsc emits JS only; the bundled word lists have to be copied alongside it.
const from = path.resolve("src/packs");
const to = path.resolve("dist/packs");
fs.mkdirSync(to, { recursive: true });
let copied = 0;
for (const file of fs.readdirSync(from)) {
  if (!file.endsWith(".json")) continue;
  fs.copyFileSync(path.join(from, file), path.join(to, file));
  copied++;
}
console.log(`copied ${copied} pack(s) to dist/packs`);
