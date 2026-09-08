import { describe, expect, it, vi } from "vitest";
import { ZendeskApi, buildAuthorizeUrl, exchangeAuthCode, normalizeSubdomain, ticketUrl } from "../src/zendesk-api";
import { codingTools, zendeskActionResultToToolResult } from "../src/coding-session";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject<Env = unknown> {
    ctx: unknown;
    env: Env;
    constructor(ctx: unknown, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  RpcStub: class RpcStub<T> { value?: T; constructor(value: T) { this.value = value; } },
  RpcTarget: class RpcTarget {},
  WorkerEntrypoint: class WorkerEntrypoint<Env = unknown> {
    ctx: unknown;
    env: Env;
    constructor(ctx: unknown, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("capnweb-validate", () => ({
  skipRpcValidation: () => <T>(value: T): T => value,
  validateRpc: () => <T>(value: T): T => value,
}));

function makeTestStorage() {
  const kv = new Map<string, unknown>();
  return {
    kv,
    storage: {
      kv: {
        get: <T>(key: string): T | undefined => kv.get(key) as T | undefined,
        put: <T>(key: string, value: T): void => { kv.set(key, value); },
        delete: (key: string): void => { kv.delete(key); },
      },
      setAlarm: vi.fn(),
      deleteAlarm: vi.fn(),
      deleteAll: vi.fn(),
    },
  };
}

describe("Zendesk URL normalization", () => {
  it("accepts only zendesk subdomains and strips host suffix", () => {
    expect(normalizeSubdomain("Acme.zendesk.com")).toBe("acme");
    expect(normalizeSubdomain("https://support-team.zendesk.com/")).toBe("support-team");
    expect(() => normalizeSubdomain("evil.com")).toThrow(/valid Zendesk subdomain/);
  });

  it("builds first-party agent ticket URLs", () => {
    expect(ticketUrl("acme", 123)).toBe("https://acme.zendesk.com/agent/tickets/123");
  });

  it("builds subdomain-scoped OAuth authorization URLs", () => {
    const url = new URL(buildAuthorizeUrl({ subdomain: "acme", clientId: "client", redirectUri: "https://odie.example/oauth", state: "state", scope: "read write" }));
    expect(url.origin).toBe("https://acme.zendesk.com");
    expect(url.pathname).toBe("/oauth/authorizations/new");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("read write");
  });

  it("exchanges authorization codes against the selected subdomain token endpoint", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 60, scope: "read write" });
    }) as typeof fetch;
    const grant = await exchangeAuthCode({ subdomain: "acme", code: "code", clientId: "client", clientSecret: "secret", redirectUri: "https://odie.example/oauth", scope: "read write" });
    expect(grant.accessToken).toBe("access");
    expect(calls[0].url).toBe("https://acme.zendesk.com/oauth/tokens");
    expect(JSON.parse(calls[0].body)).toMatchObject({ grant_type: "authorization_code", code: "code", client_id: "client" });
  });

  it("maps non-ok API responses to typed Zendesk errors", async () => {
    globalThis.fetch = (async () => Response.json({ error: "Forbidden" }, { status: 403 })) as typeof fetch;
    await expect(new ZendeskApi("acme", async () => "token").me()).rejects.toMatchObject({ status: 403, isAuthError: true });
  });

  it("rejects oversized JSON responses by encoded byte length", async () => {
    globalThis.fetch = (async () => new Response(`{"message":"${"😀".repeat(260_000)}"}`, { status: 200 })) as typeof fetch;
    await expect(new ZendeskApi("acme", async () => "token").me()).rejects.toThrow(/size limit/);
  });

  it("reports malformed JSON responses without leaking parser internals", async () => {
    globalThis.fetch = (async () => new Response("{", { status: 200 })) as typeof fetch;
    await expect(new ZendeskApi("acme", async () => "token").me()).rejects.toMatchObject({ message: "Zendesk returned malformed JSON." });
  });

  it("places safe update concurrency fields in the ticket update body", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return Response.json({ ticket: { id: 123, updated_at: "2026-09-04T00:00:01Z" } });
    }) as typeof fetch;
    await new ZendeskApi("acme", async () => "token").updateTicket("123", { status: "pending" }, { updateStamp: "2026-09-04T00:00:00Z" });
    expect(calls[0].url).toBe("https://acme.zendesk.com/api/v2/tickets/123.json");
    expect(JSON.parse(calls[0].body)).toEqual({ ticket: { status: "pending", safe_update: true, updated_stamp: "2026-09-04T00:00:00Z" } });
  });

  it("refuses attachment downloads outside the connected subdomain", async () => {
    await expect(new ZendeskApi("acme", async () => "token").downloadAttachment("https://other.zendesk.com/attachments/1")).rejects.toThrow(/outside the connected/);
  });
});

