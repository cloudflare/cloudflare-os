/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { TestHooks } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
    }
  }
}
