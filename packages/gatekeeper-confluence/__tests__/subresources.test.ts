// Observer verification by subresources: what each binding's reads report, what its
// verifyObserverAccess() accepts, and how an observer's UserAccount answers and reuses access checks.
// The Durable Objects run over in-memory storage and a fake Atlassian, reached through `fetch`.

import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfluenceContentGatekeeperImpl,
  ConfluenceSiteGatekeeperImpl,
  ConfluenceSpaceGatekeeperImpl,
  UserAccount,
} from "../src/confluence";

const CLOUD = "cloud-1";
const API = `https://api.atlassian.com/ex/confluence/${CLOUD}/wiki/api/v2`;
const RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";

type Route = (url: string, init?: RequestInit) => Response | undefined;

let routes: Route[];
let requests: string[];

beforeEach(() => {
  routes = [];
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    for (const route of routes) {
      const response = route(url, init);
      if (response) return response;
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Answers `url` exactly with `body`, or with a bare status when `body` is a number. */
function answer(url: string, body: unknown | number): void {
  routes.unshift(requested => requested === url
    ? typeof body === "number" ? new Response("refused", { status: body }) : Response.json(body)
    : undefined);
}

function makeStorage() {
  const map = new Map<string, unknown>();
  const kv = {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, value),
    delete: (key: string) => map.delete(key),
    list: <T>({ prefix }: { prefix: string }) =>
      [...map.entries()].filter(([key]) => key.startsWith(prefix)) as [string, T][],
  };
  return {
    map,
    storage: { kv, deleteAll: () => map.clear(), deleteAlarm: () => {}, setAlarm: () => {} },
  };
}

// ---------------------------------------------------------------------------------------------
// Reads

type Observation = { title: string; subresources?: string[]; excludeObservers?: string[] };

function makeQueue() {
  const observations: Observation[] = [];
  const queue = {
    observations,
    async authorizeObservation(observation: Observation) { observations.push(observation); },
    async submitAction() {},
    dup: () => queue,
    [Symbol.dispose]() {},
  };
  return queue;
}

function gatekeeper<T>(
  Class: new (ctx: never, env: never) => T, props: Record<string, string> = {},
  storage = makeStorage().storage,
): T {
  const owner = {
    getIdentity: async () => null,
    getSites: async () => [],
    getAccessToken: async () => "owner-token",
    refreshCredentials: async () => "owner-token",
  };
  const ctx = {
    props: { userObjectId: "owner", cloudId: CLOUD, webBase: "https://acme.atlassian.net/wiki", ...props },
    storage,
    exports: { UserAccount: { idFromString: (id: string) => id, get: () => owner } },
  };
  return new Class(ctx as never, {} as never);
}

describe("subresources reported by reads", () => {
  it("reports the site on every site-binding read, with the spaces each page reveals", async () => {
    answer(`${API}/spaces?limit=25`,
      { results: [{ id: "10", key: "ENG", name: "Eng" }, { id: "11", key: "OPS", name: "Ops" }],
        _links: { next: "/wiki/api/v2/spaces?cursor=page-2&limit=25" } });
    answer(`${API}/spaces?cursor=page-2&limit=25`, { results: [] });
    const queue = makeQueue();
    const session = await gatekeeper(ConfluenceSiteGatekeeperImpl).startSession(queue as never);

    await session.getMetadata();
    const spaces = await session.listSpaces();
    await spaces.next();
    await spaces.next();

    expect(queue.observations.map(({ subresources }) => subresources)).toEqual([
      ["site/cloud-1"],
      ["site/cloud-1", "site/cloud-1/space/10", "site/cloud-1/space/11"],
      ["site/cloud-1"],
    ]);
    expect(queue.observations.every(observation => observation.excludeObservers === undefined))
      .toBe(true);
  });

  it("reports a space opened through a site binding on every read of it, with the site", async () => {
    answer(`${API}/spaces?keys=ENG&limit=1&include-icon=true`,
      { results: [{ id: "10", key: "ENG", name: "Eng", description: { plain: { value: "Secret" } } }] });
    answer(`${API}/spaces/10/pages?depth=root&limit=25`, { results: [] });
    answer(`${API}/pages/300?body-format=storage`,
      { id: "300", title: "Page", _links: { webui: "/spaces/ENG/pages/300" } });
    const queue = makeQueue();
    const site = await gatekeeper(ConfluenceSiteGatekeeperImpl).startSession(queue as never);

    const space = await site.getSpace("ENG");
    await space.getMetadata();
    await (await space.listPages()).next();
    const content = await space.getContent("300");
    await content.getMetadata();

    // Site access doesn't imply access to the space, so each read reports it, an empty page too.
    const opened = ["site/cloud-1", "site/cloud-1/space/10"];
    expect(queue.observations.map(({ subresources }) => subresources)).toEqual([
      opened, opened, opened, opened, [...opened, "site/cloud-1/content/300"],
    ]);
  });

  it("reports the bound space with the content each page reveals, but no staged content", async () => {
    answer(`${API}/spaces?keys=ENG&limit=1&include-icon=true`,
      { results: [{ id: "10", key: "ENG", name: "Eng" }] });
    answer(`${API}/spaces/10/pages?depth=root&limit=25`,
      { results: [{ id: "100", title: "Home" }, { id: "101", title: "Runbook" }] });
    const queue = makeQueue();
    const session = await gatekeeper(ConfluenceSpaceGatekeeperImpl, { spaceKey: "ENG" })
      .startSession(queue as never);

    await (await session.listPages()).next();
    const draft = await session.createPage({ title: "Draft" });
    await draft.getMetadata();

    expect(queue.observations.map(({ subresources }) => subresources)).toEqual([
      ["site/cloud-1/space/ENG", "site/cloud-1/content/100", "site/cloud-1/content/101"],
      ["site/cloud-1/space/ENG"],
    ]);
  });

  it("reports the bound content with its child pages, and alone on an empty page", async () => {
    answer(`${API}/pages/200?body-format=storage`,
      { id: "200", title: "Parent", _links: { webui: "/spaces/ENG/pages/200" } });
    answer(`${API}/pages/200/children?limit=25`, { results: [{ id: "201", title: "Child" }] });
    answer(`${API}/pages/200/footer-comments?body-format=storage&limit=25`, { results: [] });
    const queue = makeQueue();
    const session = await gatekeeper(ConfluenceContentGatekeeperImpl, { contentId: "200" })
      .startSession(queue as never);

    await (await session.listChildPages()).next();
    await (await session.listComments()).next();

    expect(queue.observations.map(({ subresources }) => subresources)).toEqual([
      ["site/cloud-1/content/200", "site/cloud-1/content/201"],
      ["site/cloud-1/content/200"],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// verifyObserverAccess

function observer(id: string, allowed: (subresource: string) => boolean = () => true) {
  const checkSubresourceAccess = vi.fn(async (subresources: string[]) => subresources.map(allowed));
  const verifier = { checkSubresourceAccess, dup: () => verifier };
  return { id, verifier: verifier as never, checkSubresourceAccess };
}

describe("verifyObserverAccess", () => {
  it("allows the observers whose accounts can read every resource a site binding reports", async () => {
    const binding = gatekeeper(ConfluenceSiteGatekeeperImpl);
    const allowed = observer("allowed");
    const denied = observer("denied", subresource => !subresource.endsWith("/content/5"));
    const subresources = ["site/cloud-1", "site/cloud-1/space/10", "site/cloud-1/content/5"];

    expect(await binding.verifyObserverAccess([allowed, denied], subresources))
      .toEqual({ allowedObserverIds: ["allowed"] });
    expect(allowed.checkSubresourceAccess).toHaveBeenCalledWith(subresources);
  });

  it.each([
    ["another site", ConfluenceSiteGatekeeperImpl, {}, "site/cloud-2/content/5"],
    ["an unknown kind", ConfluenceSiteGatekeeperImpl, {}, "site/cloud-1/attachment/5"],
    ["a non-Confluence ID", ConfluenceSiteGatekeeperImpl, {}, "repo/5"],
    ["another space", ConfluenceSpaceGatekeeperImpl, { spaceKey: "ENG" }, "site/cloud-1/space/OPS"],
    ["the site, on a space binding", ConfluenceSpaceGatekeeperImpl, { spaceKey: "ENG" }, "site/cloud-1"],
    ["a space, on a content binding", ConfluenceContentGatekeeperImpl, { contentId: "200" },
      "site/cloud-1/space/ENG"],
  ] as const)("refuses %s without asking any observer", async (_name, Class, props, foreign) => {
    const binding = gatekeeper(Class as new (ctx: never, env: never) => ConfluenceSiteGatekeeperImpl, props);
    const candidate = observer("candidate");

    await expect(binding.verifyObserverAccess([candidate], ["site/cloud-1/content/5", foreign]))
      .rejects.toThrow();
    expect(candidate.checkSubresourceAccess).not.toHaveBeenCalled();
  });

  it("accepts a space binding's own space and its content", async () => {
    const binding = gatekeeper(ConfluenceSpaceGatekeeperImpl, { spaceKey: "ENG" });

    expect(await binding.verifyObserverAccess([observer("candidate")],
      ["site/cloud-1/space/ENG", "site/cloud-1/content/100"]))
      .toEqual({ allowedObserverIds: ["candidate"] });
  });
});

// ---------------------------------------------------------------------------------------------
// getHistoricalSubresources

describe("getHistoricalSubresources", () => {
  it.each([
    ["site", ConfluenceSiteGatekeeperImpl, {}, ["observed:space:10", "observed:content:5"],
      ["site/cloud-1", "site/cloud-1/space/10", "site/cloud-1/content/5"]],
    ["space", ConfluenceSpaceGatekeeperImpl, { spaceKey: "ENG" }, ["observed:content:100"],
      ["site/cloud-1/space/ENG", "site/cloud-1/content/100"]],
    ["content", ConfluenceContentGatekeeperImpl, { contentId: "200" },
      ["observed:content:200", "observed:content:201"],
      ["site/cloud-1/content/200", "site/cloud-1/content/201"]],
  ] as const)("exports a %s binding's baseline and recorded sets, which it verifies", async (
    _name, Class, props, recorded, expected,
  ) => {
    const { map, storage } = makeStorage();
    recorded.forEach((key, index) => storage.kv.put(key, index === 0 ? "observed" : "pending"));
    storage.kv.put("observer:legacy", {});
    const before = [...map.entries()];
    const binding = gatekeeper(
      Class as new (ctx: never, env: never) => ConfluenceSiteGatekeeperImpl, props, storage);

    const history = await binding.getHistoricalSubresources();
    expect(history).toEqual(expected);
    expect(await binding.getHistoricalSubresources()).toEqual(expected);
    expect([...map.entries()]).toEqual(before);

    const candidate = observer("candidate", subresource => !subresource.endsWith(expected.at(-1)!));
    expect(await binding.verifyObserverAccess([observer("allowed"), candidate], history))
      .toEqual({ allowedObserverIds: ["allowed"] });
  });

  it("exports the baseline the legacy admission checked when nothing was recorded", async () => {
    expect(await gatekeeper(ConfluenceSiteGatekeeperImpl).getHistoricalSubresources())
      .toEqual(["site/cloud-1"]);
  });
});

// ---------------------------------------------------------------------------------------------
// UserAccount.checkSubresourceAccess

const RESOURCE = { name: "Acme", url: "https://acme.atlassian.net", scopes: ["read:page:confluence"] };

function account() {
  const { map, storage } = makeStorage();
  storage.kv.put("grant", {
    accessToken: "token-1", refreshToken: "refresh-1", expiresAt: Date.now() + 24 * 3600_000,
  });
  const ctx = { storage, id: { toString: () => "account" }, exports: {} };
  const env = { CLIENT_ID: "client", CLIENT_SECRET: "secret" };
  return { map, storage, account: new UserAccount(ctx as never, env as never) };
}

/** Answers token refreshes with a new grant. */
function refreshes(): void {
  routes.unshift((url, init) => url === TOKEN_URL && init?.method === "POST"
    ? Response.json({ access_token: "token-2", refresh_token: "refresh-2", expires_in: 3600 })
    : undefined);
}

const count = (url: string) => requests.filter(requested => requested === url).length;
const PAGE_1 = `${API}/pages/1`;
const SPACE_ENG = `${API}/spaces?keys=ENG&limit=1&include-icon=true`;

describe("UserAccount.checkSubresourceAccess", () => {
  it("reuses an allowance for 15 minutes and a denial for 15 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    const { account: observer } = account();
    answer(PAGE_1, { id: "1", title: "Page" });
    answer(SPACE_ENG, { results: [] });
    const ids = ["site/cloud-1/content/1", "site/cloud-1/space/ENG"];

    expect(await observer.checkSubresourceAccess(ids)).toEqual([true, false]);
    vi.setSystemTime(new Date("2026-11-04T12:00:10Z"));
    await observer.checkSubresourceAccess(ids);
    expect([count(PAGE_1), count(SPACE_ENG)]).toEqual([1, 1]);

    vi.setSystemTime(new Date("2026-11-04T12:00:16Z"));
    await observer.checkSubresourceAccess(ids);
    expect([count(PAGE_1), count(SPACE_ENG)]).toEqual([1, 2]);

    vi.setSystemTime(new Date("2026-11-04T12:15:01Z"));
    await observer.checkSubresourceAccess(ids);
    expect(count(PAGE_1)).toBe(2);
  });

  it("answers every site from one live listing, not the sites saved at connect", async () => {
    const { storage, account: observer } = account();
    storage.kv.put("sites", [{ ...RESOURCE, id: "cloud-2" }]);
    answer(RESOURCES_URL, [{ ...RESOURCE, id: CLOUD }]);

    expect(await observer.checkSubresourceAccess(["site/cloud-1", "site/cloud-2", "site/cloud-1"]))
      .toEqual([true, false, true]);
    expect(count(RESOURCES_URL)).toBe(1);
  });

  it("keeps answers across a token refresh but asks again after a reconnect", async () => {
    const { storage, account: observer } = account();
    answer(PAGE_1, { id: "1", title: "Page" });
    refreshes();
    expect(await observer.checkSubresourceAccess(["site/cloud-1/content/1"])).toEqual([true]);

    await observer.refreshCredentials();
    expect(await observer.checkSubresourceAccess(["site/cloud-1/content/1"])).toEqual([true]);
    expect(count(PAGE_1)).toBe(1);

    // The reconnect may sign in as another Atlassian account, which can't see the page.
    answer(RESOURCES_URL, [{ ...RESOURCE, id: CLOUD }]);
    answer("https://api.atlassian.com/me", { account_id: "other" });
    answer(PAGE_1, 404);
    answer(`${API}/blogposts/1`, 404);
    const stageId = stageCredentials(storage.kv,
      { accessToken: "token-3", refreshToken: "refresh-3", expiresAt: Date.now() + 3600_000 }, Date.now());
    await observer.commitReconnect(stageId);

    expect(await observer.checkSubresourceAccess(["site/cloud-1/content/1"])).toEqual([false]);
    expect(count(PAGE_1)).toBe(2);
  });

  it("keeps a reconnected grant when a refresh of the replaced one finishes after it", async () => {
    const { storage, account: observer } = account();
    const started = Promise.withResolvers<void>();
    const refreshed = Promise.withResolvers<Response>();
    routes.unshift((url, init) => {
      if (url !== TOKEN_URL || init?.method !== "POST") return undefined;
      started.resolve();
      return refreshed.promise as unknown as Response;
    });
    answer(RESOURCES_URL, [{ ...RESOURCE, id: CLOUD }]);
    answer("https://api.atlassian.com/me", { account_id: "other" });

    const refreshing = observer.refreshCredentials();
    await started.promise;
    await observer.commitReconnect(stageCredentials(storage.kv,
      { accessToken: "token-3", refreshToken: "refresh-3", expiresAt: Date.now() + 3600_000 }, Date.now()));
    refreshed.resolve(Response.json({ access_token: "token-2", refresh_token: "refresh-2", expires_in: 3600 }));

    await expect(refreshing).resolves.toBe("token-3");
    expect(storage.kv.get<{ accessToken: string }>("grant")?.accessToken).toBe("token-3");
  });

  it("fails a check a reconnect lands in rather than combining two accounts' answers", async () => {
    const { storage, account: observer } = account();
    answer(PAGE_1, { id: "1", title: "Page" });
    expect(await observer.checkSubresourceAccess(["site/cloud-1/content/1"])).toEqual([true]);

    // The space lookup is still in flight, under the first account, when the reconnect lands.
    const started = Promise.withResolvers<void>();
    const space = Promise.withResolvers<Response>();
    routes.unshift(url => {
      if (url !== SPACE_ENG) return undefined;
      started.resolve();
      return space.promise as unknown as Response;
    });
    answer(RESOURCES_URL, [{ ...RESOURCE, id: CLOUD }]);
    answer("https://api.atlassian.com/me", { account_id: "other" });
    const checking = observer.checkSubresourceAccess(["site/cloud-1/content/1", "site/cloud-1/space/ENG"]);
    await started.promise;
    await observer.commitReconnect(stageCredentials(storage.kv,
      { accessToken: "token-3", refreshToken: "refresh-3", expiresAt: Date.now() + 3600_000 }, Date.now()));
    space.resolve(Response.json({ results: [{ id: "10", key: "ENG", name: "Eng" }] }));

    await expect(checking).rejects.toThrow(/changed while their access was being checked/);
  });

  it("retrieves a few resources at once, answering in order and caching each", async () => {
    const { account: observer } = account();
    // Each retrieval waits until the test answers it, so the test sees how many run at once.
    const held: (() => void)[] = [];
    routes.unshift(url => {
      const match = /^\/(?:pages|blogposts)\/(\d+)$/.exec(url.slice(API.length));
      if (!match) return undefined;
      return new Promise<Response>(resolve => held.push(() => resolve(match[1] === "3"
        ? new Response("missing", { status: 404 })
        : Response.json({ id: match[1], title: "Page" })))) as unknown as Response;
    });
    const ids = [1, 2, 3, 4, 5, 6, 7, 8].map(id => `site/cloud-1/content/${id}`);
    const expected = [true, true, false, true, true, true, true, true];

    // An object, so the loop sees the flag the promise sets; a 404 falls back to a blog post
    // retrieval, so the number of requests isn't the number of IDs.
    const state = { settled: false };
    const checking = observer.checkSubresourceAccess(ids).finally(() => { state.settled = true; });
    await vi.waitFor(() => expect(held).toHaveLength(4));
    while (!state.settled) {
      expect(held.length).toBeLessThanOrEqual(4);
      held.shift()?.();
      await vi.waitFor(() => expect(state.settled || held.length > 0).toBe(true));
    }
    expect(await checking).toEqual(expected);

    const asked = requests.length;
    expect(await observer.checkSubresourceAccess(ids)).toEqual(expected);
    expect(requests.length).toBe(asked);
  });

  it("throws, and reuses nothing, when Atlassian fails to answer", async () => {
    const { account: observer } = account();
    answer(PAGE_1, 500);
    await expect(observer.checkSubresourceAccess(["site/cloud-1/content/1"])).rejects.toThrow();

    answer(PAGE_1, { id: "1", title: "Page" });
    expect(await observer.checkSubresourceAccess(["site/cloud-1/content/1"])).toEqual([true]);
    expect(count(PAGE_1)).toBe(2);
  });

  it("throws, rather than denying, when the observer's credentials can't be refreshed", async () => {
    const { map, account: observer } = account();
    answer(PAGE_1, 401);
    answer(RESOURCES_URL, 401);
    answer(TOKEN_URL, 400);

    await expect(observer.checkSubresourceAccess(["site/cloud-1/content/1"])).rejects.toThrow();
    expect([...map.keys()].some(key => key.startsWith("cache:@access:entry:"))).toBe(false);
  });

  it("denies a resource on a site the observer's live listing leaves out", async () => {
    const { account: observer } = account();
    answer(PAGE_1, 401);
    answer(RESOURCES_URL, [{ ...RESOURCE, id: "cloud-2" }]);
    refreshes();

    expect(await observer.checkSubresourceAccess(["site/cloud-1/content/1"])).toEqual([false]);
  });

  it("throws without credentials, and for an ID it can't check before asking anything", async () => {
    const { storage, account: observer } = account();
    await expect(observer.checkSubresourceAccess(["site/cloud-1/content/1", "repo/5"])).rejects.toThrow();
    expect(requests).toEqual([]);

    storage.kv.delete("grant");
    answer(PAGE_1, 403);
    await expect(observer.checkSubresourceAccess(["site/cloud-1/content/1"])).rejects.toThrow();
    expect(requests).toEqual([]);
  });
});
