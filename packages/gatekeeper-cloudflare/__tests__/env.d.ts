/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Types for the workerd suite's environment. The pool types `env` as `Cloudflare.Env`, so the
// test-only bindings are declared by augmenting that -- which is what lets the tests read `env`
// without a cast.

import type { TestHooks } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env {
      // Declared in `vitest.worker.config.ts` rather than `wrangler.jsonc`, so it is absent from the
      // generated `worker-configuration.d.ts`.
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
    }
  }
}