describe("Zendesk coding-session MCP compatibility", () => {
  it("publishes Workshop-compatible tool descriptors", () => {
    expect(codingTools()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "zendesk_search_tickets", mode: "read", classifiedBy: "server-annotation" }),
      expect.objectContaining({ name: "zendesk_add_comment", mode: "action", classifiedBy: "default" }),
    ]));
  });

  it("returns numeric pending action IDs for Workshop polling", () => {
    expect(zendeskActionResultToToolResult({ status: "pending" }, 42)).toEqual({
      status: "pending",
      actionId: 42,
      message: "Zendesk action is still pending.",
    });
  });

  it("normalizes completed native action results to MCP call results", () => {
    const result = zendeskActionResultToToolResult({ status: "ready", result: { id: "123" } }, 42);
    expect(result).toMatchObject({
      status: "ok",
      content: [{ type: "text", text: expect.stringContaining('"id": "123"') }],
      structuredContent: { id: "123" },
    });
  });

  it("rejects applyAction on provider failure while retaining a failed polling result", async () => {
    const { ZendeskGatekeeper } = await import("../src/zendesk");
    const kv = new Map<string, unknown>();
    const storage = {
      kv: {
        get: <T>(key: string): T | undefined => kv.get(key) as T | undefined,
        put: <T>(key: string, value: T): void => { kv.set(key, value); },
        delete: (key: string): void => { kv.delete(key); },
        list: <T>({ prefix }: { prefix: string }): Array<[string, T]> =>
          [...kv.entries()].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>,
      },
      setAlarm: vi.fn(),
    };
    const ctx = {
      props: { accountId: "account-1", subdomain: "acme" },
      storage,
      exports: {
        ZendeskAccount: {
          idFromString: (id: string) => id,
          get: () => ({ getAccessToken: async () => "token" }),
        },
      },
    };
    kv.set("action:7", {
      id: 7,
      kind: "fields",
      ticketId: "123",
      fields: { status: "open" },
      updateStamp: "2026-09-04T00:00:00Z",
      status: "pending",
    });
    globalThis.fetch = (async () =>
      Response.json({ error: "provider unavailable" }, { status: 503 })) as typeof fetch;

    const gatekeeper = new ZendeskGatekeeper(ctx as never, {} as never);
    await expect(gatekeeper.applyAction(7)).rejects.toThrow(/provider unavailable|Zendesk request failed/);

    const session = await gatekeeper.startSession({
      dup() { return this; },
      [Symbol.dispose]() {},
    } as never) as { getCodingSessionActionResult(actionId: number): Promise<unknown> };
    await expect(session.getCodingSessionActionResult(7)).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("provider unavailable"),
    });
    expect(kv.get("action:7")).toBeUndefined();
  });
});

