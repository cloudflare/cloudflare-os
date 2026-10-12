/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Types for the workerd suite's environment. The pool types `env` as `Cloudflare.Env`, so the
// test-only bindings, declared in `vitest.worker.config.ts` rather than `wrangler.jsonc`, are added
// by augmenting it.

import type { TestHooks } from "./workerd/worker.js";
import type { UserAccount, XActivityRouter, XHookDriver, XWebhookRegistry } from "../src/x.js";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
      USER_ACCOUNT: DurableObjectNamespace<UserAccount>;
      X_GATEKEEPER: DurableObjectNamespace;
      X_HOOK_DRIVER: DurableObjectNamespace<XHookDriver>;
      X_ACTIVITY_ROUTER: DurableObjectNamespace<XActivityRouter>;
      X_WEBHOOK_REGISTRY: DurableObjectNamespace<XWebhookRegistry>;
    }
  }
}
