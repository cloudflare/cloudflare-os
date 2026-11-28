/// <reference types="@cloudflare/vitest-plugin/types" />
import type { TestHooks } from "./worker.js";
import type { UnifiAccount } from "../src/account.js";
import type { UnifiConsoleBudget } from "../src/console-budget.js";

declare global {
  namespace Cloudflare {
    interface Env {
      BASE_URL: string;
      UNIFI_ACCOUNT: DurableObjectNamespace<UnifiAccount>;
      UNIFI_CONSOLE_BUDGET: DurableObjectNamespace<UnifiConsoleBudget>;
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
    }
  }
}
