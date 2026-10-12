/// <reference types="@cloudflare/vitest-plugin/types" />
import type { TestHooks } from "./worker.js";
import type { UnifiAccount } from "../src/account.js";

declare global {
  namespace Cloudflare {
    interface Env {
      BASE_URL: string;
      UNIFI_ACCOUNT: DurableObjectNamespace<UnifiAccount>;
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
    }
  }
}
