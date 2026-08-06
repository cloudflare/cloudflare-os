import { describe, expect, it } from "vite-plus/test";
import { ConfluenceApiError, type AccessibleResource } from "../src/confluence-api";
import {
  ConfluenceAccessChecker,
  ConfluenceObserverTracker,
  contentSets,
  type ConfluenceVerifierApi,
} from "../src/confluence-observers";

type TrackerKv = ConstructorParameters<typeof ConfluenceObserverTracker>[0];

function makeKv(): TrackerKv {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, value),
    delete: (key: string) => void map.delete(key),
    list: <T>({ prefix }: { prefix: string }) =>
      [...map.entries()].filter(([key]) => key.startsWith(prefix)) as [string, T][],
  };
}

function verifier(options?: {
  sites?: string[];
  spaces?: string[];
  content?: string[];
}) {
  const calls = { sites: [] as string[], spaces: [] as string[], content: [] as string[] };
  const api = {
    async hasSiteAccess(cloudId: string) {
      calls.sites.push(cloudId);
      return options?.sites?.includes(cloudId) ?? true;
    },
    async hasSpaceAccess(_cloudId: string, id: string) {
      calls.spaces.push(id);
      return options?.spaces?.includes(id) ?? true;
    },
    async hasContentAccess(_cloudId: string, id: string) {
      calls.content.push(id);
      return options?.content?.includes(id) ?? true;
    },
  } as unknown as Fetcher<ConfluenceVerifierApi>;
  return { api, calls };
}

async function observe(
  tracker: ConfluenceObserverTracker,
  sets: Parameters<ConfluenceObserverTracker["prepareObservation"]>[0],
) {
  const check = await tracker.prepareObservation(sets);
  check.commit();
  return check.excludeObservers;
}

describe("ConfluenceAccessChecker", () => {
  it("checks sites live and routes numeric space IDs, keys, and content IDs", async () => {
    const calls: string[] = [];
    const resource: AccessibleResource = {
      id: "cloud-1", name: "Acme", url: "https://acme.atlassian.net", scopes: ["read:space:confluence"],
    };
    const checker = new ConfluenceAccessChecker(
      async () => "observer-token",
      cloudId => ({
        getSpaceById: async id => void calls.push(`${cloudId}:space-id:${id}`),
        getSpaceByKey: async key => void calls.push(`${cloudId}:space-key:${key}`),
        getContentById: async id => { calls.push(`${cloudId}:content:${id}`); return {} as never; },
      }),
      async token => {
        calls.push(`resources:${token}`);
        return [resource];
      },
    );

    expect(await checker.hasSiteAccess("cloud-1")).toBe(true);
    expect(await checker.hasSiteAccess("cloud-2")).toBe(false);
    expect(await checker.hasSpaceAccess("cloud-1", "123")).toBe(true);
    expect(await checker.hasSpaceAccess("cloud-1", "ENG")).toBe(true);
    expect(await checker.hasContentAccess("cloud-1", "456")).toBe(true);
    expect(calls).toEqual([
      "resources:observer-token", "resources:observer-token", "cloud-1:space-id:123",
      "cloud-1:space-key:ENG", "cloud-1:content:456",
    ]);
  });

  it.each([401, 403, 404])("treats HTTP %s as no access", async status => {
    const checker = new ConfluenceAccessChecker(
      async () => "token",
      () => ({
        getSpaceById: async () => { throw new ConfluenceApiError(status, "denied"); },
        getSpaceByKey: async () => { throw new ConfluenceApiError(status, "denied"); },
        getContentById: async () => { throw new ConfluenceApiError(status, "denied"); },
      }),
      async () => { throw new ConfluenceApiError(status, "denied"); },
    );

    expect(await checker.hasSiteAccess("cloud")).toBe(false);
    expect(await checker.hasSpaceAccess("cloud", "ENG")).toBe(false);
    expect(await checker.hasContentAccess("cloud", "123")).toBe(false);
  });

  it("rethrows unexpected failures", async () => {
    const failure = new ConfluenceApiError(500, "failed");
    const checker = new ConfluenceAccessChecker(
      async () => "token",
      () => ({
        getSpaceById: async () => { throw failure; },
        getSpaceByKey: async () => { throw failure; },
        getContentById: async () => { throw failure; },
      }),
    );
    await expect(checker.hasContentAccess("cloud", "123")).rejects.toBe(failure);
  });
});

