import {
  SUBSERVICE_V1_SLOTS, type SubserviceCallInput, type SubserviceTally,
} from "@gadgets/observability/metrics";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { ID, type Routes } from "../../src/route-operation";
import { defineUpstream, recordCall, summedInto } from "../../src/upstream";

const API = "https://api.vendor.example/v1";
const ROUTES: Routes = [[`${API}/`, { threads: { [ID]: {} } }]];

// An upstream whose fetch answers each request after a real wait, with the status its URL asks for.
const upstream = defineUpstream({
  vendorId: "vendor",
  routes: ROUTES,
  retry: null,
  fetch: async input => {
    await scheduler.wait(1);
    return new Response("{}", { status: Number(new URL(String(input)).searchParams.get("status") ?? 200) });
  },
});

// A tally that keeps each call added to it.
function keeping(): { tally: SubserviceTally; added: SubserviceCallInput[] } {
  const added: SubserviceCallInput[] = [];
  return { tally: { add: input => { added.push(input); }, flush() {} }, added };
}

// Each call's operation and outcome.
function kinds(added: SubserviceCallInput[]) {
  return added.map(call => [call.operation, call.outcome]);
}

/**
 * The Node suite covers the client's rules. What needs the real runtime is that the leaf loads
 * there with its `node:async_hooks` import, that its tally follows work across the runtime's own
 * awaits and timers, and that the timeout is the runtime's own `AbortSignal.timeout`. It does not
 * show which compatibility flag provides `node:async_hooks`: the test pool gives its runner
 * Worker Node compatibility whatever the config lists.
 */
describe("upstream in workerd", () => {
  const ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
  });

  it("sums the calls of work into its tally across awaits, timers and concurrent requests", async () => {
    const { tally, added } = keeping();

    const answered = await summedInto(tally, async () => {
      await upstream.request(`${API}/threads/18c2`);
      await scheduler.wait(1);
      await Promise.all([
        upstream.request(`${API}/threads`, { method: "POST" }),
        upstream.read(`${API}/threads?status=404`, undefined, response => response.status),
        upstream.call("command", async () => { await scheduler.wait(1); }),
      ]);
      recordCall({ source: upstream.source, service: "vendor", operation: "own", outcome: "success" });
      return "answer";
    });

    expect(answered).toBe("answer");
    expect(kinds(added).toSorted()).toEqual([
      ["command", "success"], ["own", "success"], ["threads.create", "success"],
      ["threads.get", "success"], ["threads.list", "error"],
    ]);
  });

  it("keeps apart the calls of two tallies running at once", async () => {
    const first = keeping();
    const second = keeping();

    await Promise.all([
      summedInto(first.tally, () => upstream.request(`${API}/threads/18c2`)),
      summedInto(second.tally, async () => {
        await upstream.request(`${API}/threads`);
        await upstream.request(`${API}/threads`);
      }),
    ]);

    expect(kinds(first.added)).toEqual([["threads.get", "success"]]);
    expect(kinds(second.added)).toEqual([["threads.list", "success"], ["threads.list", "success"]]);
  });

  // Binds a dataset that keeps the points written to it.
  function dataset() {
    const points: AnalyticsEngineDataPoint[] = [];
    ambient.METRICS = { writeDataPoint: point => { if (point) points.push(point); } };
    ambient.SUBSERVICE_METRICS = "true";
    // The operation of each point written, beside how many calls it stands for.
    const written = () => points.map(point => [
      point.blobs?.[Number(SUBSERVICE_V1_SLOTS.operation.replace(/\D+/, "")) - 1],
      point.doubles?.[Number(SUBSERVICE_V1_SLOTS.calls.replace(/\D+/, "")) - 1],
    ]);
    return { points, written };
  }

  it("writes one point per kind of call once summed work settles, and each call at once outside it", async () => {
    const { points, written } = dataset();

    await upstream.summed(async () => {
      for (let page = 0; page < 3; page++) await upstream.request(`${API}/threads`);
      await upstream.request(`${API}/threads/18c2`);
      expect(points).toEqual([]);
    });
    expect(written()).toEqual([["threads.list", 3], ["threads.get", 1]]);

    await upstream.request(`${API}/threads/18c2`);
    expect(written()).toEqual([["threads.list", 3], ["threads.get", 1], ["threads.get", 1]]);
  });

  it("writes at once the calls of work that summed work left running, a `summed` in it summing anew", async () => {
    const { written } = dataset();
    let background: Promise<void> | undefined;

    await upstream.summed(async () => {
      await upstream.request(`${API}/threads/18c2`);
      background = (async () => {
        await scheduler.wait(5);
        await upstream.request(`${API}/threads`, { method: "POST" });
        await upstream.summed(async () => {
          await upstream.request(`${API}/threads`);
          await upstream.request(`${API}/threads`);
        });
      })();
    });
    expect(written()).toEqual([["threads.get", 1]]);

    await background;
    expect(written()).toEqual([["threads.get", 1], ["threads.create", 1], ["threads.list", 2]]);
  });

  it("cuts off an attempt by the runtime's own timeout, and counts it one", async () => {
    const { tally, added } = keeping();
    const silent = upstream.with({
      fetch: (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
    });

    await expect(summedInto(tally, () => silent.request(`${API}/threads`, { timeoutMs: 5 })))
        .rejects.toMatchObject({ name: "TimeoutError" });

    expect(added.map(call => [call.operation, call.outcome, call.reason]))
        .toEqual([["threads.list", "error", "timeout"]]);
  });
});
