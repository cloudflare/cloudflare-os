// Covers the account-wide Work Items app UI end to end in workerd: `startAppUi` on the real
// `ZendeskUserImpl` entrypoint, through the account Durable Object, onto the gatekeeper facet the
// account owns, with only the Zendesk HTTP calls mocked.
//
// The shipped regression this pins down: `startAppUi` handed the adapter
// `ctx.exports.ZendeskGatekeeper({props})`, which is a `DurableObjectClass` -- a description of a
// class, not a running object -- so the first call the UI made died with
// "this.gatekeeper.sourceStatuses is not a function". Nothing short of the real runtime catches
// that: a hand-written double answers `sourceStatuses()` no matter which of the two it was given,
// and `ctx.facets` (the only way to instantiate a props-carrying class) does not exist outside it.
//
// Every Zendesk request is served by the stub below. Nothing here reaches a real Zendesk tenant, and
// no test writes to a live ticket.

import { env } from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import type { ZendeskAccount } from "../../src/zendesk.js";
import type {
  GatekeeperConnectCallback,
  GatekeeperUiFrame,
  GatekeeperUser,
} from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkItemsManagementApi } from "../../src/types.js";
import type { TestHooks } from "../worker.js";

const SUBDOMAIN = "acme";
const OTHER_SUBDOMAIN = "evil";
const NONCE = "a".repeat(64);
const TICKET_ID = "123";

// `TestConnectCallback` and `TestHooks` live in the test worker, so they are absent from the
// generated `Cloudflare.Exports` (which describes `src/zendesk.ts`). This declares just the two
// entrypoints this file reaches for.
const testExports = workerExports as unknown as Cloudflare.Exports & {
  TestConnectCallback(options: Record<string, never>): Fetcher<GatekeeperConnectCallback>;
};

// The bindings `vitest.worker.config.ts` adds. Narrowed here rather than merged into
// `Cloudflare.Env`, which the Node suite constructs by hand. Production binds neither: a Zendesk
// account is reached through the id minted at connect time, never by namespace.
const testEnv = env as Cloudflare.Env & {
  ZENDESK_ACCOUNT: DurableObjectNamespace<ZendeskAccount>;
  TEST_HOOKS: DurableObjectNamespace<TestHooks>;
};

const TICKET = {
  id: Number(TICKET_ID),
  subject: "Login fails after SSO change",
  description: "Customer cannot sign in.",
  status: "open",
  priority: "high",
  type: "incident",
  assignee_id: 7,
  requester_id: 8,
  updated_at: "2026-09-04T00:00:00Z",
};

type Call = { method: string; url: string; body?: string };

/**
 * Routes every Zendesk endpoint the app UI touches. Returns the recorded calls so a test can assert
 * which subdomain was addressed -- the check that the facet's props came from the account's own
 * stored subdomain rather than from anything a caller supplied.
 */
function stubZendesk(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.toString(), body: init?.body ? String(init.body) : undefined });
    const path = url.pathname;
    if (path === "/oauth/tokens") {
      return Response.json({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600, scope: "read write" });
    }
    if (path === "/api/v2/users/me.json") {
      return Response.json({ user: { id: 7, name: "Support Agent", email: `agent@${url.hostname}` } });
    }
    if (path === "/api/v2/search.json") {
      return Response.json({ results: [TICKET], count: 1, next_page: null });
    }
    if (path === `/api/v2/tickets/${TICKET_ID}.json`) {
      return Response.json({ ticket: TICKET });
    }
    if (path === `/api/v2/tickets/${TICKET_ID}/comments.json`) {
      return Response.json({ comments: [{ id: 1, author_id: 8, plain_body: "Still broken.", public: true, created_at: "2026-09-04T00:00:00Z", attachments: [] }], users: [{ id: 8, name: "Customer" }], meta: { has_more: false } });
    }
    if (path === `/api/v2/tickets/${TICKET_ID}/audits.json`) {
      return Response.json({ audits: [], users: [], meta: { has_more: false } });
    }
    if (path === "/api/v2/uploads.json") {
      return Response.json({ upload: { token: "upload-token-1", expires_at: "2026-09-05T00:00:00Z", attachment: { id: 55, file_name: "note.txt", content_type: "text/plain", size: 5 } } });
    }
    return Response.json({ error: `unexpected ${method} ${path}` }, { status: 500 });
  });
  return calls;
}

function accountFor(name: string) {
  return testEnv.ZENDESK_ACCOUNT.get(testEnv.ZENDESK_ACCOUNT.idFromName(name));
}

/** Drives the real connect flow so the account holds a grant and a stored subdomain. */
async function connect(name: string, subdomain: string): Promise<string> {
  const account = accountFor(name);
  await account.setCallback(testExports.TestConnectCallback({}), NONCE);
  const begun = await account.beginOAuth(NONCE, subdomain);
  expect(begun).not.toBeNull();
  await account.acceptAuthCode("auth-code", begun!.oauthNonce);
  return testEnv.ZENDESK_ACCOUNT.idFromName(name).toString();
}

/** Opens the app UI the way the Workshop does: through the vendor's own account entrypoint. */
async function openAppUi(accountId: string, subdomain: string): Promise<GatekeeperUiFrame> {
  const user = testExports.ZendeskUserImpl({ props: { accountId, subdomain } }) as unknown as
    Required<Pick<GatekeeperUser, "startAppUi">>;
  return user.startAppUi({ isAdmin: false });
}

