import { describe, expect, it } from "vitest";
import { ConfluenceApiError, type AccessibleResource } from "../src/confluence-api";
import {
  ConfluenceAccessChecker,
  ConfluenceObserverTracker,
  type ConfluenceVerifierApi,
} from "../src/confluence-observers";

type TrackerKv = ConstructorParameters<typeof ConfluenceObserverTracker>[0];

function makeKv(): TrackerKv & { get<T>(key: string): T | undefined } {
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

// Reads no longer record sets; these markers stand for history recorded before they reported
// subresources, or by a read still running that code.
describe("ConfluenceObserverTracker", () => {
  it("checks all past observations before storing an observer", async () => {
    const kv = makeKv();
    kv.put("observed:space:10", "observed");
    kv.put("observed:content:20", "observed");
    const tracker = new ConfluenceObserverTracker(kv, "cloud");
    const denied = verifier({ spaces: [], content: ["20"] });

    await expect(tracker.addObserver("observer-1", denied.api)).rejects.toThrow(/does not have access/);
    expect(denied.calls.spaces).toEqual(["10"]);
    expect(denied.calls.content).toEqual(["20"]);
    expect(kv.get("observer:observer-1")).toBeUndefined();
  });

  it("stores an admitted observer's verifier and removes it idempotently", async () => {
    const kv = makeKv();
    kv.put("observed:content:first", "observed");
    const tracker = new ConfluenceObserverTracker(kv, "cloud");
    const allowed = verifier({ content: ["first"] });

    await tracker.addObserver("allowed", allowed.api);
    expect(kv.get("observer:allowed")).toBe(allowed.api);

    tracker.removeObserver("allowed");
    tracker.removeObserver("allowed");
    expect(kv.get("observer:allowed")).toBeUndefined();
  });

  it("checks sets an old read left pending, and legacy boolean markers", async () => {
    const kv = makeKv();
    kv.put("observed:content:pending", "pending");
    kv.put("observed:content:legacy", true);
    const tracker = new ConfluenceObserverTracker(kv, "cloud");
    const denied = verifier({ content: ["pending"] });

    await expect(tracker.addObserver("candidate", denied.api)).rejects.toThrow(/does not have access/);
    expect(denied.calls.content).toEqual(["pending", "legacy"]);
  });

  it("dispatches typed space and content sets to their matching verifier methods", async () => {
    const kv = makeKv();
    kv.put("observed:space:10", "observed");
    kv.put("observed:content:20", "observed");
    const tracker = new ConfluenceObserverTracker(kv, "cloud");
    const access = verifier();
    await tracker.addObserver("observer", access.api);

    expect(access.calls.spaces).toEqual(["10"]);
    expect(access.calls.content).toEqual(["20"]);
  });

  it("rechecks sets recorded while observer admission is awaiting", async () => {
    const kv = makeKv();
    kv.put("observed:content:old", "observed");
    const tracker = new ConfluenceObserverTracker(kv, "cloud");
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
    // A read still running the legacy code marks a set while the check above is in flight.
    kv.put("observed:content:new", "pending");
    release();
    await expect(admission).rejects.toThrow(/does not have access/);
    expect(calls).toEqual(["old", "new"]);
    expect(kv.get("observer:candidate")).toBeUndefined();
  });
});
