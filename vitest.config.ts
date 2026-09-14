import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Two suites, one runner. `test/` is the CLI's; `mod/tests/*.spec.ts` is
    // the mod's, and is deliberately a different suffix from the `*.test.ts`
    // files beside it — those are written against `claude-code/testing` and are
    // run by `claude plugin test`, in an environment vitest cannot provide.
    include: ["test/**/*.test.ts", "mod/tests/**/*.spec.ts"],
    setupFiles: ["./mod/tests/setup.mjs"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    reporters: ["default"],
  },
  esbuild: {
    jsxFactory: "h",
    jsxFragment: "Fragment",
  },
});
