/// <reference types="@cloudflare/vitest-plugin/types" />

import type { TestHooks, UserAccount } from "./worker.js";
import type { CalendarTestHooks } from "./calendar-hooks.js";

declare global {
  namespace Cloudflare {
    interface Env {
      CALENDAR_TEST_HOOKS: DurableObjectNamespace<CalendarTestHooks>;
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
      USER_ACCOUNT: DurableObjectNamespace<UserAccount>;
    }
  }
}
