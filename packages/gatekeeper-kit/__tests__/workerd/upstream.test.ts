import {
  SUBSERVICE_V1_SLOTS, type SubserviceCallInput, type SubserviceTally,
} from "@gadgets/observability/metrics";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { ID, type Routes } from "../../src/route-operation";
import {
  defineUpstream, recordCall, summedInto, type RetryPolicy, type UpstreamFetch,
  type UpstreamRequestInit,
} from "../../src/upstream";

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

// What a request holds, as the answer of `echo` tells it.
type Echoed = { method: string; headers: Record<string, string>; body: string; redirect: string };

// A fetch that reads its input and init as the runtime's own does, into a `Request`, fails as that
// one does where the request's signal has aborted, and answers with what the request holds.
const echo: UpstreamFetch = async (input, init) => {
  const request = new Request(input, init);
  request.signal.throwIfAborted();
  const echoed: Echoed = {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body: await request.text(),
    redirect: request.redirect,
  };
  return Response.json(echoed);
};
const echoing = upstream.with({ fetch: echo });

// A Request to give for an init, which holds everything but the URL of the request to send.
function givenForInit(): Request {
  return new Request("https://elsewhere.example/", {
    method: "PUT", headers: { "X-Api": "2", "Content-Type": "text/plain" }, body: "payload",
    redirect: "manual",
  });
}

// A Request that has a body.
function putRequest(): Request {
  return new Request(`${API}/threads/18c2`, { method: "PUT", body: "payload" });
}

