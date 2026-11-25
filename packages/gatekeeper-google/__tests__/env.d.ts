/// <reference types="@cloudflare/vitest-plugin/types" />

import type { TestHooks, UserAccount } from "./worker.js";
import type { CalendarTestHooks } from "./calendar-hooks.js";
import type { DocCopyHost, DocStoreHost } from "./docs-copy-hosts.js";

declare global {
  namespace Cloudflare {
    interface Env {
      CALENDAR_TEST_HOOKS: DurableObjectNamespace<CalendarTestHooks>;
      DOC_COPY_HOST: DurableObjectNamespace<DocCopyHost>;
      DOC_STORE_HOST: DurableObjectNamespace<DocStoreHost>;
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
      USER_ACCOUNT: DurableObjectNamespace<UserAccount>;
    }
  }
}
