import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-02-02",
        // nodejs_als enables observability context; experimental enables the Reporter stub below
        // and the streaming_tail_worker flag (which workerd refuses without experimental mode).
        compatibilityFlags: ["experimental", "nodejs_als", "streaming_tail_worker"],
        serviceBindings: {
          ERROR_REPORTER: { name: "reporter", entrypoint: "ErrorReporter" },
        },
        // Invocations are only traced (span.isTraced === true) when a tail consumer is attached;
        // the no-op "span-sink" below exists solely so tracing.test.ts can observe span lifetime.
        tails: ["span-sink"],
        workers: [{
          name: "span-sink",
          modules: true,
          compatibilityDate: "2026-02-02",
          compatibilityFlags: ["streaming_tail_worker"],
          // The no-op tail() silences workerd's legacy tail delivery, which it attempts alongside
          // the streaming path.
          script: `export default { tail: () => {}, tailStream: () => () => {} }`,
        }, {
          name: "reporter",
          modules: true,
          script: `
            import { WorkerEntrypoint } from "cloudflare:workers";
            let lastEvent;
            export class ErrorReporter extends WorkerEntrypoint {
              async report(event) {
                // The "reporter-failure" site simulates a down reporter so the caller's
                // isolation can be tested. workerd logs this guest throw server-side
                // ("Error: reporter down" attributed to ErrorReporter.report) — that line is
                // expected test output, not a failure in reportIssue.
                if (event.failureSite === "reporter-failure") {
                  throw new Error("reporter down");
                }
                lastEvent = event;
              }
              async clear() { lastEvent = undefined; }
              async getLast() { return lastEvent; }
            }
          `,
        }],
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    // Asserts the pool actually started; only one file here imports `cloudflare:workers`, so the
    // rest would pass under a Node fallback without noticing.
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
