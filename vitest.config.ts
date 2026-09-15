import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `*.spec.ts` runs here. The `*.test.ts` files beside them are written
    // against `claude-code/testing` and are run by `claude plugin test .`, in
    // an environment vitest cannot provide.
    include: ["tests/**/*.spec.ts"],
    setupFiles: ["./tests/setup.mjs"],
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
