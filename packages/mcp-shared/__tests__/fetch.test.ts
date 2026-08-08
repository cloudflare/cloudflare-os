import { afterEach, describe, expect, it, vi } from "vitest";

import { guardedFetch, isAllowedUrl, sdkFetch } from "../src/fetch.js";

type Hop = {
  url: string;
  authorization: string | null;
  sessionId: string | null;
  method: string;
  body: unknown;
};

// Serves a redirect chain from `chain`, then a 200. Records every hop and what it carried.
function stubChain(chain: Record<string, string>, status = 307): Hop[] {
  const hops: Hop[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    hops.push({
      url: String(input),
      authorization: new Headers(init.headers).get("Authorization"),
      sessionId: new Headers(init.headers).get("Mcp-Session-Id"),
      method: init.method ?? "GET",
      body: init.body,
    });
    const target = chain[String(input)];
    if (target) return new Response("", { status, headers: { Location: target } });
    return new Response("ok", { status: 200 });
  });
  return hops;
}

afterEach(() => vi.unstubAllGlobals());

describe("guardedFetch", () => {
  it("refuses a blocked host outright", async () => {
    stubChain({});
    await expect(guardedFetch("http://169.254.169.254/", {})).rejects.toThrow(/Refusing to contact/);
  });

  it("does not follow a redirect into a blocked host", async () => {
    // The hole this exists to close: the endpoint passed validation, and then chose where the next
    // request went. Following it would reach a host the front-door check exists to refuse.
    const hops = stubChain({ "https://mcp.example.com/mcp": "http://169.254.169.254/latest/" });
    const response = await guardedFetch("https://mcp.example.com/mcp", { method: "POST" });
    expect(hops.map(hop => hop.url)).toEqual(["https://mcp.example.com/mcp"]);
    // Handed back as the 3xx it is, which every caller already treats as a failure.
    expect(response.status).toBe(307);
  });

  it("follows an allowed redirect and keeps credentials within the origin", async () => {
    const hops = stubChain({ "https://mcp.example.com/mcp": "https://mcp.example.com/v2/mcp" });
    const response = await guardedFetch("https://mcp.example.com/mcp", {
      headers: { Authorization: "Bearer secret", "Mcp-Session-Id": "same-origin-session" },
    });
    expect(response.status).toBe(200);
    expect(hops.map(hop => hop.authorization)).toEqual(["Bearer secret", "Bearer secret"]);
    expect(hops.map(hop => hop.sessionId)).toEqual(["same-origin-session", "same-origin-session"]);
  });

  it("drops credentials and transport session when a redirect leaves the origin", async () => {
    // Otherwise a server we authenticate to can harvest either capability by bouncing us elsewhere.
    const hops = stubChain({ "https://mcp.example.com/mcp": "https://evil.example.net/collect" });
    await guardedFetch("https://mcp.example.com/mcp", {
      headers: {
        Authorization: "Bearer secret",
        "Mcp-Session-Id": "origin-session-secret",
      },
    });
    expect(hops.map(hop => hop.authorization)).toEqual(["Bearer secret", null]);
    expect(hops.map(hop => hop.sessionId)).toEqual(["origin-session-secret", null]);
  });

  it("does not replay the body across a 303", async () => {
    // 303 means "fetch the result of this with GET". Replaying would resend the token endpoint's
    // form -- authorization code, PKCE verifier, client secret -- to a host that only redirected us.
    const hops = stubChain(
      { "https://auth.example.com/token": "https://auth.example.com/done" }, 303);
    await guardedFetch("https://auth.example.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=secret",
    });
    expect(hops.map(hop => hop.method)).toEqual(["POST", "GET"]);
    expect(hops[1].body).toBeUndefined();
  });

  it("preserves the body across a same-origin 307, which promises the method is unchanged", async () => {
    const hops = stubChain({ "https://mcp.example.com/mcp": "https://mcp.example.com/v2" });
    await guardedFetch("https://mcp.example.com/mcp", { method: "POST", body: "{}" });
    expect(hops.map(hop => hop.method)).toEqual(["POST", "POST"]);
    expect(hops[1].body).toBe("{}");
  });

  for (const status of [307, 308]) {
    it(`does not send a POST body across origins after a ${status}`, async () => {
      // Removing Authorization is insufficient for OAuth: the code, PKCE verifier, refresh token,
      // and public client id are in this body. A 307/308 explicitly asks us to replay all of it.
      const hops = stubChain(
        { "https://auth.example.com/token": "https://evil.example.net/collect" }, status);
      const response = await guardedFetch("https://auth.example.com/token", {
        method: "POST",
        headers: {
          Authorization: "Basic secret",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=authorization_code&code=secret&code_verifier=also-secret",
      });

      expect(response.status).toBe(status);
      expect(hops.map(hop => hop.url)).toEqual(["https://auth.example.com/token"]);
    });
  }

  it("may follow a cross-origin 302 after discarding the POST body", async () => {
    // Unlike 307/308, browser-compatible 301/302 handling changes POST to GET, so neither source of
    // credentials survives the cross-origin hop.
    const hops = stubChain(
      { "https://auth.example.com/token": "https://cdn.example.net/done" }, 302);
    await guardedFetch("https://auth.example.com/token", {
      method: "POST",
      headers: {
        Authorization: "Basic secret",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "code=secret",
    });
    expect(hops.map(hop => ({ method: hop.method, body: hop.body, auth: hop.authorization })))
      .toEqual([
        { method: "POST", body: "code=secret", auth: "Basic secret" },
        { method: "GET", body: undefined, auth: null },
      ]);
  });

  it("stops following a loop", async () => {
    const hops = stubChain({
      "https://a.example.com/": "https://b.example.com/",
      "https://b.example.com/": "https://a.example.com/",
    });
    const response = await guardedFetch("https://a.example.com/", {});
    expect(response.status).toBe(307);
    expect(hops.length).toBeLessThanOrEqual(4);
  });
});

describe("isAllowedUrl", () => {
  it("requires https and a public host", () => {
    expect(isAllowedUrl("https://mcp.example.com/mcp")).toBe(true);
    expect(isAllowedUrl("http://mcp.example.com/mcp")).toBe(false);
    expect(isAllowedUrl("https://127.0.0.1/mcp")).toBe(false);
    expect(isAllowedUrl("not a url")).toBe(false);
  });

  it("relaxes both for local development", () => {
    expect(isAllowedUrl("http://localhost:8080/mcp", { allowInsecure: true })).toBe(true);
  });
});

describe("sdkFetch", () => {
  it("refuses an OAuth response larger than the shared response limit", async () => {
    vi.stubGlobal("fetch", async () => new Response("x".repeat(2 * 1024 * 1024)));
    await expect(sdkFetch()("https://auth.example.com/metadata"))
      .rejects.toThrow(/response exceeded/i);
  });

  it("preserves response metadata after bounding the body", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"issuer":"https://auth.example.com"}', {
      status: 201,
      statusText: "Created",
      headers: { "Content-Type": "application/json", "X-Test": "kept" },
    }));
    const response = await sdkFetch()("https://auth.example.com/metadata");
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("X-Test")).toBe("kept");
    expect(await response.json()).toEqual({ issuer: "https://auth.example.com" });
  });
});
