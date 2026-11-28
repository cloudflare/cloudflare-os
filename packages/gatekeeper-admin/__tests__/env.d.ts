/// <reference types="@cloudflare/vitest-plugin/types" />

// Types for the test suites. A script, not a module, so its declarations are global: the workerd
// pool types `env` as `Cloudflare.Env`, so the test-only bindings, declared in
// `vitest.worker.config.ts` rather than `wrangler.jsonc`, are added by augmenting that.

declare namespace Cloudflare {
  interface Env {
    TEST_HOST: DurableObjectNamespace<import("./workerd/worker.js").TestHost>;
    USER_ACCOUNT: DurableObjectNamespace<import("../src/admin.js").UserAccount>;
  }
}

// Vite's `?raw` suffix, with which a suite reads a source file as a string.
declare module "*?raw" {
  const content: string;
  export default content;
}
