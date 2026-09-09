import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Unit tests of the libraries' own TypeScript sources (`<name>/__tests__/**`). These are gadget
 * modules, so they get a jsdom document by default; a pure module's test opts into node with a
 * `// @vitest-environment node` header. The server entry is tested with `cloudflare:workers`
 * mocked -- the real Durable Object is exercised by the Workshop backend's workerd suite. A
 * library's import of another (`gadgets:ui/client`), external in its bundle and resolved through the
 * gadget's pins at load time, resolves here to that library's entry in this tree.
 */
export default defineConfig({
  resolve: {
    alias: [{ find: /^gadgets:([a-z][a-z0-9-]*)\/(client|server)$/u, replacement: `${here}/$1/$2.ts` }],
  },
  test: {
    include: ["*/__tests__/**/*.test.ts"],
    environment: "jsdom",
  },
});
