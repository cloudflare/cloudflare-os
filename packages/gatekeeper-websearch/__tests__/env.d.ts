/// <reference types="@cloudflare/vitest-plugin/types" />

import type { WebSearchGatekeeper } from "../src/worker.js";

declare global {
  namespace Cloudflare {
    interface Env {
      // Declared only in vitest.config.ts; production reaches this class through facets.
      WEB_SEARCH_GATEKEEPER: DurableObjectNamespace<WebSearchGatekeeper>;
    }
  }
}
