/**
 * Verify the committed `dist/` matches what `src/` compiles to.
 *
 * `dist/` is committed because installing a Claude Code plugin is a clone, not a
 * build — there is no npm step on the way in. That trade means the tree can drift
 * from its source silently, so this compares them and says exactly which files
 * differ.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "claudelingo-dist-"));

try {
  // Exactly the build's own settings, or every file "differs" by its trailing
  // sourceMappingURL comment and the check cries wolf.
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json", "--outDir", out], {
    cwd: root,
    stdio: "pipe",
  });

  const walk = (dir, base = "") =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const rel = path.join(base, entry.name);
      return entry.isDirectory()
        ? walk(path.join(dir, entry.name), rel)
        : rel.endsWith(".js")
          ? [rel]
          : [];
    });

  const drifted = [];
  for (const rel of walk(out)) {
    const committed = path.join(root, "dist", rel);
    if (!fs.existsSync(committed)) {
      drifted.push(`${rel} (missing from dist/)`);
      continue;
    }
    if (fs.readFileSync(committed, "utf8") !== fs.readFileSync(path.join(out, rel), "utf8")) {
      drifted.push(rel);
    }
  }

  if (drifted.length) {
    console.error("dist/ is out of date. Run `npm run build` and commit:\n  " + drifted.join("\n  "));
    process.exit(1);
  }
  console.log(`dist/ matches src/ (${walk(out).length} files)`);
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
