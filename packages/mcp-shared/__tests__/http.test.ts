import { describe, expect, it } from "vitest";

import { handleMcpHttpRequest } from "../src/http.js";

const DO_ID = "a".repeat(64);
const NONCE = "b".repeat(64);
const APP_TOKEN = "d".repeat(64);
const UNKNOWN_ID = "e".repeat(64);
const HANDOFF = { targetOrigin: "https://workshop.example", ticket: "c".repeat(64) };
const log = { warn() {} } as never;

/** The resolver both link routes go through: one known account, everything else unknown. */
function knownAccount(id: string) {
  if (id !== DO_ID) throw new Error("invalid id");
  return { acceptAuthCode: async () => HANDOFF };
}

function request(path: string, method = "GET") {
  return new Request(`https://workshop.example/gatekeeper/mcp${path}`, { method });
}

describe("handleMcpHttpRequest", () => {
  it.each([
    ["/elsewhere", 404],
    [`/gatekeeper/mcp/${DO_ID}/short`, 404],
    [`/gatekeeper/mcp/${"x".repeat(64)}/${NONCE}`, 400],
  ])("returns the expected status for %s", async (path, status) => {
    const response = await handleMcpHttpRequest(
      new Request(`https://workshop.example${path}`),
      {
        baseUrl: "https://workshop.example/gatekeeper/mcp",
        accountForId(id) {
          if (id !== DO_ID) throw new Error("invalid id");
          return { acceptAuthCode: async () => HANDOFF };
        },
        log,
        connect: async () => new Response("connected"),
      },
    );

    expect(response.status).toBe(status);
  });

  it("delegates a valid connect link without imposing connector method policy", async () => {
    const response = await handleMcpHttpRequest(request(`/${DO_ID}/${NONCE}`, "POST"), {
      baseUrl: "https://workshop.example/gatekeeper/mcp",
      accountForId: () => ({ acceptAuthCode: async () => HANDOFF }),
      log,
      connect: async (req, _account, nonce, path) =>
        Response.json({ method: req.method, nonce, path }),
    });

    expect(await response.json()).toEqual({
      method: "POST",
      nonce: NONCE,
      path: `/gatekeeper/mcp/${DO_ID}/${NONCE}`,
    });
  });

  it("dispatches the OAuth callback through the same account resolver", async () => {
    const response = await handleMcpHttpRequest(
      request(`/oauth?code=code&state=${DO_ID}:${NONCE}`),
      {
        baseUrl: "https://workshop.example/gatekeeper/mcp",
        accountForId: () => ({ acceptAuthCode: async () => HANDOFF }),
        log,
        connect: async () => new Response("unexpected"),
      },
    );

    expect(response.status).toBe(200);
    // The page carries the ticket, so it must never be cached or framed.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    // The page sends the popup, ticket in the fragment, to the Workshop's own handoff page, and
    // nowhere else.
    const html = await response.text();
    expect(html).toContain(HANDOFF.ticket);
    expect(html).toContain(`window.location.replace(target + "/connect/handoff#"`);
    expect(html).toContain(`"https://workshop.example"`);
  });

  it("treats a rejected OAuth callback as an expired link", async () => {
    const response = await handleMcpHttpRequest(
      request(`/oauth?code=code&state=${DO_ID}:${NONCE}`),
      {
        baseUrl: "https://workshop.example/gatekeeper/mcp",
        accountForId: () => ({ acceptAuthCode: async () => null }),
        log,
        connect: async () => new Response("unexpected"),
      },
    );

    expect(response.status).toBe(400);
  });

  it.each([
    [`/app/${DO_ID}/${APP_TOKEN}`, "page"],
    [`/app/${DO_ID}/${APP_TOKEN}/rpc`, "rpc"],
  ])("routes %s to the connector's app %s handler", async (path, route) => {
    const response = await handleMcpHttpRequest(request(path, "POST"), {
      baseUrl: "https://workshop.example/gatekeeper/mcp",
      accountForId: knownAccount,
      log,
      connect: async () => new Response("unexpected"),
      app: {
        page: async (req, _account, token) =>
          Response.json({ route: "page", method: req.method, token }),
        rpc: async (req, _account, token) =>
          Response.json({ route: "rpc", method: req.method, token }),
      },
    });

    expect(await response.json()).toEqual({ route, method: "POST", token: APP_TOKEN });
  });

  it("treats an app link to an unknown account as the connect route does", async () => {
    const appResponse = await handleMcpHttpRequest(request(`/app/${UNKNOWN_ID}/${APP_TOKEN}`), {
      baseUrl: "https://workshop.example/gatekeeper/mcp",
      accountForId: knownAccount,
      log,
      connect: async () => new Response("unexpected"),
      app: {
        page: async () => new Response("unexpected"),
        rpc: async () => new Response("unexpected"),
      },
    });
    const connectResponse = await handleMcpHttpRequest(request(`/${UNKNOWN_ID}/${NONCE}`), {
      baseUrl: "https://workshop.example/gatekeeper/mcp",
      accountForId: knownAccount,
      log,
      connect: async () => new Response("unexpected"),
    });

    expect(appResponse.status).toBe(400);
    expect(await appResponse.text()).toBe(await connectResponse.text());
  });

  it.each([
    [`/app/${DO_ID}/${APP_TOKEN}`, 404],
    [`/app/${DO_ID}/${APP_TOKEN}/rpc`, 404],
  ])("leaves %s to connectors that serve no apps", async (path, status) => {
    // `app` is optional, so a connector that predates it still answers these paths as unrouteable.
    const response = await handleMcpHttpRequest(request(path), {
      baseUrl: "https://workshop.example/gatekeeper/mcp",
      accountForId: knownAccount,
      log,
      connect: async () => new Response("unexpected"),
    });

    expect(response.status).toBe(status);
  });

  it.each([
    [`/app/${DO_ID}/short`, 404],
    [`/app/${DO_ID.slice(0, 63)}/${APP_TOKEN}`, 404],
    [`/app/${DO_ID}/${APP_TOKEN}/other`, 404],
    [`/app/${DO_ID}/${APP_TOKEN}/rpc/extra`, 404],
  ])("does not route the malformed app path %s", async (path, status) => {
    const response = await handleMcpHttpRequest(request(path), {
      baseUrl: "https://workshop.example/gatekeeper/mcp",
      accountForId: knownAccount,
      log,
      connect: async () => new Response("unexpected"),
      app: {
        page: async () => new Response("unexpected"),
        rpc: async () => new Response("unexpected"),
      },
    });

    expect(response.status).toBe(status);
  });
});
