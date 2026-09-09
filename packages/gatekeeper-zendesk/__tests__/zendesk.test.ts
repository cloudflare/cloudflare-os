import { afterEach, describe, expect, it, vi } from "vitest";
import { ZendeskApi, buildAuthorizeUrl, exchangeAuthCode, normalizeSubdomain, ticketUrl } from "../src/zendesk-api";
import { codingTools, zendeskActionResultToToolResult } from "../src/coding-session";
import type { ZendeskAccountSession, ZendeskTicketSession } from "../src/types";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
        list: <T>({ prefix }: { prefix: string }): Array<[string, T]> =>
          [...kv.entries()].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>,
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
    await expect(new ZendeskApi("acme", async () => "token").downloadAttachment("https://acme.zendesk.com:8443/attachments/1")).rejects.toThrow(/outside the connected/);
  });

  it("cancels an oversized streaming response before buffering the whole body", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(600_000)); }, cancel,
    }))));
    await expect(new ZendeskApi("acme", async () => "token").me()).rejects.toThrow("size limit");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

async function workflowGatekeeper(ticketId?: string, subdomain = "acme") {
  const { ZendeskGatekeeper } = await import("../src/zendesk");
  const { kv, storage } = makeTestStorage();
  const account = { getAccessToken: async () => "token" };
  const gatekeeper = new ZendeskGatekeeper({
    props: { accountId: "account", subdomain, ticketId }, storage,
    exports: { ZendeskAccount: { idFromString: (id: string) => id, get: () => account } },
  } as never, {} as never);
  const queue = { dup() { return this; }, [Symbol.dispose]: vi.fn(), authorizeObservation: vi.fn(), submitAction: vi.fn() };
  return { gatekeeper, kv, queue };
}

