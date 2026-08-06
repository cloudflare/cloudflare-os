import { describe, expect, it } from "vite-plus/test";

import { handleMcpHttpRequest } from "../src/http.js";

const DO_ID = "a".repeat(64);
const NONCE = "b".repeat(64);
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
          return { acceptAuthCode: async () => true };
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
      accountForId: () => ({ acceptAuthCode: async () => true }),
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
        accountForId: () => ({ acceptAuthCode: async () => true }),
        log,
        connect: async () => new Response("unexpected"),
      },
    );

    expect(response.status).toBe(200);
  });
});
