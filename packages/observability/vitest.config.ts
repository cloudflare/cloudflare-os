import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-09-04",
        // nodejs_als enables observability context; experimental enables the Reporter stub below.
        compatibilityFlags: ["experimental", "nodejs_als"],
        serviceBindings: {
          ERROR_REPORTER: { name: "reporter", entrypoint: "ErrorReporter" },
        },
        workers: [{
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
    // Asserts the pool actually started; only two files here import `cloudflare:workers`, so the
    // rest would pass under a Node fallback without noticing.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
