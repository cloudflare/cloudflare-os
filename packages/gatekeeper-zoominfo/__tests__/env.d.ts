/// <reference types="@cloudflare/vitest-plugin/types" />

// Types for the workerd suite's environment. The pool types `env` as `Cloudflare.Env`, so the
// test-only bindings, declared in `vitest.config.ts` rather than `wrangler.jsonc`, are added by
// augmenting it.

import type { TestHooks } from "./worker.js";
import type { UserAccount } from "../src/zoominfo.js";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
      USER_ACCOUNT: DurableObjectNamespace<UserAccount>;
    }
  }
}