// A Request whose signal has aborted.
function stoppedRequest(): Request {
  return new Request(`${API}/threads/18c2`, { signal: AbortSignal.abort(new Error("stop")) });
}

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

  it("sends what a Request given for the init holds, through `request` and through `fetcher`", async () => {
    const held: Echoed = {
      method: "PUT", headers: { "content-type": "text/plain", "x-api": "2" }, body: "payload",
      redirect: "manual",
    };
    const { tally, added } = keeping();

    // The runtime's own reading of a Request given for an init, which the client's is to match.
    expect(await (await echo(`${API}/threads/18c2`, givenForInit())).json()).toEqual(held);
    const [requested, fetched] = await summedInto(tally, async () => [
      await (await echoing.request(`${API}/threads/18c2`, givenForInit())).json(),
      await (await echoing.fetcher()(`${API}/threads/18c2`, givenForInit())).json(),
    ]);

    expect(requested).toEqual(held);
    expect(fetched).toEqual(held);
    expect(kinds(added)).toEqual([["threads.update", "success"], ["threads.update", "success"]]);
  });

  it("sends again a Request whose body the init replaces, the replacement each time", async () => {
    const { tally, added } = keeping();
    const bodies: string[] = [];
    // Answers the first request it reads 503 and the next 200, keeping the body each one holds.
    const busyOnce = upstream.with({
      retry: { attempts: 2 },
      fetch: async (input, init) => {
        bodies.push(await new Request(input, init).text());
        return new Response("{}", { status: bodies.length === 1 ? 503 : 200, headers: { "Retry-After": "0" } });
      },
    });
    const read = putRequest();
    const sent = putRequest();
    const replacing: RequestInit = { body: "replacement" };

    // The runtime's own reading: the init's body is the one sent, and the Request's is left unread.
    expect(await new Request(read, replacing).text()).toBe("replacement");
    expect(read.bodyUsed).toBe(false);
    const response = await summedInto(
      tally, () => busyOnce.request(sent, { ...replacing, idempotent: true }));

    expect(response.status).toBe(200);
    expect(bodies).toEqual(["replacement", "replacement"]);
    expect(sent.bodyUsed).toBe(false);
    expect(kinds(added)).toEqual([["threads.update", "error"], ["threads.update", "success"]]);
  });

  it("sends a Request whose signal has aborted where the init's signal is null, as fetch does", async () => {
    const { tally, added } = keeping();

    // The runtime's own reading: the init's `null` clears the signal of the Request.
    await expect(echo(stoppedRequest())).rejects.toThrow("stop");
    expect((await echo(stoppedRequest(), { signal: null })).status).toBe(200);
    const answers = await summedInto(tally, async () => [
      (await echoing.request(stoppedRequest(), { signal: null })).status,
      (await echoing.request(stoppedRequest(), { signal: null, timeoutMs: null })).status,
      await echoing.read(stoppedRequest(), { signal: null }, response => response.status),
    ]);
    await expect(summedInto(tally, () => echoing.request(stoppedRequest()))).rejects.toThrow("stop");

    expect(answers).toEqual([200, 200, 200]);
    // The one whose signal was not cleared is its caller's to give up, and is not counted.
    expect(kinds(added)).toEqual([["threads.get", "success"], ["threads.get", "success"], ["threads.get", "success"]]);
  });

  it("parses an answer whose `answer` hook was asked, the hook being given no body to lock", async () => {
    const { tally, added } = keeping();
    const given: unknown[] = [];

    const echoed = await summedInto(tally, () => echoing.read(`${API}/threads/18c2`, {
      answer: answered => {
        given.push(answered);
        // What code that is not type-checked may do with an answer: take a reader of its body.
        const body: unknown = Reflect.get(answered, "body");
        if (body instanceof ReadableStream) body.getReader();
        return answered.status === 200 ? { outcome: "refused", reason: "busy" } : undefined;
      },
    }, response => response.json<Echoed>()));

    expect(echoed.method).toBe("GET");
    expect(given).toEqual([{ status: 200, headers: expect.any(Headers) }]);
    expect(given.map(answered => answered instanceof Response)).toEqual([false]);
    expect(added.map(call => [call.operation, call.outcome, call.reason]))
        .toEqual([["threads.get", "refused", "busy"]]);
  });

  it("sends once a GET answered 429 that its retry rule would not send again, though its body then times out", async () => {
    const { tally, added } = keeping();
    let sends = 0;
    // Answers at once, with a body that fails with the reason of the attempt's signal.
    const stalling = upstream.with({
      retry: { baseDelayMs: 0, retryable: () => false },
      fetch: async (_input, init) => {
        sends++;
        const signal = init?.signal;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(signal.reason));
          },
        }), { status: 429, headers: { "Retry-After": "120" } });
      },
    });

    await expect(summedInto(tally, () =>
      stalling.read(`${API}/threads`, { timeoutMs: 5 }, response => response.text())))
        .rejects.toMatchObject({ name: "TimeoutError" });

    expect(sends).toBe(1);
    expect(added.map(call => [call.operation, call.outcome, call.reason]))
        .toEqual([["threads.list", "refused", "rate"]]);
  });

  it.each<[string, number, RetryPolicy | null, UpstreamRequestInit]>([
    ["replay", 401, null, { replay: response => response.status === 401 }],
    ["retry", 503, { baseDelayMs: 0 }, {}],
  ])("sends no %s whose headers are asked for as the caller's signal aborts", async (_name, status, retry, init) => {
    const { tally, added } = keeping();
    const caller = new AbortController();
    const stop = new Error("stop");
    let sends = 0;
    let asked = 0;
    // A transport that answers whatever the signal it is handed.
    const deaf = upstream.with({
      retry,
      fetch: async () => new Response("{}", { status: ++sends === 1 ? status : 200 }),
    });

    await expect(summedInto(tally, () => deaf.request(`${API}/threads/18c2`, {
      ...init,
      signal: caller.signal,
      authorize: async () => {
        await scheduler.wait(1);
        // The caller gives up while the headers of the second send are looked up.
        if (++asked === 2) caller.abort(stop);
        return { "X-Api": "2" };
      },
    }))).rejects.toBe(stop);

    expect([sends, asked]).toEqual([1, 2]);
    expect(added.map(call => [call.operation, call.outcome, call.reason, call.httpStatus]))
        .toEqual([["threads.get", "error", "http", status]]);
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
