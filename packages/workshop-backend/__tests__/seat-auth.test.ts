import { describe, it, expect, vi } from "vitest";
import { startSeatAuth, completeSeatAuth, revokeSeat } from "../src/seat-auth.js";

function envWith(url?: string) {
  return { SEAT_PROXY_URL: url } as any;
}

function fetchReturning(status: number, body: unknown, capture?: any) {
  return vi.fn(async (input: any, init: any) => {
    if (capture) { capture.url = String(input); capture.init = init; }
    // Null-body statuses (e.g. 204 from DELETE) cannot carry a body -- workerd enforces this
    // strictly at construction time, unlike some other runtimes.
    const hasBody = ![101, 204, 205, 304].includes(status);
    return new Response(hasBody ? JSON.stringify(body) : null, { status,
      headers: { "content-type": "application/json" } });
  });
}

describe("startSeatAuth", () => {
  it("lowercases the owner before sending it", async () => {
    const cap: any = {};
    const fetchImpl = fetchReturning(200,
      { enroll_id: "E", kind: "authorize_url", url: "https://x/y" }, cap);
    await startSeatAuth(envWith("http://p"), "Alice", "anthropic", fetchImpl);
    expect(cap.init.headers["X-Seat-Owner"]).toBe("alice");
  });

  it("maps an authorize_url response", async () => {
    const fetchImpl = fetchReturning(200,
      { enroll_id: "E", kind: "authorize_url", url: "https://x/y" });
    const out = await startSeatAuth(envWith("http://p"), "alice", "anthropic", fetchImpl);
    expect(out).toEqual({ enrollId: "E", kind: "authorize_url", url: "https://x/y" });
  });

  it("maps a device_code response", async () => {
    const fetchImpl = fetchReturning(200, { enroll_id: "E", kind: "device_code",
      user_code: "ABCD", verification_uri: "https://x", interval: 5 });
    const out = await startSeatAuth(envWith("http://p"), "alice", "openai", fetchImpl);
    expect(out).toEqual({ enrollId: "E", kind: "device_code", userCode: "ABCD",
      verificationUri: "https://x", interval: 5 });
  });

  it("throws a clean error when the proxy is not configured", async () => {
    await expect(startSeatAuth(envWith(undefined), "alice", "anthropic",
      fetchReturning(200, {}))).rejects.toThrow(/not configured/i);
  });

  it("throws without leaking the proxy response body", async () => {
    const fetchImpl = fetchReturning(500, { secret: "TOKEN-LEAK" });
    let message = "";
    try {
      await startSeatAuth(envWith("http://p"), "alice", "anthropic", fetchImpl);
    } catch (e: any) {
      message = String(e?.message ?? e);
    }
    expect(message).toMatch(/failed \(500\)/);
    expect(message).not.toContain("TOKEN-LEAK");
  });
});

describe("completeSeatAuth", () => {
  it("returns pending unchanged", async () => {
    const fetchImpl = fetchReturning(200, { status: "pending" });
    const out = await completeSeatAuth(envWith("http://p"), "alice", "openai", "E",
      undefined, fetchImpl);
    expect(out).toEqual({ status: "pending" });
  });

  it("returns the handle and the per-provider apiUrl", async () => {
    const fetchImpl = fetchReturning(200,
      { status: "complete", handle: "H", models: ["m1"] });
    const out = await completeSeatAuth(envWith("http://p"), "alice", "anthropic", "E",
      "CODE", fetchImpl);
    expect(out).toEqual({ status: "complete", handle: "H", models: ["m1"],
      apiUrl: "http://p/anthropic" });
  });

  it("sends the code and lowercased owner", async () => {
    const cap: any = {};
    const fetchImpl = fetchReturning(200,
      { status: "complete", handle: "H", models: [] }, cap);
    await completeSeatAuth(envWith("http://p"), "Alice", "anthropic", "E", "CODE",
      fetchImpl);
    expect(JSON.parse(cap.init.body)).toEqual({ enroll_id: "E", code: "CODE" });
    expect(cap.init.headers["X-Seat-Owner"]).toBe("alice");
  });
});

describe("revokeSeat", () => {
  it("deletes the handle with the lowercased owner", async () => {
    const cap: any = {};
    const fetchImpl = fetchReturning(204, {}, cap);
    await revokeSeat(envWith("http://p"), "Alice", "H", fetchImpl);
    expect(cap.url).toBe("http://p/enroll/H");
    expect(cap.init.method).toBe("DELETE");
    expect(cap.init.headers["X-Seat-Owner"]).toBe("alice");
  });
});
