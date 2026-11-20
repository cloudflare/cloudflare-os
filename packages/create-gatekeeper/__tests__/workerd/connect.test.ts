// The pasted-key connect flow of a generated gatekeeper, through its HTTP routes and its account
// Durable Object, against the template's invented provider faked at `fetch`.
//
// A first connect can be followed only up to the Workshop's `complete()`: the account mints its
// entrypoint for that call, which this pool cannot (see `TestUser`). A reconnect goes all the way.

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { identityOf } from "#gatekeeper/acme-credentials";
import { ALL_RESOURCES } from "#gatekeeper/acme-resources";
import { itemUrl, parseResourceUrl } from "#gatekeeper/acme-urls";
import type { Outcome } from "./worker";

const BASE_URL = "http://localhost:8787/gatekeeper/acme";
const ORIGIN = "http://localhost:8787";

type User = { id: string; name: string; email: string };
const ALICE: User = { id: "u-alice", name: "Alice", email: "alice@acme.test" };
const BOB: User = { id: "u-bob", name: "Bob", email: "bob@acme.test" };

/** The provider: `GET /me` answers whose key the bearer token is, and 401 for any other. */
function fakeProvider(keys: Record<string, User>, whileAsked?: () => Promise<unknown>) {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(`${request.method} ${url}`);
    await whileAsked?.();
    if (request.method !== "GET" || url.href !== "https://api.acme.example/me") {
      throw new Error(`fake provider: ${request.method} ${url} is not routed`);
    }
    const user = keys[request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? ""];
    return user ? Response.json(user) : Response.json({ error: "bad key" }, { status: 401 });
  });
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const testEnv = env as any;
const hooks = () => testEnv.TEST_HOOKS.get(testEnv.TEST_HOOKS.idFromName("hooks"));
const account = (id: string) => testEnv.USER_ACCOUNT.get(testEnv.USER_ACCOUNT.idFromString(id));

function unwrap<T>(outcome: Outcome<T>): T {
  if ("error" in outcome) throw new Error(outcome.error);
  return outcome.ok;
}

/** A first connect's link, as `GatekeeperVendor.connectAccount` returns it. */
async function connectLink(): Promise<{ id: string; url: string }> {
  const id = testEnv.USER_ACCOUNT.newUniqueId().toString();
  const nonce = generateNonce();
  await hooks().installCallback(id, nonce);
  return { id, url: `${BASE_URL}/${id}/${nonce}` };
}

/** An account connected as `who` with `key`, the way a completed connect leaves one. */
async function connected(who: User, key: string): Promise<string> {
  const id = testEnv.USER_ACCOUNT.newUniqueId().toString();
  await runInDurableObject(account(id), async (_instance: unknown, state: DurableObjectState) => {
    state.storage.kv.put("credentials", { accessToken: key });
    state.storage.kv.put("identity", { userId: who.id, name: who.name, email: who.email, fetchedAt: Date.now() });
  });
  await hooks().installCallback(id, generateNonce());
  return id;
}

/** A reconnect link for the account, as `GatekeeperUser.reconnect` returns it. */
async function reconnectLink(id: string): Promise<string> {
  return (unwrap(await hooks().user(id, "reconnect")) as { url: string }).url;
}

/** Opens a connect link and returns the form's nonce, as the page's hidden field carries it. */
async function openForm(url: string): Promise<{ response: Response; nonce: string | undefined }> {
  const response = await SELF.fetch(url);
  return { response, nonce: nonceOf(await response.clone().text()) };
}

const nonceOf = (html: string) => /<input type="hidden" name="nonce" value="([0-9a-f]+)">/.exec(html)?.[1];

/** Posts the form as the browser does from the gatekeeper's own page. */
async function submit(id: string, nonce: string, key: string, origin = ORIGIN) {
  const response = await SELF.fetch(`${BASE_URL}/${id}/key`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ nonce, key }),
  });
  return { status: response.status, html: await response.text() };
}

/** The ticket of the handoff page: a reconnect's stage id, under `TestCallback`. */
const ticketOf = (html: string) => /var ticket = "([^"]+)";/.exec(html)?.[1];