describe("ConfluenceObserverTracker", () => {
  it("checks all past observations before storing an observer", async () => {
    const tracker = new ConfluenceObserverTracker(makeKv(), "cloud");
    await observe(tracker, ["space:10", "content:20"]);
    const denied = verifier({ spaces: [], content: ["20"] });

    await expect(tracker.addObserver("observer-1", denied.api)).rejects.toThrow(/does not have access/);
    expect(denied.calls.spaces).toEqual(["10"]);
    expect(denied.calls.content).toEqual(["20"]);

    await observe(tracker, ["content:21"]);
    expect(denied.calls.content).toEqual(["20"]);
  });

  it("excludes stored observers from newly observed sets and removes them idempotently", async () => {
    const tracker = new ConfluenceObserverTracker(makeKv(), "cloud");
    const allowed = verifier({ content: ["first", "second", "third"] });
    const limited = verifier({ content: ["first"] });
    await tracker.addObserver("allowed", allowed.api);
    await tracker.addObserver("limited", limited.api);

    expect(await observe(tracker, ["content:first"])).toBeUndefined();
    expect(await observe(tracker, ["content:second"])).toEqual(["limited"]);
    expect(await observe(tracker, ["content:second"])).toBeUndefined();

    tracker.removeObserver("limited");
    tracker.removeObserver("limited");
    expect(await observe(tracker, ["content:third"])).toBeUndefined();
    expect(limited.calls.content).toEqual(["first", "second"]);
  });

  it("attributes each pagination batch independently", async () => {
    const tracker = new ConfluenceObserverTracker(makeKv(), "cloud");
    const limited = verifier({ content: ["page-1"] });
    await tracker.addObserver("limited", limited.api);

    expect(await observe(tracker, contentSets(["page-1"]))).toBeUndefined();
    expect(await observe(tracker, contentSets(["page-2"]))).toEqual(["limited"]);
    expect(limited.calls.content).toEqual(["page-1", "page-2"]);
  });

  it("tracks a child listing's parent and real children but not provisional content", async () => {
    const tracker = new ConfluenceObserverTracker(makeKv(), "cloud");
    const access = verifier({ content: ["parent", "child"] });
    await tracker.addObserver("observer", access.api);

    const sets = contentSets(["parent", "child", "~1"]);
    expect(sets).toEqual(["content:parent", "content:child"]);
    expect(await observe(tracker, sets)).toBeUndefined();
    expect(access.calls.content).toEqual(["parent", "child"]);
  });

  it("dispatches typed space and content sets to their matching verifier methods", async () => {
    const tracker = new ConfluenceObserverTracker(makeKv(), "cloud");
    const access = verifier();
    await tracker.addObserver("observer", access.api);
    await observe(tracker, ["space:10", "content:20"]);

    expect(access.calls.spaces).toEqual(["10"]);
    expect(access.calls.content).toEqual(["20"]);
  });

  it("rechecks a blocked pending set until an observation commits it", async () => {
    const kv = makeKv();
    const tracker = new ConfluenceObserverTracker(kv, "cloud");
    const limited = verifier({ content: [] });
    await tracker.addObserver("limited", limited.api);

    const first = await tracker.prepareObservation(["content:secret"]);
    expect(first.excludeObservers).toEqual(["limited"]);
    expect(kv.get("observed:content:secret")).toBe("pending");

    const retry = await tracker.prepareObservation(["content:secret"]);
    expect(retry.excludeObservers).toEqual(["limited"]);
    expect(limited.calls.content).toEqual(["secret", "secret"]);

    tracker.removeObserver("limited");
    const allowedRetry = await tracker.prepareObservation(["content:secret"]);
    expect(allowedRetry.excludeObservers).toBeUndefined();
    allowedRetry.commit();
    expect(kv.get("observed:content:secret")).toBe("observed");
    expect((await tracker.prepareObservation(["content:secret"])).excludeObservers).toBeUndefined();
  });

  it("checks an observer admitted while a new set is pending", async () => {
    const kv = makeKv();
    const tracker = new ConfluenceObserverTracker(kv, "cloud");
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const current = {
      hasContentAccess: async () => { await waiting; return true; },
      hasSpaceAccess: async () => true,
    } as unknown as Fetcher<ConfluenceVerifierApi>;
    await tracker.addObserver("current", current);

    const preparing = tracker.prepareObservation(["content:new"]);
    expect(kv.get("observed:content:new")).toBe("pending");
    const denied = verifier({ content: [] });
    await expect(tracker.addObserver("new", denied.api)).rejects.toThrow(/does not have access/);
    release();
    (await preparing).commit();
    expect(denied.calls.content).toEqual(["new"]);
  });

  it("rechecks sets that become pending while observer admission is awaiting", async () => {
    const tracker = new ConfluenceObserverTracker(makeKv(), "cloud");
    await observe(tracker, ["content:old"]);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const candidate = {
      async hasContentAccess(_cloudId: string, contentId: string) {
        calls.push(contentId);
        if (contentId === "old") await waiting;
        return contentId === "old";
      },
      async hasSpaceAccess() { return true; },
    } as unknown as Fetcher<ConfluenceVerifierApi>;

    const admission = tracker.addObserver("candidate", candidate);
    await tracker.prepareObservation(["content:new"]);
    release();
    await expect(admission).rejects.toThrow(/does not have access/);
    expect(calls).toEqual(["old", "new"]);
  });

  it("handles concurrent and mixed observations without bypassing pending sets", async () => {
    const kv = makeKv();
    const tracker = new ConfluenceObserverTracker(kv, "cloud");
    const limited = verifier({ content: ["old"] });
    await tracker.addObserver("limited", limited.api);
    await observe(tracker, ["content:old"]);

    const first = tracker.prepareObservation(["content:pending"]);
    const concurrent = tracker.prepareObservation(["content:pending"]);
    expect((await first).excludeObservers).toEqual(["limited"]);
    expect((await concurrent).excludeObservers).toEqual(["limited"]);

    const mixed = await tracker.prepareObservation([
      "content:old", "content:pending", "content:new", "content:new",
    ]);
    expect(mixed.pendingSets).toEqual(["content:pending", "content:new"]);
    expect(mixed.excludeObservers).toEqual(["limited"]);
    mixed.commit();
    expect((await tracker.prepareObservation(["content:pending", "content:new"]))
      .excludeObservers).toBeUndefined();
  });

  it("treats legacy boolean markers as observed", async () => {
    const kv = makeKv();
    kv.put("observed:content:legacy", true);
    const tracker = new ConfluenceObserverTracker(kv, "cloud");
    const denied = verifier({ content: [] });

    await expect(tracker.addObserver("candidate", denied.api)).rejects.toThrow(/does not have access/);
    expect(denied.calls.content).toEqual(["legacy"]);
    expect((await tracker.prepareObservation(["content:legacy"])).pendingSets).toEqual([]);
  });
});
