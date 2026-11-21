/// <reference types="@cloudflare/vitest-plugin/types" />

// Types for the test suites. A script, not a module, so its declarations are global: the workerd
// pool types `env` as `Cloudflare.Env`, so the test-only bindings, declared in
// `vitest.worker.config.ts` rather than `wrangler.jsonc`, are added by augmenting that.

declare namespace Cloudflare {
  interface Env {
    ADMIN_GATEKEEPER: DurableObjectNamespace<import("../src/worker.js").AdminGatekeeperImpl>;
    ISSUE_REPORT_HOOK_DRIVER: DurableObjectNamespace<import("../src/hooks.js").IssueReportHookDriver>;
  }
}

// Vite's `?raw` suffix, with which the Node suite reads a source file as a string.
declare module "*?raw" {
  const content: string;
  export default content;
}
