/// <reference types="@cloudflare/vitest-plugin/types" />

// Types for the test suites. A script, not a module, so its declarations are global: the workerd
// pool types `env` as `Cloudflare.Env`, so the test-only binding, declared in
// `vitest.worker.config.ts` rather than `wrangler.jsonc`, is added by augmenting that.

declare namespace Cloudflare {
  interface Env {
    ADMIN_GATEKEEPER: DurableObjectNamespace<import("../src/worker.js").AdminGatekeeperImpl>;
  }
}

// Vite's `?raw` suffix, with which the Node suite reads a source file as a string.
declare module "*?raw" {
  const content: string;
  export default content;
}
