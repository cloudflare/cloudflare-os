/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Types for the workerd suite's environment. The pool types `env` as `Cloudflare.Env`, so the
// test-only bindings are declared by augmenting that -- which is what lets the tests read `env`
// without a cast.

import type { TestHooks } from "./workerd/worker.js";
import type { UserAccount } from "../src/github.js";

declare global {
  namespace Cloudflare {
    interface Env {
      // Declared in `vitest.worker.config.ts` rather than `wrangler.jsonc`, so they are absent
      // from the generated `worker-configuration.d.ts`.
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
      USER_ACCOUNT: DurableObjectNamespace<UserAccount>;
    }
  }
}