function managementApi(frame: GatekeeperUiFrame): WorkItemsManagementApi {
  return frame.ui as unknown as WorkItemsManagementApi;
}

let calls: Call[];

beforeEach(() => {
  calls = stubZendesk();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Zendesk Work Items app UI", () => {
  it("serves status, search, and ticket reads from a live gatekeeper", async () => {
    const accountId = await connect("statuses", SUBDOMAIN);
    const ui = managementApi(await openAppUi(accountId, SUBDOMAIN));

    // The exact call that failed in production. A `DurableObjectClass` has no `sourceStatuses`.
    const statuses = await ui.getSourceStatuses();
    expect(statuses.zendesk).toEqual({ configured: true, connected: true });

    const page = await ui.search({ source: "zendesk", query: "login" });
    expect(page.items.map(item => item.key)).toEqual([`ZD-${TICKET_ID}`]);

    const item = await ui.item({ source: "zendesk", id: TICKET_ID });
    const read = await item.read();
    expect(read.detail.item.title).toBe(TICKET.subject);
    expect(read.comments.map(comment => comment.body)).toEqual(["Still broken."]);
  });

  it("addresses only the subdomain the account stored, not one supplied by the caller", async () => {
    const accountId = await connect("scoped", SUBDOMAIN);
    // A caller-supplied prop that disagrees with the grant. The facet is built from the account's
    // own stored subdomain, so it must be ignored rather than followed.
    const ui = managementApi(await openAppUi(accountId, OTHER_SUBDOMAIN));

    const page = await ui.search({ source: "zendesk", query: "login" });

    expect(page.items[0].url).toBe(`https://${SUBDOMAIN}.zendesk.com/agent/tickets/${TICKET_ID}`);
    const hosts = new Set(calls.map(call => new URL(call.url).hostname));
    expect(hosts).toEqual(new Set([`${SUBDOMAIN}.zendesk.com`]));
    expect(hosts.has(`${OTHER_SUBDOMAIN}.zendesk.com`)).toBe(false);
  });

  it("refuses to open before the account has credentials", async () => {
    const accountId = testEnv.ZENDESK_ACCOUNT.idFromName("unconnected").toString();
    await expect(openAppUi(accountId, SUBDOMAIN)).rejects.toThrow(/credentials have not been configured/);
  });

  it("consumes a staged upload after reopening the account UI without using facet alarms", async () => {
    const accountId = await connect("upload-sharing", SUBDOMAIN);
    const firstUi = managementApi(await openAppUi(accountId, SUBDOMAIN));
    const firstItem = await firstUi.item({ source: "zendesk", id: TICKET_ID });
    const upload = await firstItem.createAttachment({ name: "note.txt", contentType: "text/plain", target: "comment", data: new Uint8Array([104, 101, 108, 108, 111]) });
    expect(upload.uploadToken).toBe("upload-token-1");
    const secondUi = managementApi(await openAppUi(accountId, SUBDOMAIN));
    const secondItem = await secondUi.item({ source: "zendesk", id: TICKET_ID });
    await secondItem.addComment({ body: "See attachment", attachmentTokens: [upload.uploadToken!] });
    const writes = calls.filter(call => call.method === "PUT");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].body!)).toMatchObject({ ticket: { comment: { uploads: ["upload-token-1"] } } });
    await expect((async () => await secondItem.addComment({ body: "Reuse", attachmentTokens: [upload.uploadToken!] }))()).rejects.toThrow(/invalid, expired, consumed/);
  });

  it("a DurableObjectClass is not a callable gatekeeper", async () => {
    const accountId = await connect("class-vs-stub", SUBDOMAIN);
    const hooks = testEnv.TEST_HOOKS.get(testEnv.TEST_HOOKS.idFromName("class-vs-stub"));

    // The old code path, reproduced verbatim: this is what the adapter used to be handed.
    const message = await hooks.callSourceStatusesOnClass({ accountId, subdomain: SUBDOMAIN });
    expect(message).toMatch(/sourceStatuses is not a function/);

    // The current code path, for contrast, on the same account.
    const ui = managementApi(await openAppUi(accountId, SUBDOMAIN));
    await expect(ui.getSourceStatuses()).resolves.toMatchObject({ zendesk: { connected: true } });
  });

  it("deletes the management facet and its staged uploads on revocation", async () => {
    const name = "revoked-upload";
    const accountId = await connect(name, SUBDOMAIN);
    const ui = managementApi(await openAppUi(accountId, SUBDOMAIN));
    const item = await ui.item({ source: "zendesk", id: TICKET_ID });
    const upload = await item.createAttachment({ name: "note.txt", contentType: "text/plain", target: "comment", data: new Uint8Array([1]) });
    await accountFor(name).revoke();
    // Reusing the test account isolates facet cleanup from credential checks; production reconnects
    // after disconnect create a new account ID instead.
    await connect(name, SUBDOMAIN);
    const freshUi = managementApi(await openAppUi(accountId, SUBDOMAIN));
    const freshItem = await freshUi.item({ source: "zendesk", id: TICKET_ID });
    await expect((async () => await freshItem.addComment({ body: "Old upload", attachmentTokens: [upload.uploadToken!] }))()).rejects.toThrow(/invalid, expired, consumed/);
    expect(calls.filter(call => call.method === "PUT")).toHaveLength(0);
  });
});
