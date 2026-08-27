// Unit tests for NetworkInterceptor. They run in Node and never start workerd. The fetch-probe case
// in observer-reverification.test.ts proves that Worker subrequests reach this interceptor.
//
// These cases stay serial because they replace globalThis.fetch inside one file process. Vitest's
// default fork pool gives each parallel test file its own process and global state.

import { afterEach, beforeEach, expect, it } from "vitest";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";

const realFetch = globalThis.fetch;
let fetchedByReal: string[];

beforeEach(() => {
  fetchedByReal = [];
  globalThis.fetch = async (input: Parameters<typeof fetch>[0]) => {
    fetchedByReal.push(input instanceof Request ? input.url : String(input));
    return new Response("from the real fetch");
  };
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
  new NetworkInterceptor({ handlers: [declines, answers, neverAsked] }).install();

  const res = await fetch("https://vendor.test/api");
  expect(await res.text()).toBe("two");
  expect(asked).toEqual(["declines vendor.test", "answers vendor.test"]);
  expect(fetchedByReal).toEqual([]);
});

it("passes an explicitly allowed external request to the real fetch", async () => {
  const interceptor = new NetworkInterceptor({ handlers: [], allow: url => url.hostname === "model.test" });
  interceptor.install();

  const response = await fetch("https://model.test/chat");
  expect(await response.text()).toBe("from the real fetch");
  expect(fetchedByReal).toEqual(["https://model.test/chat"]);
  expect(interceptor.getUnmockedCalls()).toEqual([]);
});

it("supports a handler that parks until the test provides an answer", async () => {
  // Load-bearing for the CF Access transfer mock: the Worker starts polling before the test knows
  // what to serve, so a handler must be able to wait (see the Handler type's doc comment).
  let serve!: (body: string) => void;
  const parked = new Promise<string>(resolve => { serve = resolve; });
  new NetworkInterceptor({ handlers: [async () => new Response(await parked)] }).install();

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
  new NetworkInterceptor({ handlers: [record] }).install();

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
  const interceptor = new NetworkInterceptor({ handlers: [() => null] });
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
