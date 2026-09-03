/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Types for the workerd suite's environment. The pool types `env` as `Cloudflare.Env`, and
// `ctx.exports` from `GlobalProps.mainModule`, so both are declared here: the kit ships no
// wrangler.jsonc of its own, so there is no generated `worker-configuration.d.ts` to carry them.

import type { TrackerHost } from "./workerd/worker.js";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./workerd/worker.js");
      durableNamespaces: "TrackerHost";
    }
    interface Env {
      TRACKER_HOST: DurableObjectNamespace<TrackerHost>;
    }
  }
}
