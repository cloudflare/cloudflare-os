// Unit spec for NetworkInterceptor -- the mechanism every suite in two repos leans on for its
// "nothing reaches the real internet" guarantee. Runs in plain Node against a stubbed real fetch;
// no Workers are booted. The end-to-end half of the guarantee (Worker subrequests actually route
// through the patch) is covered by the fetch-probe case in observer-reverification.test.ts.
//
// These tests swap globalThis.fetch, so they stay serial (no it.concurrent) within this file. The
// observer suite is unaffected because `fileParallelism: false` runs the files one at a time rather
// than side by side, and each swap is undone in afterEach -- not because the files get a process
// each, which Vitest does not promise.

import { afterEach, beforeEach, expect, it } from "vitest";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";

const realFetch = globalThis.fetch;
let fetchedByReal: string[];

beforeEach(() => {
  fetchedByReal = [];
  globalThis.fetch = (async (input: unknown) => {
    fetchedByReal.push(String(input));
    return new Response("from the real fetch");
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const neverAsked: Handler = () => {
  throw new Error("a later handler must not be asked");
};

it("passes loopback traffic through to the real fetch untouched", async () => {
  const interceptor = new NetworkInterceptor();
  interceptor.install();

  const res = await fetch("http://127.0.0.1:1234/harness");
  expect(await res.text()).toBe("from the real fetch");
  expect(fetchedByReal).toEqual(["http://127.0.0.1:1234/harness"]);
  expect(interceptor.getUnmockedCalls()).toEqual([]);
});

it("asks handlers in order and takes the first non-null answer", async () => {
  const asked: string[] = [];
  const declines: Handler = url => { asked.push(`declines ${url.host}`); return null; };
  const answers: Handler = url => { asked.push(`answers ${url.host}`); return new Response("two"); };
  new NetworkInterceptor([declines, answers, neverAsked]).install();

  const res = await fetch("https://vendor.test/api");
  expect(await res.text()).toBe("two");
  expect(asked).toEqual(["declines vendor.test", "answers vendor.test"]);
  expect(fetchedByReal).toEqual([]);
});

it("supports a handler that parks until the test provides an answer", async () => {
  // Load-bearing for the CF Access transfer mock: the Worker starts polling before the test knows
  // what to serve, so a handler must be able to wait (see the Handler type's doc comment).
  let serve!: (body: string) => void;
  const parked = new Promise<string>(resolve => { serve = resolve; });
  new NetworkInterceptor([async () => new Response(await parked)]).install();

  const pending = fetch("https://vendor.test/poll");
  serve("finally");
  expect(await (await pending).text()).toBe("finally");
});

it("hands handlers the method and headers from any fetch input form", async () => {
  const seen: string[] = [];
  const record: Handler = (url, method, headers) => {
    seen.push(`${method} ${url.href} auth=${headers.get("authorization")}`);
    return new Response(null, { status: 204 });
  };
  new NetworkInterceptor([record]).install();

  await fetch("https://a.test/", { method: "post", headers: { authorization: "one" } });
  await fetch(new URL("https://b.test/"));
  await fetch(new Request("https://c.test/", { method: "PUT", headers: { authorization: "three" } }));
  expect(seen).toEqual([
    "POST https://a.test/ auth=one",
    "GET https://b.test/ auth=null",
    "PUT https://c.test/ auth=three",
  ]);
});

it("throws on an unmatched request and records it", async () => {
  const interceptor = new NetworkInterceptor([() => null]);
  interceptor.install();

  await expect(fetch("https://escaped.test/x")).rejects.toThrow(
    "Unmocked outbound request: GET https://escaped.test/x");
  expect(interceptor.getUnmockedCalls()).toEqual(["GET https://escaped.test/x"]);
  expect(fetchedByReal).toEqual([]);

  interceptor.reset();
  expect(interceptor.getUnmockedCalls()).toEqual([]);
});

it("takeUnmockedCalls removes only the matching entries", async () => {
  const interceptor = new NetworkInterceptor();
  interceptor.install();

  await fetch("https://mine.test/probe").catch(() => {});
  await fetch("https://sibling.test/leak").catch(() => {});

  expect(interceptor.takeUnmockedCalls("mine.test")).toEqual(["GET https://mine.test/probe"]);
  // The sibling's escape stays on record for the suite-level assertion.
  expect(interceptor.getUnmockedCalls()).toEqual(["GET https://sibling.test/leak"]);
});

it("uninstall restores the fetch that install captured", async () => {
  const interceptor = new NetworkInterceptor();
  const captured = globalThis.fetch;
  interceptor.install();
  expect(globalThis.fetch).not.toBe(captured);

  interceptor.uninstall();
  expect(globalThis.fetch).toBe(captured);

  // And the same instance can install again after the round trip.
  interceptor.install();
  await expect(fetch("https://later.test/")).rejects.toThrow(/Unmocked outbound request/);
  interceptor.uninstall();
});

it("passes an allowed host through to the real fetch, body intact", async () => {
  const seen: { url: string; method: string; body: string }[] = [];
  const captured = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, method: request.method, body: await request.text() });
    return Response.json({ ok: true });
  }) as typeof globalThis.fetch;

  const interceptor = new NetworkInterceptor([], { passThroughHosts: ["allowed.test"] });
  interceptor.install();
  try {
    const response = await fetch("https://allowed.test/v1/chat", {
      method: "POST",
      body: JSON.stringify({ prompt: "hello" }),
    });
    expect(await response.json()).toEqual({ ok: true });
    // A handler never receives a body, so passing one through has to bypass handlers entirely.
    expect(seen).toEqual([
      { url: "https://allowed.test/v1/chat", method: "POST", body: '{"prompt":"hello"}' },
    ]);

    await expect(fetch("https://denied.test/probe")).rejects.toThrow(/Unmocked outbound request/);
  } finally {
    interceptor.uninstall();
    globalThis.fetch = captured;
  }
});
