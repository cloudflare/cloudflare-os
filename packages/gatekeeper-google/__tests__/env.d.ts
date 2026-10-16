/// <reference types="@cloudflare/vitest-plugin/types" />

import type { TestHooks, UserAccount } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
      USER_ACCOUNT: DurableObjectNamespace<UserAccount>;
    }
  }
}
