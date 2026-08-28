import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    alias: {
      // Lets modules that declare an `RpcTarget` be imported at all, and makes the untransformed
      // `@validateRpc()` decorator a no-op (the real one throws outside the wrangler build). See
      // each stub for what it does and does not provide.
      "cloudflare:workers": fileURLToPath(
        new URL("./__tests__/stubs/cloudflare-workers.ts", import.meta.url)),
      "capnweb-validate": fileURLToPath(
        new URL("./__tests__/stubs/capnweb-validate.ts", import.meta.url)),
    },
  },
});
