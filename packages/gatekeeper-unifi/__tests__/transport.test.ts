// The HTTP transport: where each kind of request goes in each connection mode, what it carries,
// and how every failure UniFi or the network can produce is classified -- without the key ever
// appearing in a message.

import { describe, expect, it, vi } from "vitest";
import { classifyHttpFailure, parseRetryAfterHeader, parseRetryAfterMessage } from "../src/errors";
import { requestUrl, sendUnifiRequest, type UnifiCredentials, type UnifiRequest } from "../src/transport";
import { FakeUnifi, HOME, homeConsole, SNAPSHOT_BYTES } from "./fake-unifi";

const CLOUD: UnifiCredentials = { mode: "cloud", apiKey: "cloud-key-0123456789abcdef" };
const DIRECT: UnifiCredentials = {
  mode: "direct", baseUrl: "https://unifi.home.example", apiKey: "local-key-0123456789abcdef",
};
const sites: UnifiRequest = { target: { kind: "app", app: "network", consoleId: HOME.hostId }, method: "GET", path: "/v1/sites" };

function fake() {
  const unifi = new FakeUnifi();
  const console = homeConsole();
  unifi.addCloudKey(CLOUD.apiKey, { email: "dan@example.com", fullName: "Dan", owned: [console] });
  unifi.addDirectConsole("https://unifi.home.example", console, DIRECT.apiKey);
  return { unifi, console };
}

describe("request URLs", () => {
  it("reaches Site Manager and the Cloud Connector from a cloud connection", () => {
    expect(requestUrl(CLOUD, { target: { kind: "siteManager" }, method: "GET", path: "/v1/hosts", query: { pageSize: "100" } }))
      .toBe("https://api.ui.com/v1/hosts?pageSize=100");
    expect(requestUrl(CLOUD, sites))
      .toBe(`https://api.ui.com/v1/connector/consoles/${HOME.hostId}/proxy/network/integration/v1/sites`);
  });

  it("reaches the console's own API from a direct connection, under any proxy prefix", () => {
    expect(requestUrl(DIRECT, sites)).toBe("https://unifi.home.example/proxy/network/integration/v1/sites");
    expect(requestUrl({ ...DIRECT, baseUrl: "https://proxy.example/unifi" }, { ...sites, target: { kind: "app", app: "protect", consoleId: "x" }, path: "/v1/cameras" }))
      .toBe("https://proxy.example/unifi/proxy/protect/integration/v1/cameras");
  });

  it("encodes filters as query parameters", () => {
    expect(requestUrl(DIRECT, { ...sites, path: "/v1/sites/abc/clients", query: { filter: "access.type.eq('GUEST')" } }))
      .toBe("https://unifi.home.example/proxy/network/integration/v1/sites/abc/clients?filter=access.type.eq%28%27GUEST%27%29");
  });

  it("refuses paths and console IDs that could escape their place", () => {
    expect(() => requestUrl(CLOUD, { ...sites, path: "/v1/sites/../../hosts" })).toThrow(/Not a UniFi API path/);
    expect(() => requestUrl(CLOUD, { ...sites, path: "/v2/sites" })).toThrow(/Not a UniFi API path/);
    expect(() => requestUrl(CLOUD, { ...sites, target: { kind: "app", app: "network", consoleId: "a/b" } })).toThrow(/console ID/);
    expect(() => requestUrl(DIRECT, { target: { kind: "siteManager" }, method: "GET", path: "/v1/hosts" })).toThrow(/cloud connection/);
  });
});

describe("sending", () => {
  it("authenticates with X-API-KEY and never follows redirects", async () => {
    const { unifi } = fake();
    const fetchSpy = vi.fn(unifi.fetch);
    const response = await sendUnifiRequest(CLOUD, sites, fetchSpy);
    expect(response).toMatchObject({ ok: true, status: 200 });
    const init = fetchSpy.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("X-API-KEY")).toBe(CLOUD.apiKey);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends JSON bodies and the Cloudflare Access service token", async () => {
    const { unifi } = fake();
    const credentials: UnifiCredentials = { ...DIRECT, access: { clientId: "id.access", clientSecret: "secret" } };
    unifi.direct.get("https://unifi.home.example")!.access = credentials.access;
    const response = await sendUnifiRequest(credentials, {
      target: { kind: "app", app: "network", consoleId: "x" }, method: "POST",
      path: `/v1/sites/${HOME.siteId}/devices/${HOME.apId}/actions`, body: { action: "RESTART" },
    }, unifi.fetch);
    expect(response.ok).toBe(true);
    const call = unifi.calls.at(-1)!;
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers["cf-access-client-id"]).toBe("id.access");
    expect(call.body).toEqual({ action: "RESTART" });
  });

  it("returns a snapshot's bytes", async () => {
    const { unifi } = fake();
    const response = await sendUnifiRequest(CLOUD, {
      target: { kind: "app", app: "protect", consoleId: HOME.hostId }, method: "GET",
      path: `/v1/cameras/${HOME.doorbellId}/snapshot`, accept: "jpeg",
    }, unifi.fetch);
    if (!response.ok || !("bytes" in response)) throw new Error("expected bytes");
    expect(new Uint8Array(response.bytes)).toEqual(SNAPSHOT_BYTES);
    expect(response.contentType).toBe("image/jpeg");
  });
});