describe("Zendesk workflow regressions", () => {
  it("filters assignedToMe by live assignee ID on every coding search page", async () => {
    const { gatekeeper, queue } = await workflowGatekeeper();
    const fetcher = vi.fn(async (url: string) => url.includes("users/me.json")
      ? Response.json({ user: { id: 17, email: "agent@example.test" } })
      : Response.json({ results: [{ id: 123, assignee_id: 17, requester_id: 99 }], next_page: "next" }));
    vi.stubGlobal("fetch", fetcher);
    const session = await gatekeeper.startSession(queue as never) as ZendeskAccountSession;
    expect((await session.listTools()).find(tool => tool.name === "zendesk_search_tickets")?.inputSchema).toMatchObject({ properties: { assignedToMe: { type: "boolean" } } });
    for (const cursor of [undefined, "2"]) {
      await session.callTool("zendesk_search_tickets", { query: "status:open", assignedToMe: true, limit: 25, cursor });
    }
    const urls = fetcher.mock.calls.map(([url]) => new URL(url));
    expect(urls.map(url => url.pathname)).toEqual(["/api/v2/users/me.json", "/api/v2/search.json", "/api/v2/users/me.json", "/api/v2/search.json"]);
    expect(urls[1].searchParams.get("query")).toBe("type:ticket assignee:17 status:open");
    expect(urls[3].searchParams.get("query")).toBe("type:ticket assignee:17 status:open");
    expect(urls[3].searchParams.get("page")).toBe("2");
    expect(urls[3].searchParams.get("per_page")).toBe("25");
    expect(queue.authorizeObservation).toHaveBeenCalledTimes(2);
    expect(queue.authorizeObservation).toHaveBeenLastCalledWith(expect.objectContaining({ prohibitAllSharing: true }));
    await gatekeeper.searchTickets({ source: "zendesk", assignedToMe: true, cursors: { zendesk: "3" } });
    expect(new URL(fetcher.mock.calls.at(-1)![0]).searchParams.get("query")).toBe("type:ticket assignee:17");
  });

  it("does not resolve identity for unfiltered search and rejects conflicting assignee terms", async () => {
    const { gatekeeper, queue } = await workflowGatekeeper();
    const fetcher = vi.fn(async () => Response.json({ results: [], next_page: null }));
    vi.stubGlobal("fetch", fetcher);
    const session = await gatekeeper.startSession(queue as never) as ZendeskAccountSession;
    await session.callTool("zendesk_search_tickets", { assignedToMe: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    await expect(session.callTool("zendesk_search_tickets", { assignedToMe: true, query: "assignee:99" })).rejects.toThrow("without an assignee term");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([200, 401, 503])("fails assignedToMe explicitly when identity is unavailable (%s), without unfiltered fallback", async status => {
    const { gatekeeper, queue } = await workflowGatekeeper();
    const fetcher = vi.fn(async () => Response.json(status === 200 ? { user: { id: null } } : { error: "Identity unavailable" }, { status }));
    vi.stubGlobal("fetch", fetcher);
    const session = await gatekeeper.startSession(queue as never) as ZendeskAccountSession;
    await expect(session.callTool("zendesk_search_tickets", { assignedToMe: true })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("https://acme.zendesk.com/api/v2/users/me.json", expect.anything());
    expect(queue.authorizeObservation).not.toHaveBeenCalled();
  });

  it("retains an ambiguous failed comment and rejects repeated apply attempts without another write", async () => {
    const { gatekeeper, queue, kv } = await workflowGatekeeper("123");
    const fetcher = vi.fn(async () => Response.json({ ticket: { id: 123, updated_at: "stamp" } }));
    vi.stubGlobal("fetch", fetcher);
    const session = await gatekeeper.startSession(queue as never) as ZendeskTicketSession;
    const action = await session.addComment({ body: "Do not duplicate" });
    fetcher.mockClear().mockRejectedValue(new Error("Connection lost after sending request"));
    await expect(gatekeeper.applyAction(action.actionId)).rejects.toThrow("Connection lost");
    expect(kv.get(`action:${action.actionId}`)).toMatchObject({ status: "failed", body: "Do not duplicate", updateStamp: "stamp" });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(gatekeeper.applyAction(action.actionId)).rejects.toThrow(/ambiguous.*verify whether it applied/);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(gatekeeper.getActionResult(action.actionId)).toMatchObject({ status: "failed" });
  });

  it("rejects legacy failed, missing, rejected, and in-flight actions rather than resolving unapplied no-ops", async () => {
    const { gatekeeper, kv } = await workflowGatekeeper();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    kv.set("result:1", { status: "failed", message: "Old provider failure" });
    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/Old provider failure.*verify the outcome/);
    await expect(gatekeeper.applyAction(2)).rejects.toThrow("unavailable");
    kv.set("result:3", { status: "rejected" });
    await expect(gatekeeper.applyAction(3)).rejects.toThrow("rejected");
    for (const claimedAt of [Date.now(), 0]) {
      kv.set("action:4", { id: 4, kind: "fields", ticketId: "123", fields: { status: "pending" }, updateStamp: "stamp", status: "applying", claimedAt });
      await expect(gatekeeper.applyAction(4)).rejects.toThrow(/in progress or its outcome is ambiguous/);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never upgrades an invalid ticket resource URL to account-wide access", async () => {
    const { ZendeskUserImpl } = await import("../src/zendesk");
    const makeClass = vi.fn(() => ({}));
    const user = new ZendeskUserImpl({ props: { accountId: "account", subdomain: "acme" }, exports: { ZendeskGatekeeper: makeClass } } as never, {} as never);
    for (const url of ["https://acme.zendesk.com/agent/tickets/not-a-ticket", "https://acme.zendesk.com/agent/tickets/123/other", "https://acme.zendesk.com/agent", "http://acme.zendesk.com", "https://acme.zendesk.com:8443", "https://other.zendesk.com"]) {
      await expect(user.getGatekeeperClassFor(url)).rejects.toThrow();
    }
    expect(makeClass).not.toHaveBeenCalled();
    await user.getGatekeeperClassFor("https://acme.zendesk.com/agent/tickets/123");
    expect(makeClass).toHaveBeenLastCalledWith({ props: { accountId: "account", subdomain: "acme", ticketId: "123" } });
    await user.getGatekeeperClassFor("https://acme.zendesk.com");
    expect(makeClass).toHaveBeenLastCalledWith({ props: { accountId: "account", subdomain: "acme", ticketId: undefined } });
  });

  it("exposes live current-user identity only through an authorized account observation", async () => {
    const { gatekeeper, queue } = await workflowGatekeeper();
    const fetcher = vi.fn(async () => Response.json({ user: { id: 17, name: "Agent", email: "agent@example.test" }, authenticity_token: "never exposed" }));
    vi.stubGlobal("fetch", fetcher);
    const session = await gatekeeper.startSession(queue as never) as ZendeskAccountSession;
    await expect(session.getCurrentUser()).resolves.toEqual({ id: "17", displayName: "Agent", uniqueName: "agent@example.test" });
    expect(queue.authorizeObservation).toHaveBeenCalledWith(expect.objectContaining({ prohibitAllSharing: true }));
    expect(fetcher).toHaveBeenCalledWith("https://acme.zendesk.com/api/v2/users/me.json", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token" }) }));
    expect(await session.listTools()).toContainEqual(expect.objectContaining({ name: "zendesk_get_current_user", mode: "read" }));
    await expect(session.callTool("zendesk_get_current_user")).resolves.toMatchObject({ status: "ok", structuredContent: { id: "17" } });
    queue.authorizeObservation.mockRejectedValue(new Error("observation denied"));
    await expect(session.getCurrentUser()).rejects.toThrow("observation denied");
    await expect(session.callTool("zendesk_get_current_user")).rejects.toThrow("observation denied");
  });

  it("rejects anonymous self responses and does not widen ticket sessions", async () => {
    const { gatekeeper, queue } = await workflowGatekeeper("123");
    const session = await gatekeeper.startSession(queue as never);
    expect("getCurrentUser" in session).toBe(false);
    expect("searchTickets" in session).toBe(false);
    expect("callTool" in session).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ user: { id: null } })));
    await expect(gatekeeper.getCurrentUser()).rejects.toThrow("signed-in user");
  });

  it("keeps shipped numeric search cursors and stops before the provider ceiling", async () => {
    const { gatekeeper, queue } = await workflowGatekeeper();
    const fetcher = vi.fn(async (_url: string) => Response.json({ results: [{ id: 123, subject: "Ticket" }], count: 1001, next_page: "next" }));
    vi.stubGlobal("fetch", fetcher);
    const session = await gatekeeper.startSession(queue as never) as ZendeskAccountSession;
    await expect(session.searchTickets({ query: "status:open", limit: 50, cursor: "2" })).resolves.toMatchObject({ cursors: { zendesk: "3" }, hasMore: { zendesk: true } });
    const url = new URL(fetcher.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/api/v2/search.json");
    expect(url.searchParams.get("query")).toBe("type:ticket status:open");
    expect(url.searchParams.get("page")).toBe("2");
    await expect(session.searchTickets({ limit: 50, cursor: "20" })).resolves.toMatchObject({ cursors: {}, hasMore: { zendesk: false }, truncated: { zendesk: true } });
    await expect(session.searchTickets({ limit: 30, cursor: "33" })).resolves.toMatchObject({ cursors: {}, truncated: { zendesk: true } });
    fetcher.mockClear();
    await expect(session.searchTickets({ limit: 50, cursor: "21" })).rejects.toThrow("1,000 results");
    await expect(session.searchTickets({ limit: 30, cursor: "34" })).rejects.toThrow("1,000 results");
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(Response.json({ results: [], count: 1000, next_page: null }));
    await expect(session.searchTickets({ limit: 50, cursor: "20" })).resolves.toMatchObject({ truncated: { zendesk: false }, completeness: { zendesk: true } });
  });

  it("pages every match through the export endpoint and only reports completeness on the last page", async () => {
    const { gatekeeper, queue } = await workflowGatekeeper();
    const fetcher = vi.fn(async (input: string) => new URL(input).searchParams.get("page[after]")
      ? Response.json({ results: [{ id: 2, subject: "Second" }], meta: { has_more: false, after_cursor: null } })
      : Response.json({ results: [{ id: 1, subject: "First" }], meta: { has_more: true, after_cursor: "MjAyNi0wOS0wOQ==" } }));
    vi.stubGlobal("fetch", fetcher);
    const session = await gatekeeper.startSession(queue as never) as ZendeskAccountSession;

    const first = await session.searchTickets({ query: "status:open", limit: 50, exhaustive: true });
    expect(first).toMatchObject({ hasMore: { zendesk: true }, truncated: { zendesk: false }, completeness: { zendesk: false } });
    const url = new URL(fetcher.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/api/v2/search/export");
    expect(url.searchParams.get("filter[type]")).toBe("ticket");
    expect(url.searchParams.get("query")).toBe("status:open");
    expect(url.searchParams.get("page[size]")).toBe("50");
    expect(url.searchParams.get("page[after]")).toBeNull();

    const second = await session.searchTickets({ query: "status:open", limit: 50, cursor: first.cursors.zendesk });
    expect(second).toMatchObject({ items: [{ id: "2" }], cursors: {}, hasMore: { zendesk: false }, completeness: { zendesk: true } });
    expect(new URL(fetcher.mock.calls[1][0] as string).searchParams.get("page[after]")).toBe("MjAyNi0wOS0wOQ==");
  });

  it("rejects export cursors that do not belong to this site, query, page size, or path", async () => {
    const fetcher = vi.fn(async () => Response.json({ results: [], meta: { has_more: true, after_cursor: "next-cursor" } }));
    vi.stubGlobal("fetch", fetcher);
    const acme = await workflowGatekeeper();
    const acmeSession = await acme.gatekeeper.startSession(acme.queue as never) as ZendeskAccountSession;
    const cursor = (await acmeSession.searchTickets({ query: "status:open", limit: 50, exhaustive: true })).cursors.zendesk!;
    expect(cursor.startsWith("zdx1.")).toBe(true);

    // Same site, but a cursor must not silently page a different query or page size.
    await expect(acmeSession.searchTickets({ query: "status:closed", limit: 50, cursor })).rejects.toThrow("different site, query, or page size");
    await expect(acmeSession.searchTickets({ query: "status:open", limit: 25, cursor })).rejects.toThrow("different site, query, or page size");
    await expect(acmeSession.searchTickets({ query: "status:open", limit: 50, cursor: "zdx1.00112233445566ff.next" })).rejects.toThrow("different site, query, or page size");
    await expect(acmeSession.searchTickets({ query: "status:open", limit: 50, cursor: "zdx1.nothex.next" })).rejects.toThrow("export cursor is invalid");

    // A cursor minted against another Zendesk site never pages this one.
    const other = await workflowGatekeeper(undefined, "globex");
    const otherSession = await other.gatekeeper.startSession(other.queue as never) as ZendeskAccountSession;
    await expect(otherSession.searchTickets({ query: "status:open", limit: 50, cursor })).rejects.toThrow("different site, query, or page size");

    // Offset and export pagination order results differently, so the two cursor kinds must never be mixed.
    fetcher.mockClear();
    await expect(acmeSession.searchTickets({ query: "status:open", limit: 50, cursor: "2", exhaustive: true })).rejects.toThrow("cannot be mixed");
    await expect(acmeSession.searchTickets({ query: "type:user", exhaustive: true })).rejects.toThrow("does not accept type:");
    await expect(acmeSession.searchTickets({ exhaustive: true })).rejects.toThrow("requires a query");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails an export page that claims more results without a cursor rather than reporting it complete", async () => {
    const { gatekeeper, queue } = await workflowGatekeeper();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [{ id: 5 }], meta: { has_more: true, after_cursor: null } })));
    const session = await gatekeeper.startSession(queue as never) as ZendeskAccountSession;
    await expect(session.searchTickets({ query: "status:open", limit: 50, exhaustive: true })).rejects.toThrow("missing its next cursor");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: null, meta: { has_more: false } })));
    await expect(session.searchTickets({ query: "status:open", limit: 50, exhaustive: true })).rejects.toThrow("malformed export search page");
  });

  it.each([{}, { meta: {} }, { meta: { has_more: "false" } }])("rejects missing or invalid export completion metadata: %j", async metadata => {
    const { gatekeeper, queue } = await workflowGatekeeper();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [], ...metadata })));
    const session = await gatekeeper.startSession(queue as never) as ZendeskAccountSession;
    await expect(session.searchTickets({ query: "status:open", exhaustive: true })).rejects.toThrow("malformed export search page");
  });

  it("rejects a repeated export continuation instead of looping", async () => {
    const { gatekeeper, queue } = await workflowGatekeeper();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [], meta: { has_more: true, after_cursor: "same" } })));
    const session = await gatekeeper.startSession(queue as never) as ZendeskAccountSession;
    const first = await session.searchTickets({ query: "status:open", exhaustive: true });
    await expect(session.searchTickets({ query: "status:open", cursor: first.cursors.zendesk })).rejects.toThrow("invalid continuation");
  });

  it("reads later comments, users, attachments, and audits beyond the old 50-entry cut", async () => {
    const { gatekeeper } = await workflowGatekeeper();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      const after = url.searchParams.get("page[after]");
      if (url.pathname.endsWith("comments.json")) return Response.json(after ?
        { comments: [{ id: 2, author_id: 17, body: "Latest", attachments: [{ id: 8, file_name: "later.txt", content_url: "https://acme.zendesk.com/attachments/8" }] }], users: [{ id: 17, name: "Agent" }], meta: { has_more: false } } :
        { comments: [{ id: 1, body: "First" }], meta: { has_more: true }, links: { next: "https://acme.zendesk.com/api/v2/tickets/123/comments.json?page[after]=next" } });
      if (url.pathname.endsWith("audits.json")) return Response.json(after ?
        { audits: [{ id: 51 }], meta: { has_more: false } } :
        { audits: Array.from({ length: 50 }, (_, id) => ({ id })), meta: { has_more: true }, links: { next: "/api/v2/tickets/123/audits.json?page[after]=next" } });
      if (url.pathname.startsWith("/attachments/")) return new Response("content");
      return Response.json({ ticket: { id: 123, assignee_id: 17 } });
    }));
    const result = await gatekeeper.readTicket("123");
    expect(result.comments.map(comment => comment.body)).toEqual(["First", "Latest"]);
    expect(result.comments[1].author).toBe("Agent");
    expect(result.comments[1].truncated).toBe(false);
    expect(result.activity).toHaveLength(51);
    expect(result.attachments).toEqual([expect.objectContaining({ id: "8", commentId: "2" })]);
    expect((await gatekeeper.readAttachment("123", "8")).name).toBe("later.txt");
  });

  it("marks long comment bodies as truncated and authorizes history only after all pages succeed", async () => {
    const { gatekeeper, queue } = await workflowGatekeeper();
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("comments.json")) return Response.json({ comments: [{ id: 1, body: "x".repeat(12001) }] });
      if (url.includes("audits.json")) return Response.json({ audits: [] });
      return Response.json({ ticket: { id: 123 } });
    });
    vi.stubGlobal("fetch", fetcher);
    const session = await gatekeeper.startSession(queue as never) as ZendeskAccountSession;
    const result = await session.readTicket("123");
    expect(result.comments[0].body).toHaveLength(12000);
    expect(result.comments[0].truncated).toBe(true);
    queue.authorizeObservation.mockClear();
    fetcher.mockImplementation(async url => {
      if (url.includes("page=2")) return Response.json({ error: "Forbidden" }, { status: 403 });
      if (url.includes("comments.json")) return Response.json({ comments: [{ id: 1 }], next_page: "/api/v2/tickets/123/comments.json?page=2" });
      if (url.includes("audits.json")) return Response.json({ audits: [] });
      return Response.json({ ticket: { id: 123 } });
    });
    await expect(session.readTicket("123")).rejects.toMatchObject({ status: 403 });
    expect(queue.authorizeObservation).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil.example/api/v2/tickets/123/comments.json?page=2",
    "https://acme.zendesk.com/api/v2/tickets/456/comments.json?page=2",
    "https://acme.zendesk.com/api/v2/users.json?page=2",
    "https://user@acme.zendesk.com/api/v2/tickets/123/comments.json?page=2",
  ])("rejects history pagination outside the ticket: %s", async next => {
    const fetcher = vi.fn(async () => Response.json({ comments: [], next_page: next }));
    vi.stubGlobal("fetch", fetcher);
    await expect(new ZendeskApi("acme", async () => "token").comments("123")).rejects.toThrow("outside the requested ticket");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: "error" }));
  });

  it("rejects broken, looping, failed, and over-budget history instead of returning partial data", async () => {
    const api = new ZendeskApi("acme", async () => "token");
    const fetcher = vi.fn(async () => Response.json({ comments: [], meta: { has_more: true } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(api.comments("123")).rejects.toThrow("missing its next page");
    fetcher.mockImplementation(async () => Response.json({ comments: [], next_page: "/api/v2/tickets/123/comments.json?page=2" }));
    await expect(api.comments("123")).rejects.toThrow("repeated a page");
    fetcher.mockReset().mockResolvedValueOnce(Response.json({ comments: [{ id: 1 }], next_page: "/api/v2/tickets/123/comments.json?page=2" })).mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status: 503 }));
    await expect(api.comments("123")).rejects.toMatchObject({ status: 503 });
    let page = 0;
    fetcher.mockImplementation(async () => Response.json({ comments: [], next_page: `/api/v2/tickets/123/comments.json?page=${++page}` }));
    await expect(api.comments("123")).rejects.toThrow("pagination exceeded its limit");
    expect(page).toBe(100);
    page = 0;
    fetcher.mockImplementation(async () => Response.json({ comments: [{ id: page, body: "x".repeat(900_000) }], next_page: `/api/v2/tickets/123/comments.json?page=${++page}` }));
    await expect(api.comments("123")).rejects.toThrow("history exceeded its size limit");
    expect(page).toBe(9);
  });

  it("does not turn a successful approved write into failure by reading history afterward", async () => {
    const { gatekeeper, queue } = await workflowGatekeeper("123");
    const stamp = "2026-09-09T00:00:00Z";
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ ticket: { id: 123, updated_at: stamp, status: init?.method === "PUT" ? "pending" : "open" } }));
    vi.stubGlobal("fetch", fetcher);
    const session = await gatekeeper.startSession(queue as never) as ZendeskTicketSession;
    const pending = await session.addComment({ body: "Internal note" });
    expect(queue.submitAction).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== "PUT")).toBe(true);
    fetcher.mockClear();
    await gatekeeper.applyAction(pending.actionId);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ ticket: { comment: { body: "Internal note", public: false, uploads: [] }, safe_update: true, updated_stamp: stamp } });
    expect(gatekeeper.getActionResult(pending.actionId)).toMatchObject({ status: "ready" });
    await gatekeeper.applyAction(pending.actionId);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves conflict guards and never automatically retries a write", async () => {
    const { gatekeeper, queue } = await workflowGatekeeper("123");
    const fetcher = vi.fn(async () => Response.json({ ticket: { id: 123, updated_at: "old" } }));
    vi.stubGlobal("fetch", fetcher);
    const session = await gatekeeper.startSession(queue as never) as ZendeskTicketSession;
    const pending = await session.updateFields({ fields: { status: "pending" } });
    fetcher.mockClear().mockImplementation(async () => Response.json({ error: "UpdateConflict" }, { status: 409 }));
    await expect(gatekeeper.applyAction(pending.actionId)).rejects.toMatchObject({ status: 409 });
    expect(gatekeeper.getActionResult(pending.actionId)).toMatchObject({ status: "failed" });
    await expect(gatekeeper.applyAction(pending.actionId)).rejects.toThrow(/conflict.*Read the latest ticket.*new action/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() => new ZendeskApi("acme", async () => "token").updateTicket("123", {})).toThrow("update stamp");
  });

  it("rejects oversized writes rather than silently truncating their contents", async () => {
    const { gatekeeper, queue } = await workflowGatekeeper();
    const fetcher = vi.fn(async () => Response.json({ ticket: { id: 123, updated_at: "stamp" } }));
    vi.stubGlobal("fetch", fetcher);
    const session = await gatekeeper.startSession(queue as never) as ZendeskAccountSession;
    await expect(session.callTool("zendesk_add_comment", { id: "123", body: "x".repeat(12001) })).rejects.toThrow("12,000");
    await expect(session.callTool("zendesk_update_fields", { id: "123", fields: { tags: Array(51).fill("tag") } })).rejects.toThrow("value limits");
    await expect(session.callTool("zendesk_update_fields", { id: "123", fields: { custom_1: "x".repeat(2001) } })).rejects.toThrow("value limits");
    await expect(session.callTool("zendesk_update_fields", { id: "123", fields: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`custom_${i}`, true])) })).rejects.toThrow("1 to 10");
    await expect(session.callTool("zendesk_update_fields", { id: "123", fields: { requester_id: 17 } })).rejects.toThrow("Unsupported Zendesk field");
    expect(fetcher).not.toHaveBeenCalled();
    expect(queue.submitAction).not.toHaveBeenCalled();
    await expect(session.callTool("zendesk_add_comment", { id: "123", body: "Note", attachmentTokens: Array(11).fill("token") })).rejects.toThrow("tokens exceed");
    await expect(session.callTool("zendesk_add_comment", { id: "123", body: "Note", attachmentTokens: ["unknown"] })).rejects.toThrow("invalid, expired, consumed");
    expect(queue.submitAction).not.toHaveBeenCalled();
  });
});

