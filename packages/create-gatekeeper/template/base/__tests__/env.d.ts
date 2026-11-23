/// <reference types="@cloudflare/vitest-plugin/types" />

// The workerd suite's bindings, which vitest.worker.config.ts declares and wrangler.jsonc does not.

import type { UserAccount } from "../src/acme";
import type { TestHost } from "./workerd/worker";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_HOST: DurableObjectNamespace<TestHost>;
      USER_ACCOUNT: DurableObjectNamespace<UserAccount>;
    }
  }
}