describe("Zendesk native OAuth return URLs", () => {
  const env = {
    BASE_URL: "https://workshop.example/gatekeeper/zendesk",
    PUBLIC_BASE_URL: "https://workshop.example",
    CLIENT_ID: "client",
    CLIENT_SECRET: "secret",
  };
  const validReturnUrl = `https://workshop.example/native/oauth-return/${"a".repeat(32)}`;

  it("stores a validated native return URL for new connections", async () => {
    const { GatekeeperVendor } = await import("../src/zendesk");
    const accountId = "1".repeat(64);
    const account = { setCallback: vi.fn() };
    const vendor = new GatekeeperVendor({
      exports: {
        ZendeskAccount: {
          newUniqueId: () => accountId,
          get: () => account,
        },
      },
    } as never, env as never);

    const result = await vendor.connectAccount({} as never, { returnUrl: validReturnUrl });

    expect(result.url).toMatch(new RegExp(`^${env.BASE_URL}/connect/${accountId}/[0-9a-f]{64}$`));
    expect(account.setCallback).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^[0-9a-f]{64}$/), validReturnUrl);
  });

  it("threads reconnect native return URL into nonce state", async () => {
    const { ZendeskUserImpl } = await import("../src/zendesk");
    const account = { prepareReconnect: vi.fn() };
    const user = new ZendeskUserImpl({
      props: { accountId: "2".repeat(64), subdomain: "acme" },
      exports: {
        ZendeskAccount: {
          idFromString: (id: string) => id,
          get: () => account,
        },
      },
    } as never, env as never);

    const result = await user.reconnect({ returnUrl: validReturnUrl });

    expect(result.url).toMatch(new RegExp(`^${env.BASE_URL}/connect/${"2".repeat(64)}/[0-9a-f]{64}$`));
    expect(account.prepareReconnect).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/), validReturnUrl);
  });

  it("renders validated native completion URL and consumes the OAuth nonce once", async () => {
    const zendesk = await import("../src/zendesk");
    const { kv, storage: accountStorage } = makeTestStorage();
    const accountId = "3".repeat(64);
    const callback = { complete: vi.fn(), credentialsRestored: vi.fn(), credentialsExpired: vi.fn() };
    const account = new zendesk.ZendeskAccount({
      id: { toString: () => accountId },
      storage: accountStorage,
      exports: {
        ZendeskUserImpl: vi.fn((props: unknown) => ({ props })),
      },
    } as never, env as never);
    await account.setCallback(callback as never, "4".repeat(64), validReturnUrl);
    const begun = await account.beginOAuth("4".repeat(64), "acme");
    expect(begun).not.toBeNull();
    let tokenRequests = 0;
    globalThis.fetch = (async () => {
      tokenRequests += 1;
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 60, scope: "read write" });
    }) as typeof fetch;
    const ctx = {
      exports: {
        ZendeskAccount: {
          idFromString: (id: string) => id,
          get: () => account,
        },
      },
    };

    const response = await zendesk.default.fetch(
      new Request(`${env.BASE_URL}/oauth?state=${accountId}:${begun!.oauthNonce}&code=code`),
      env,
      ctx as never,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    expect(body).toContain(validReturnUrl);
    expect(body).toContain("location.replace");
    expect(callback.complete).toHaveBeenCalledOnce();
    expect(kv.get("nonce")).toBeUndefined();
    await expect(account.acceptAuthCode("code", begun!.oauthNonce)).resolves.toBeNull();
    expect(tokenRequests).toBe(1);
  });

  it("rejects malicious native return URLs before storing or starting OAuth", async () => {
    const zendesk = await import("../src/zendesk");
    const { GatekeeperVendor, ZendeskUserImpl } = zendesk;
    const account = { setCallback: vi.fn(), prepareReconnect: vi.fn(), beginOAuth: vi.fn() };
    const exports = {
      ZendeskAccount: {
        newUniqueId: () => "5".repeat(64),
        idFromString: (id: string) => id,
        get: () => account,
      },
    };
    const vendor = new GatekeeperVendor({ exports } as never, env as never);
    await expect(vendor.connectAccount({} as never, { returnUrl: "https://evil.example/native/oauth-return/" + "a".repeat(32) })).rejects.toThrow(/Invalid native/);
    expect(account.setCallback).not.toHaveBeenCalled();

    const user = new ZendeskUserImpl({ props: { accountId: "5".repeat(64), subdomain: "acme" }, exports } as never, env as never);
    await expect(user.reconnect({ returnUrl: `${validReturnUrl}?next=https://evil.example` })).rejects.toThrow(/Invalid native/);
    expect(account.prepareReconnect).not.toHaveBeenCalled();

    const response = await zendesk.default.fetch(
      new Request(`${env.BASE_URL}/connect/${"5".repeat(64)}/${"6".repeat(64)}?returnUrl=${encodeURIComponent("https://evil.example/native/oauth-return/" + "a".repeat(32))}`, {
        method: "POST",
        body: new URLSearchParams({ subdomain: "acme" }),
      }),
      env,
      { exports } as never,
    );
    expect(response.status).toBe(400);
    expect(account.beginOAuth).not.toHaveBeenCalled();
  });

  it("renders a connect form with a v-flag-compatible subdomain pattern and restricted form target", async () => {
    const zendesk = await import("../src/zendesk");
    const account = { beginOAuth: vi.fn() };
    const connectUrl = `${env.BASE_URL}/connect/${"7".repeat(64)}/${"8".repeat(64)}?returnUrl=${encodeURIComponent(validReturnUrl)}`;

    const response = await zendesk.default.fetch(new Request(connectUrl), env, {
      exports: { ZendeskAccount: { idFromString: (id: string) => id, get: () => account } },
    } as never);
    const body = await response.text();
    const pattern = body.match(/\bpattern="([^"]+)"/)?.[1];

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
    expect(body).toContain("<form method=\"post\">");
    expect(body).not.toContain("action=\"");
    expect(pattern).toBeDefined();
    const subdomainPattern = new RegExp(`^(?:${pattern})$`, "v");
    expect(subdomainPattern.test("acme")).toBe(true);
    expect(subdomainPattern.test("support-team.zendesk.com")).toBe(true);
    expect(subdomainPattern.test("evil.com")).toBe(false);
    expect(subdomainPattern.test("-bad.zendesk.com")).toBe(false);
    expect(subdomainPattern.test("bad-.zendesk.com")).toBe(false);
  });

  it("returns a clean 400 when a connect account id passes hex shape but fails Durable Object parsing", async () => {
    const zendesk = await import("../src/zendesk");
    const get = vi.fn();

    const response = await zendesk.default.fetch(new Request(`${env.BASE_URL}/connect/${"7".repeat(64)}/${"8".repeat(64)}`), env, {
      exports: { ZendeskAccount: { idFromString: vi.fn(() => { throw new Error("invalid id"); }), get } },
    } as never);

    await expect(response.text()).resolves.toBe("Invalid Zendesk connection link.");
    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it("returns a clean 400 when an OAuth state account id fails Durable Object parsing", async () => {
    const zendesk = await import("../src/zendesk");
    const get = vi.fn();

    const response = await zendesk.default.fetch(
      new Request(`${env.BASE_URL}/oauth?state=${"7".repeat(64)}:${"8".repeat(64)}&code=code`),
      env,
      { exports: { ZendeskAccount: { idFromString: vi.fn(() => { throw new Error("invalid id"); }), get } } } as never,
    );

    await expect(response.text()).resolves.toBe("Invalid OAuth state.");
    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it("renders a same-origin POST continuation page for the original initiation nonce", async () => {
    const zendesk = await import("../src/zendesk");
    const { kv, storage: accountStorage } = makeTestStorage();
    const accountId = "7".repeat(64);
    const nonce = "8".repeat(64);
    const account = new zendesk.ZendeskAccount({ storage: accountStorage } as never, env as never);
    await account.setCallback({ complete: vi.fn() } as never, nonce, validReturnUrl);
    const ctx = {
      exports: {
        ZendeskAccount: {
          idFromString: (id: string) => id,
          get: () => account,
        },
      },
    };

    const connectUrl = `${env.BASE_URL}/connect/${accountId}/${nonce}?returnUrl=${encodeURIComponent(validReturnUrl)}`;
    const response = await zendesk.default.fetch(
      new Request(connectUrl),
      env,
      ctx as never,
    );

    expect(response.status).toBe(200);
    expect(kv.get("nonce")).toMatchObject({ value: nonce });

    const post = await zendesk.default.fetch(
      new Request(connectUrl, {
        method: "POST",
        body: new URLSearchParams({ subdomain: "acme" }),
        redirect: "manual",
      }),
      env,
      ctx as never,
    );
    expect(post.status).toBe(200);
    expect(post.headers.get("location")).toBeNull();
    expect(post.headers.get("Cache-Control")).toBe("no-store");
    expect(post.headers.get("Content-Security-Policy")).toBe("default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    expect(post.headers.get("Referrer-Policy")).toBe("no-referrer");
    const postBody = await post.text();
    expect(postBody).toContain("Continuing to Zendesk...");
    expect(postBody).toContain("location.replace");
    expect(postBody).toContain("https://acme.zendesk.com/oauth/authorizations/new");
    const redirect = new URL(postBody.match(/location\.replace\("([^"]+)"\)/)![1]);
    expect(redirect.origin).toBe("https://acme.zendesk.com");
    expect(redirect.pathname).toBe("/oauth/authorizations/new");
    expect(redirect.searchParams.get("state")).toMatch(new RegExp(`^${accountId}:[0-9a-f]{64}$`));
    expect(kv.get("nonce")).toMatchObject({ value: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

});