describe("the connect link", () => {
  it("shows the key form once, on a page whose form can be posted", async () => {
    fakeProvider({});
    const { url } = await connectLink();

    const { response, nonce } = await openForm(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(await response.text()).toContain('<input id="key" name="key" type="password"');

    // The link is spent: only the page it opened holds the form's nonce.
    const again = await openForm(url);
    expect(again.nonce).toBeUndefined();
    expect(await again.response.text()).toContain("link");
  });

  it("answers a link to no account, or with a wrong nonce, without a form", async () => {
    fakeProvider({});
    const { id, url } = await connectLink();
    expect((await openForm(`${BASE_URL}/${id}/${generateNonce()}`)).nonce).toBeUndefined();
    expect((await openForm(`${BASE_URL}/${"0".repeat(64)}/${generateNonce()}`)).nonce).toBeUndefined();
    // Neither spent the real link.
    expect((await openForm(url)).nonce).toBeDefined();
  });
});

describe("a submitted key", () => {
  it("is refused from another site, without spending the form", async () => {
    const requests = fakeProvider({ "key-alice": ALICE });
    const id = await connected(ALICE, "old-key");
    const { nonce } = await openForm(await reconnectLink(id));

    expect((await submit(id, nonce!, "key-alice", "https://evil.example")).status).toBe(403);
    expect((await submit(id, nonce!, "key-alice", "null")).status).toBe(403);
    expect(requests).toEqual([]);
    expect((await submit(id, nonce!, "key-alice")).status).toBe(200);
  });

  it("is refused with a wrong form nonce, without asking the provider", async () => {
    const requests = fakeProvider({ "key-alice": ALICE });
    const id = await connected(ALICE, "old-key");
    await openForm(await reconnectLink(id));

    const answer = await submit(id, generateNonce(), "key-alice");
    expect(nonceOf(answer.html)).toBeUndefined();
    expect(ticketOf(answer.html)).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it("gets the form again when the provider refuses it, and the next one is taken", async () => {
    fakeProvider({ "key-alice": ALICE });
    const id = await connected(ALICE, "old-key");
    const { nonce: first } = await openForm(await reconnectLink(id));

    const refused = await submit(id, first!, "typo");
    expect(refused.status).toBe(422);
    expect(refused.html).toContain(
      '<p class="err" id="form.error" role="alert">Acme refused that key. Check it and paste it again.</p>');
    // A refused key spends nothing: the form comes back with the nonce it was posted with.
    expect(nonceOf(refused.html)).toBe(first);

    const accepted = await submit(id, first!, "key-alice");
    expect(accepted.status).toBe(200);
    const stageId = ticketOf(accepted.html);
    expect(stageId).toBeDefined();

    // Staged, not live, until the Workshop confirms the browser that finished the flow.
    expect((await account(id).getCredentials()).creds.accessToken).toBe("old-key");
    unwrap(await hooks().user(id, "commitReconnect", stageId!));
    expect((await account(id).getCredentials()).creds.accessToken).toBe("key-alice");
  });

  it("gets the form again when it is empty or too long", async () => {
    const requests = fakeProvider({});
    const id = await connected(ALICE, "old-key");
    const { nonce } = await openForm(await reconnectLink(id));

    const empty = await submit(id, nonce!, "   ");
    expect(empty.status).toBe(422);
    const long = await submit(id, nonceOf(empty.html)!, "k".repeat(10_000));
    expect(long.status).toBe(422);
    expect(nonceOf(long.html)).toBeDefined();
    expect(requests).toEqual([]);
  });

  it("can be retried on a first connect too", async () => {
    fakeProvider({});
    const { id, url } = await connectLink();
    const { nonce } = await openForm(url);

    const refused = await submit(id, nonce!, "typo");
    expect(refused.status).toBe(422);
    expect(nonceOf(refused.html)).toBeDefined();
  });

  it("finishes once when one form is submitted twice at the same time", async () => {
    fakeProvider({ "key-alice": ALICE });
    const id = await connected(ALICE, "old-key");
    const { nonce } = await openForm(await reconnectLink(id));

    const answers = await Promise.all([submit(id, nonce!, "key-alice"), submit(id, nonce!, "key-alice")]);
    const tickets = answers.map(answer => ticketOf(answer.html)).filter(ticket => ticket !== undefined);
    expect(tickets).toHaveLength(1);
    // The one that lost is told its link is dead, and is not offered the form again.
    expect(answers.filter(answer => nonceOf(answer.html) !== undefined)).toEqual([]);

    unwrap(await hooks().user(id, "commitReconnect", tickets[0]));
    expect((await account(id).getCredentials()).creds.accessToken).toBe("key-alice");
  });

  it("is not offered the form again when a newer link was made while the provider was asked", async () => {
    const id = await connected(ALICE, "old-key");
    const { nonce } = await openForm(await reconnectLink(id));
    let newer: string | undefined;
    fakeProvider({ "key-alice": ALICE }, async () => { newer = await reconnectLink(id); });

    // Neither a refused key nor a good one gets anything out of the form the newer link replaced.
    const refused = await submit(id, nonce!, "typo");
    expect(nonceOf(refused.html)).toBeUndefined();
    const late = await submit(id, nonce!, "key-alice");
    expect(ticketOf(late.html)).toBeUndefined();
    expect(nonceOf(late.html)).toBeUndefined();
    expect((await openForm(newer!)).nonce).toBeDefined();
  });

  it("stops being retried when a newer link has been made", async () => {
    fakeProvider({});
    const id = await connected(ALICE, "old-key");
    const { nonce } = await openForm(await reconnectLink(id));
    const refused = await submit(id, nonce!, "typo");

    const newer = await reconnectLink(id);
    expect(nonceOf((await submit(id, nonceOf(refused.html)!, "typo")).html)).toBeUndefined();
    expect((await openForm(newer)).nonce).toBeDefined();
  });

  it("is refused for good when it belongs to another user", async () => {
    fakeProvider({ "key-bob": BOB });
    const id = await connected(ALICE, "old-key");
    const { nonce } = await openForm(await reconnectLink(id));

    const answer = await submit(id, nonce!, "key-bob");
    expect(answer.status).toBe(409);
    expect(answer.html).toContain("This connection is for Alice, but that key belongs to Bob.");
    expect(nonceOf(answer.html)).toBeUndefined();
    expect((await account(id).getCredentials()).creds.accessToken).toBe("old-key");
  });
});

// The Workshop builds a `URLPattern` from each declared pattern, which throws for one its
// regular expression mode refuses.
it("declares a URL pattern that matches the URLs it makes and parses", () => {
  const url = itemUrl("it-em_1");
  expect(parseResourceUrl(url)).toEqual({ itemId: "it-em_1" });
  expect(ALL_RESOURCES.map(({ urlPattern }) => new URLPattern(urlPattern).test(url))).toEqual([true]);
});

it("refuses a user the provider gave no ID, which is what a connection is pinned to", () => {
  expect(() => identityOf({ id: "", name: "Alice" })).toThrow("named no user ID");
  expect(() => identityOf({ name: "Alice" } as Parameters<typeof identityOf>[0])).toThrow("named no user ID");
});
