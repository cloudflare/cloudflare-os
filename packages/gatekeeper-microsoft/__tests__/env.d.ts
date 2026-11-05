/// <reference types="@cloudflare/vitest-plugin/types" />

// Types for the workerd suites' environment. The pool types `env` as `Cloudflare.Env`, so the
// test-only bindings, declared in the vitest configs rather than `wrangler.jsonc`, are added by
// augmenting it.

import type { TestHooks } from "./workerd/worker.js";
import type { OutlookHookDriver, UserAccount } from "../src/microsoft.js";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
      USER_ACCOUNT: DurableObjectNamespace<UserAccount>;
      SHAREPOINT_GATEKEEPER: DurableObjectNamespace;
      OUTLOOK_GATEKEEPER: DurableObjectNamespace;
      OUTLOOK_HOOK_DRIVER: DurableObjectNamespace<OutlookHookDriver>;
      CALENDAR_GATEKEEPER: DurableObjectNamespace;
      /** The live contract suite's accounts, as JSON of `ContractAccount[]`; absent elsewhere. */
      CONTRACT_ACCOUNTS?: string;
    }
  }
}
