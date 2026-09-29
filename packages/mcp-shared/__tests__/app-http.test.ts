import { describe, expect, it } from "vitest";

import { appHttp } from "../src/app-http.js";
import type { AppViewPage, AppViewRefusal } from "../src/apps.js";

const BASE_URL = "https://workshop.example/gatekeeper/mcp";
const ORIGIN = new URL(BASE_URL).origin;
const TOKEN = "a".repeat(64);
const PAGE_URL = `${BASE_URL}/app/${TOKEN}`;
const RPC_URL = `${PAGE_URL}/rpc`;
const REPLY = { body: '{"jsonrpc":"2.0","id":7,"result":{}}', status: 200 };
const log = { warn() {} } as never;

const VIEW: AppViewPage = {
  uri: "ui://slice-e/view",
  title: "Slice E",
  html: "<html><body>slice-e-view</body></html>",
  csp: "default-src 'none'; script-src 'self'",
};

/** A stand-in account that records what the routes asked of it. */
function fakeAccount(
  view: AppViewPage | AppViewRefusal,
  reply: { body: string; status: number } = REPLY,
) {
  const calls: { token: string; message: unknown }[] = [];
  return {
    calls,
    async openAppView() {
      return view;
    },
    async callApp(token: string, message: unknown) {
      calls.push({ token, message });
      return reply;
    },
  };
}

function rpcRequest(headers: Record<string, string>, body: string): Request {
  return new Request(RPC_URL, { method: "POST", headers, body });
}

const jsonHeaders = { origin: ORIGIN, "content-type": "application/json; charset=utf-8" };

describe("appHttp page route", () => {
  it("renders the sidecar page for a resolved link", async () => {
    const response = await appHttp({ baseUrl: BASE_URL, log })
      .page(new Request(PAGE_URL), fakeAccount(VIEW), TOKEN);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    // The token is in the URL, so the page carries the same hardening a connect link gets.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // The app's own document is what the page embeds; the page is the Host half around it.
    expect(await response.text()).toContain("slice-e-view");
  });

  it("shows the refusal instead of an app page", async () => {
    const response = await appHttp({ baseUrl: BASE_URL, log })
      .page(new Request(PAGE_URL), fakeAccount({ refusal: "That view is no longer served." }), TOKEN);

    const body = await response.text();
    expect(response.status).toBe(400);
    expect(body).toContain("That view is no longer served.");
    expect(body).not.toContain("slice-e-view");
  });
});

describe("appHttp rpc route", () => {
  it("hands the raw body and token to the account, and returns the reply verbatim", async () => {
    const account = fakeAccount(VIEW);
    // Not JSON, and deliberately so: parsing belongs to the account, which answers `-32700`.
    const message = '{"jsonrpc":"2.0","id":7,"method":';
    const response = await appHttp({ baseUrl: BASE_URL, log })
      .rpc(rpcRequest(jsonHeaders, message), account, TOKEN);

    expect(account.calls).toEqual([{ token: TOKEN, message }]);
    expect(response.status).toBe(REPLY.status);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.text()).toBe(REPLY.body);
  });

  it("refuses a cross-origin request before reading it", async () => {
    const account = fakeAccount(VIEW);
    const response = await appHttp({ baseUrl: BASE_URL, log }).rpc(
      rpcRequest({ origin: "https://evil.example", "content-type": "application/json" }, "{}"),
      account,
      TOKEN,
    );

    expect(response.status).toBe(403);
    expect(account.calls).toEqual([]);
    // The page relays this to the View, so a refusal has to be a JSON-RPC message.
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32600 } });
  });

  it("refuses a body that is not JSON", async () => {
    const account = fakeAccount(VIEW);
    const response = await appHttp({ baseUrl: BASE_URL, log }).rpc(
      rpcRequest({ origin: ORIGIN, "content-type": "text/plain" }, "{}"),
      account,
      TOKEN,
    );

    expect(response.status).toBe(415);
    expect(account.calls).toEqual([]);
  });

  it("refuses a body over the cap instead of buffering it", async () => {
    const account = fakeAccount(VIEW);
    const response = await appHttp({ baseUrl: BASE_URL, log }).rpc(
      rpcRequest(jsonHeaders, `"${"x".repeat(65 * 1024)}"`),
      account,
      TOKEN,
    );

    expect(response.status).toBe(413);
    expect(account.calls).toEqual([]);
  });
});
