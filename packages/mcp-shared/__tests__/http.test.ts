import { describe, expect, it } from "vitest";

import { handleMcpHttpRequest } from "../src/http.js";

const DO_ID = "a".repeat(64);
const NONCE = "b".repeat(64);
const HANDOFF = { targetOrigin: "https://workshop.example", ticket: "c".repeat(64) };
const log = { warn() {} } as never;

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
});
