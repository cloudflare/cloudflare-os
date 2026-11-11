/// <reference types="@cloudflare/vitest-plugin/types" />

// Types for the workerd suite's environment. The pool types `env` as `Cloudflare.Env`, so the
// test-only bindings, declared in `vitest.worker.config.ts` rather than `wrangler.jsonc`, are added
// by augmenting it.

import type { TestHooks, UserAccount } from "./workerd/worker.js";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
      USER_ACCOUNT: DurableObjectNamespace<UserAccount>;
    }
  }
}