describe("failures", () => {
  it("classifies a rejected key without quoting it", async () => {
    const { unifi } = fake();
    const response = await sendUnifiRequest({ mode: "cloud", apiKey: "wrong-key-0123456789" }, sites, unifi.fetch);
    expect(response).toEqual({ ok: false, failure: { kind: "auth", status: 401, message: "UniFi didn't accept the API key." } });
  });

  it("classifies an offline console reached through the connector", async () => {
    const { unifi, console } = fake();
    console.offline = true;
    const response = await sendUnifiRequest(CLOUD, sites, unifi.fetch);
    expect(response).toMatchObject({ ok: false, failure: { kind: "unreachable", status: 408 } });
  });

  it("classifies the connector's rate limit with its retry time", async () => {
    const { unifi } = fake();
    unifi.connectorLimit = 0;
    const response = await sendUnifiRequest(CLOUD, sites, unifi.fetch);
    expect(response).toMatchObject({ ok: false, failure: { kind: "rateLimited", status: 429, retryAfterMs: 5373 } });
    if (!response.ok) expect(response.failure.message).toMatch(/retry in 6 seconds/);
  });

  it("classifies a console the key's account doesn't own", async () => {
    const { unifi } = fake();
    const other = homeConsole();
    other.hostId = "AABBCCDDEEFF0000000000000000000000000000000000000000000000000000:1";
    unifi.cloud.get(CLOUD.apiKey)!.administered = [{ console: other, permissions: {} }];
    const response = await sendUnifiRequest(CLOUD, { ...sites, target: { kind: "app", app: "network", consoleId: other.hostId } }, unifi.fetch);
    expect(response).toMatchObject({ ok: false, failure: { kind: "forbidden", status: 403 } });
  });

  it("classifies an untrusted certificate and an unreachable console", async () => {
    const { unifi } = fake();
    unifi.direct.get("https://unifi.home.example")!.untrustedCertificate = true;
    expect(await sendUnifiRequest(DIRECT, sites, unifi.fetch)).toMatchObject({ ok: false, failure: { kind: "tls" } });
    expect(await sendUnifiRequest({ ...DIRECT, baseUrl: "https://elsewhere.example" }, sites, unifi.fetch))
      .toMatchObject({ ok: false, failure: { kind: "unreachable" } });
  });

  it("classifies a redirect, such as a Cloudflare Access login page, and doesn't follow it", async () => {
    const { unifi } = fake();
    unifi.direct.get("https://unifi.home.example")!.access = { clientId: "id", clientSecret: "secret" };
    const response = await sendUnifiRequest(DIRECT, sites, unifi.fetch);
    expect(response).toMatchObject({ ok: false, failure: { kind: "redirect", status: 302 } });
    if (!response.ok) expect(response.failure.message).toMatch(/Cloudflare Access/);
    expect(unifi.calls).toHaveLength(1);
  });

  it("classifies a timeout as possibly carried out", async () => {
    const timeout = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    const response = await sendUnifiRequest(DIRECT, sites, async () => { throw timeout; });
    expect(response).toMatchObject({ ok: false, failure: { kind: "timeout" } });
    if (!response.ok) expect(response.failure.message).toMatch(/may still have been carried out/);
  });

  it("classifies malformed JSON and oversized bodies as protocol errors", async () => {
    const malformed = await sendUnifiRequest(DIRECT, sites, async () => new Response("{not json", { status: 200 }));
    expect(malformed).toMatchObject({ ok: false, failure: { kind: "protocol" } });
    const huge = await sendUnifiRequest(DIRECT, sites, async () =>
      new Response("x", { status: 200, headers: { "Content-Length": String(11 * 1024 * 1024) } }));
    expect(huge).toMatchObject({ ok: false, failure: { kind: "protocol" } });
  });

  it("quotes the provider's message for a bad request, but not an HTML error page", () => {
    expect(classifyHttpFailure(400, "timeLimitMinutes must be at least 1", undefined))
      .toEqual({ kind: "badRequest", status: 400, message: "UniFi rejected the request: timeLimitMinutes must be at least 1" });
    expect(classifyHttpFailure(404, undefined, undefined)).toEqual({ kind: "notFound", status: 404, message: "Not found." });
    expect(classifyHttpFailure(500, undefined, undefined)).toMatchObject({ kind: "server" });
    expect(classifyHttpFailure(418, undefined, undefined)).toMatchObject({ kind: "badRequest" });
  });

  it("parses retry times from headers and Site Manager's message", () => {
    expect(parseRetryAfterHeader("7")).toBe(7000);
    expect(parseRetryAfterHeader("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
    expect(parseRetryAfterHeader(null)).toBeUndefined();
    expect(parseRetryAfterMessage("rate limit exceeded, retry after 0.25s")).toBe(250);
    expect(parseRetryAfterMessage("nope")).toBeUndefined();
  });
});