describe("Zendesk token lifecycle regressions", () => {
  const env = { CLIENT_ID: "client", CLIENT_SECRET: "secret" };
  async function accountWithGrant(grant: Record<string, unknown>) {
    const { ZendeskAccount } = await import("../src/zendesk");
    const { kv, storage } = makeTestStorage();
    kv.set("subdomain", "acme");
    kv.set("grant", grant);
    const callback = { credentialsExpired: vi.fn(), credentialsRestored: vi.fn() };
    kv.set("callback", callback);
    const account = new ZendeskAccount({ storage } as never, env as never);
    return { account, kv, callback };
  }

  it.each([undefined, null])("does not invent an expiry when expires_in is %s", async expires_in => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "access", refresh_token: "refresh", expires_in })));
    const grant = await exchangeAuthCode({ subdomain: "acme", code: "code", clientId: "client", clientSecret: "secret", redirectUri: "https://example.test/oauth", scope: "read write" });
    expect(grant.expiresAt).toBeNull();
    const { account } = await accountWithGrant(grant);
    await expect(account.getAccessToken()).resolves.toBe("access");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent refreshes, rotates tokens, and retains the granted scope", async () => {
    const { account, kv } = await accountWithGrant({ accessToken: "old", refreshToken: "old-refresh", expiresAt: 0, scope: "read" });
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ access_token: "new", refresh_token: "new-refresh", expires_in: 1800 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(Promise.all([account.getAccessToken(), account.getAccessToken(), account.getAccessToken()])).resolves.toEqual(["new", "new", "new"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ refresh_token: "old-refresh", scope: "read" });
    expect(kv.get("grant")).toMatchObject({ accessToken: "new", refreshToken: "new-refresh", scope: "read" });
  });

  it("reports invalid_grant as expired but leaves transient failures retryable", async () => {
    const { account, kv, callback } = await accountWithGrant({ accessToken: "old", refreshToken: "refresh", expiresAt: 0 });
    const fetcher = vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(account.getAccessToken()).rejects.toMatchObject({ status: 401 });
    await expect(account.getAccessToken()).rejects.toMatchObject({ status: 401 });
    expect(callback.credentialsExpired).toHaveBeenCalledTimes(1);
    kv.delete("expiredNotified");
    callback.credentialsExpired.mockClear();
    fetcher.mockImplementationOnce(async () => Response.json({ error: "Unavailable" }, { status: 503 }));
    await expect(account.getAccessToken()).rejects.toMatchObject({ status: 503 });
    expect(callback.credentialsExpired).not.toHaveBeenCalled();
    fetcher.mockImplementationOnce(async () => Response.json({ access_token: "new", expires_in: 1800 }));
    await expect(account.getAccessToken()).resolves.toBe("new");
  });

  it("does not restore a grant revoked while refresh is in flight", async () => {
    const { account, kv } = await accountWithGrant({ accessToken: "old", refreshToken: "refresh", expiresAt: 0 });
    vi.stubGlobal("fetch", vi.fn(async () => { kv.delete("grant"); return Response.json({ access_token: "new", expires_in: 1800 }); }));
    await expect(account.getAccessToken()).rejects.toThrow("credentials changed");
    expect(kv.get("grant")).toBeUndefined();
  });

  it("preserves legacy non-expiring tokens but probes the provider for connection health", async () => {
    const { ZendeskUserImpl } = await import("../src/zendesk");
    const { account, callback } = await accountWithGrant({ accessToken: "legacy", expiresAt: 0 });
    const fetcher = vi.fn(async () => Response.json({ error: "Unauthorized" }, { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(account.getAccessToken()).resolves.toBe("legacy");
    expect(fetcher).not.toHaveBeenCalled();
    const user = new ZendeskUserImpl({ props: { accountId: "account", subdomain: "acme" }, exports: { ZendeskAccount: { idFromString: (id: string) => id, get: () => account } } } as never, env as never);
    await expect(user.getConnectionStatus()).resolves.toMatchObject({ state: "expired" });
    expect(callback.credentialsExpired).toHaveBeenCalledTimes(1);
  });

  it("resets identity and expiry notification on reconnect without changing the bound subdomain", async () => {
    const { account, kv, callback } = await accountWithGrant({ accessToken: "old", expiresAt: 0 });
    kv.set("identity", { id: 1 });
    kv.set("expiredNotified", true);
    await account.prepareReconnect("nonce");
    await expect(account.beginOAuth("nonce", "other")).rejects.toThrow("original Zendesk subdomain");
    const begun = await account.beginOAuth("nonce", "acme");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "new" })));
    await account.acceptAuthCode("code", begun!.oauthNonce);
    expect(callback.credentialsRestored).toHaveBeenCalledTimes(1);
    expect(kv.get("identity")).toBeUndefined();
    expect(kv.get("expiredNotified")).toBeUndefined();
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
    expect(kv.get("action:7")).toMatchObject({ status: "failed", updateStamp: "2026-09-04T00:00:00Z" });
    await expect(gatekeeper.applyAction(7)).rejects.toThrow(/ambiguous.*verify whether it applied/);
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

/**
 * The account-owned facet that backs the Work Items app UI.
 *
 * The workerd suite (`__tests__/workerd/app-ui.test.ts`) proves the wiring against the real runtime;
 * these tests cover what that runtime cannot yet do -- staging an upload sets an alarm, and
 * miniflare does not implement alarms on facets. The fake below is deliberately faithful on the one
 * point the shipped bug turned on: `exports.ZendeskGatekeeper({props})` hands back an inert
 * description of a class, and only `facets.get` turns it into something with methods.
 */
describe("Zendesk Work Items app UI facet", () => {
  const env = { BASE_URL: "https://workshop.example/gatekeeper/zendesk", CLIENT_ID: "client", CLIENT_SECRET: "secret" };
  const accountId = "5".repeat(64);
  const TICKET = { id: 123, subject: "Login fails", description: "Cannot sign in.", status: "open", updated_at: "2026-09-04T00:00:00Z" };

  type FacetClass = { props: { accountId: string; subdomain: string; ticketId?: string } };

  async function accountWithFacets(subdomain = "acme") {
    const { ZendeskAccount, ZendeskGatekeeper } = await import("../src/zendesk");
    const { kv, storage } = makeTestStorage();
    kv.set("subdomain", subdomain);
    kv.set("grant", { accessToken: "token", expiresAt: null });
    const facet = makeTestStorage();
    const live = new Map<string, unknown>();
    const opened: Array<{ name: string; durableClass: FacetClass }> = [];
    const accountRef: { current?: unknown } = {};
    const account = new ZendeskAccount({
      id: { toString: () => accountId },
      storage,
      facets: {
        get(name: string, start: () => { class: FacetClass }) {
          const durableClass = start().class;
          opened.push({ name, durableClass });
          // One live object per facet name, exactly like the runtime: a second `get` under the same
          // name reaches the object the first one created, storage and all.
          if (!live.has(name)) {
            live.set(name, new ZendeskGatekeeper({
              props: durableClass.props,
              storage: facet.storage,
              exports: { ZendeskAccount: { idFromString: (id: string) => id, get: () => accountRef.current } },
            } as never, env as never));
          }
          return live.get(name);
        },
      },
      exports: {
        // What `ctx.exports.ZendeskGatekeeper({props})` really returns: a `DurableObjectClass`,
        // which carries the props and nothing else. Calling `sourceStatuses()` on it is the
        // production failure.
        ZendeskGatekeeper: (options: { props: FacetClass["props"] }): FacetClass => ({ props: options.props }),
        ZendeskAccount: { idFromString: (id: string) => id, get: () => accountRef.current },
      },
    } as never, env as never);
    accountRef.current = account;
    return { account, opened, facetKv: facet.kv };
  }

  /** The Node mock of `cloudflare:workers` keeps the wrapped target on `.value`. */
  function unwrap<T>(stub: unknown): T {
    return (stub as { value: T }).value;
  }

  function stubZendesk(): ReturnType<typeof vi.fn> {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === "/api/v2/users/me.json") return Response.json({ user: { id: 7, name: "Agent", email: "agent@example.test" } });
      if (url.pathname === "/api/v2/search.json") return Response.json({ results: [TICKET], count: 1, next_page: null });
      if (url.pathname === "/api/v2/tickets/123.json") return Response.json({ ticket: TICKET });
      if (url.pathname === "/api/v2/tickets/123/comments.json") return Response.json({ comments: [{ id: 1, author_id: 8, plain_body: "Still broken.", public: true, attachments: [] }], users: [{ id: 8, name: "Customer" }], meta: { has_more: false } });
      if (url.pathname === "/api/v2/tickets/123/audits.json") return Response.json({ audits: [], users: [], meta: { has_more: false } });
      if (url.pathname === "/api/v2/uploads.json") return Response.json({ upload: { token: "upload-token-1", expires_at: "2026-09-05T00:00:00Z", attachment: { id: 55, file_name: "note.txt", content_type: "text/plain", size: 5 } } });
      return Response.json({ error: `unexpected ${url.pathname}` }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetcher);
    return fetcher as never;
  }

  it("opens the gatekeeper on the account's own id and stored subdomain, never a caller's", async () => {
    const { account, opened } = await accountWithFacets();
    stubZendesk();

    account.workItemsManagementUi();
    account.workItemsManagementUi();

    expect(opened).toHaveLength(2);
    expect(new Set(opened.map(entry => entry.name)).size).toBe(1);
    for (const entry of opened) {
      expect(entry.durableClass.props).toEqual({ accountId, subdomain: "acme" });
      expect(entry.durableClass.props).not.toHaveProperty("ticketId");
    }
  });

  it("refuses to open before the account has a stored subdomain", async () => {
    const { ZendeskAccount } = await import("../src/zendesk");
    const { storage } = makeTestStorage();
    const account = new ZendeskAccount({ id: { toString: () => accountId }, storage, facets: { get: vi.fn() } } as never, env as never);
    expect(() => account.workItemsManagementUi()).toThrow(/credentials have not been configured/);
  });

  it("hands the adapter something callable, not the DurableObjectClass", async () => {
    const { account, opened } = await accountWithFacets();
    const fetcher = stubZendesk();

    const ui = unwrap<{
      getSourceStatuses(): Promise<unknown>;
      search(request: unknown): Promise<{ items: Array<{ key: string; url: string }> }>;
      item(ref: unknown): Promise<unknown>;
    }>(account.workItemsManagementUi());

    // The value `ctx.exports.ZendeskGatekeeper({props})` actually returns, which the old code passed
    // straight into the adapter. It carries props and nothing else -- no gatekeeper methods at all.
    const durableClass = opened[0].durableClass as FacetClass & { sourceStatuses?: unknown };
    expect(durableClass.sourceStatuses).toBeUndefined();

    await expect(ui.getSourceStatuses()).resolves.toMatchObject({ zendesk: { configured: true, connected: true } });

    const page = await ui.search({ source: "zendesk", query: "login" });
    expect(page.items.map(item => item.key)).toEqual(["ZD-123"]);
    expect(page.items[0].url).toBe("https://acme.zendesk.com/agent/tickets/123");

    const ticket = unwrap<{ read(): Promise<{ detail: { item: { title: string } } }> }>(await ui.item({ source: "zendesk", id: "123" }));
    await expect(ticket.read()).resolves.toMatchObject({ detail: { item: { title: "Login fails" } } });

    const hosts = new Set(fetcher.mock.calls.map(([input]) => new URL(String(input)).hostname));
    expect(hosts).toEqual(new Set(["acme.zendesk.com"]));
  });

  it("keeps one facet per account, so an upload staged in one app-UI open is usable in the next", async () => {
    const { account, facetKv } = await accountWithFacets();
    const fetcher = stubZendesk();

    const first = unwrap<{ item(ref: unknown): Promise<unknown> }>(account.workItemsManagementUi());
    const staged = await unwrap<{ createAttachment(input: unknown): Promise<{ uploadToken: string }> }>(
      await first.item({ source: "zendesk", id: "123" }),
    ).createAttachment({ name: "note.txt", contentType: "text/plain", target: "comment", data: new Uint8Array([104, 101, 108, 108, 111]) });
    expect(staged.uploadToken).toBe("upload-token-1");
    expect(facetKv.get("upload:upload-token-1")).toMatchObject({ ticketId: "123" });

    // A per-open facet name would give this second surface an empty store, and the token would be
    // rejected as "invalid, expired, consumed, or belongs to another ticket".
    const second = unwrap<{ item(ref: unknown): Promise<unknown> }>(account.workItemsManagementUi());
    await unwrap<{ addComment(input: unknown): Promise<unknown> }>(
      await second.item({ source: "zendesk", id: "123" }),
    ).addComment({ body: "Attaching the log.", visibility: "internal", attachmentTokens: [staged.uploadToken] });

    const update = fetcher.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
    expect(JSON.parse(String((update![1] as RequestInit).body)).ticket.comment.uploads).toEqual(["upload-token-1"]);
    expect(facetKv.get("upload:upload-token-1")).toBeUndefined();
  });
});
