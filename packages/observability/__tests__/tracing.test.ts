// Runs against the real workerd tracing API (vitest-pool-workers), pinning the platform
// contract `traced` depends on: enterSpan ends its span when the returned promise settles, not
// when the synchronous callback returns (docs: workers/observability/traces/custom-spans/).
//
// Caveats:
// - Invocations are only traced when a tail consumer is attached, so vitest.config.ts wires a
//   no-op streaming tail sink behind the experimental `streaming_tail_worker` flag. If workerd
//   renames or removes that flag, setup fails loudly — a mechanical config fix, not a tracer bug.
// - Attributes are write-only, so "span still open" is inferred from the documented guarantee
//   that `span.isTraced` flips to false once the span ends. The entry assertion in each test
//   guards the signal itself: if invocations stop being traced, isTraced starts false and the
//   test fails rather than silently passing.

import { describe, expect, it } from "vitest";
import { createTracer } from "../src/tracing";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const traced = createTracer(() => ({}));

describe("traced span lifetime", () => {
  it("keeps the span open across awaits in an async callback", async () => {
    const observed: boolean[] = [];
    await traced("probe", async (span) => {
      observed.push(span.isTraced); // must start true — guards the isTraced signal
      await sleep(50);
      observed.push(span.isTraced); // still true ⇒ span did not end at the sync return
    });
    expect(observed).toEqual([true, true]);
  });

  it("records the error attribute before the span can close on rejection", async () => {
    let openWhenErrorSet: boolean | undefined;
    await expect(
      traced("probe-reject", (span) => {
        // Shadow setAttribute to observe the instant traced()'s catch marks the failure.
        const original = span.setAttribute.bind(span);
        span.setAttribute = (key, value) => {
          if (key === "error") openWhenErrorSet = span.isTraced;
          original(key, value);
        };
        return (async () => {
          await sleep(50);
          throw new Error("boom");
        })();
      }),
    ).rejects.toThrow("boom");
    expect(openWhenErrorSet).toBe(true);
  });
});
