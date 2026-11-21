import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: false,
    // Fork workers outlive a killed parent (`vitest run | head` → SIGPIPE) and then
    // spin at 100% CPU growing ~80 MB/s each; threads die with the process.
    pool: "threads",
  },
});
