import { defineConfig } from "vitest/config";

/** The renderer held to its limits in Node, over modules compiled from the vendored files' bytes. */
export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    // The tests run PDFium's own code, some of them to the end of the work a call may do, which
    // a shared CI runner takes several times as long over as a workstation does.
    testTimeout: 30_000,
  },
});
