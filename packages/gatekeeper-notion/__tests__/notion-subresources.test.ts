// What Notion reads report as subresources, which IDs verifyObserverAccess accepts, and how an
// account answers (and caches) whether it can read them.

import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import type { RpcStub } from "cloudflare:workers";
import type { ApprovalQueue, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NotionApiError } from "../src/notion-api";
import {
  ITEM_ACCESS_ALLOWED_TTL_MS,
  ITEM_ACCESS_DENIED_TTL_MS,
  MISSING_WORKSPACE_ID_MESSAGE,
  NotionObservationScope,
  assertBindingSubresources,
  checkNotionSubresourceAccess,
  credentialsId,
  itemSubresourceId,
  nameNewCredentials,
  parseNotionSubresource,
  workspaceSubresourceId,
} from "../src/notion-subresources";

const WORKSPACE = "7c1d6a52-0f3b-4e8a-9d4e-1b2c3d4e5f60";
const OTHER_WORKSPACE = "0d6e5c1a-0000-4000-8000-000000000000";
const PAGE = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const PAGE_NORMALIZED = "1a2b3c4d5e6f4a7b8c9d0e1f2a3b4c5d";
const CHILD = "aaaaaaaabbbbccccddddeeeeeeeeeeee";
const ROW = "ffffffff-1111-2222-3333-444444444444";

const workspaceId = workspaceSubresourceId(WORKSPACE);
const pageId = itemSubresourceId(WORKSPACE, PAGE);
const childId = itemSubresourceId(WORKSPACE, CHILD);

class FakeKv {
  entries = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    const value = this.entries.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }
  put<T>(key: string, value: T): void {
    this.entries.set(key, structuredClone(value));
  }
  delete(key: string): void {
    this.entries.delete(key);
  }
}

function recordingQueue() {
  const observations: ObservationDescription[] = [];
  const queue = {
    authorizeObservation: async (observation: ObservationDescription) => void observations.push(observation),
  } as unknown as RpcStub<ApprovalQueue>;
  return { queue, observations };
}

const read = { title: "Read", description: "Read something." };

describe("Notion subresource IDs", () => {
  it("names an item by its normalized id within its workspace", () => {
    expect(pageId).toBe(`workspace/${WORKSPACE}/item/${PAGE_NORMALIZED}`);
    expect(itemSubresourceId(WORKSPACE, PAGE_NORMALIZED.toUpperCase())).toBe(pageId);
    expect(parseNotionSubresource(pageId))
      .toEqual({ kind: "item", workspaceId: WORKSPACE, itemId: PAGE_NORMALIZED });
    expect(parseNotionSubresource(workspaceId)).toEqual({ kind: "workspace", workspaceId: WORKSPACE });
  });

  it("refuses to name a provisional page", () => {
    expect(() => itemSubresourceId(WORKSPACE, "~1")).toThrow();
  });

  it.each([
    `workspace/${WORKSPACE}/item/${PAGE}`,
    `workspace/${WORKSPACE}/item/${PAGE_NORMALIZED.toUpperCase()}`,
    `notion/workspace/${WORKSPACE}`,
    `workspace/${WORKSPACE}/page/${PAGE_NORMALIZED}`,
    `workspace/${WORKSPACE}/item/${PAGE_NORMALIZED}/item/${PAGE_NORMALIZED}`,
    `item/${PAGE_NORMALIZED}`,
    "repo/1",
  ])("refuses %s", id => {
    expect(() => parseNotionSubresource(id)).toThrow();
  });
});

describe("NotionObservationScope", () => {
  it("reports only the bound item on every read of an item binding", async () => {
    const scope = new NotionObservationScope({ kind: "item", itemId: PAGE }, async () => WORKSPACE);
    const { queue, observations } = recordingQueue();

    await scope.authorize(queue, [], read);
    await scope.authorize(queue, [PAGE, CHILD, ROW], read);
    await scope.authorize(queue, ["~2"], read);

    expect(observations.map(observation => observation.subresources))
      .toEqual([[pageId], [pageId], [pageId]]);
    expect(observations.every(observation => observation.excludeObservers === undefined)).toBe(true);
  });

  it("reports workspace membership plus each real item a workspace read reveals", async () => {
    const scope = new NotionObservationScope({ kind: "workspace" }, async () => WORKSPACE);

    expect(await scope.subresources([])).toEqual([workspaceId]);
    expect(await scope.subresources(["~1"])).toEqual([workspaceId]);
    expect(await scope.subresources([PAGE, PAGE_NORMALIZED, CHILD, "~3"]))
      .toEqual([workspaceId, pageId, childId]);
  });

  it("fails reads closed while the owner's workspace id is unknown, and asks again", async () => {
    let stored: string | undefined;
    const loads = vi.fn(async () => stored);
    const scope = new NotionObservationScope({ kind: "workspace" }, loads);
    const { queue, observations } = recordingQueue();

    await expect(scope.authorize(queue, [], read)).rejects.toThrow(MISSING_WORKSPACE_ID_MESSAGE);
    expect(observations).toEqual([]);

    stored = WORKSPACE;
    await scope.authorize(queue, [], read);
    await scope.authorize(queue, [], read);
    expect(observations.map(observation => observation.subresources)).toEqual([[workspaceId], [workspaceId]]);
    expect(loads).toHaveBeenCalledTimes(2);
  });
});

describe("assertBindingSubresources", () => {
  const item = { kind: "item", itemId: PAGE } as const;
  const workspace = { kind: "workspace" } as const;

  it("accepts what each binding reports", () => {
    expect(() => assertBindingSubresources(item, [pageId])).not.toThrow();
    expect(() => assertBindingSubresources(workspace, [workspaceId, pageId, childId])).not.toThrow();
  });

  it("refuses anything but the bound item on an item binding", () => {
    expect(() => assertBindingSubresources(item, [pageId, workspaceId])).toThrow();
    expect(() => assertBindingSubresources(item, [childId])).toThrow();
  });

  it("accepts IDs recorded under a workspace the owner's connection has since left", () => {
    expect(() => assertBindingSubresources(workspace,
      [workspaceSubresourceId(OTHER_WORKSPACE), itemSubresourceId(OTHER_WORKSPACE, CHILD)])).not.toThrow();
    expect(() => assertBindingSubresources(item, [itemSubresourceId(OTHER_WORKSPACE, PAGE)])).not.toThrow();
  });

  it("refuses unknown IDs", () => {
    expect(() => assertBindingSubresources(workspace, ["repo/1"])).toThrow();
  });
});

describe("checkNotionSubresourceAccess", () => {
  let kv: FakeKv;
  let access: KvTtlCache;
  let visible: Map<string, boolean | Error>;
  let detectKind: Mock<(id: string) => Promise<"page" | "database">>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    kv = new FakeKv();
    kv.put("accessToken", "observer-token");
    access = new KvTtlCache(kv, () => credentialsId(kv), { name: "access" });
    visible = new Map();
    detectKind = vi.fn(async (id: string) => {
      const answer = visible.get(id) ?? true;
      if (answer instanceof Error) throw answer;
      if (!answer) throw new NotionApiError(404, "Not found", "object_not_found");
      return "page" as const;
    });
  });
  afterEach(() => vi.useRealTimers());

  const check = (ids: string[], ownWorkspace: { id?: string } = { id: WORKSPACE }) =>
    checkNotionSubresourceAccess({ access, workspaceId: ownWorkspace.id, api: { detectKind } }, ids);

  it("compares workspace membership without asking Notion", async () => {
    expect(await check([workspaceId, workspaceSubresourceId(OTHER_WORKSPACE)])).toEqual([true, false]);
    expect(await check([workspaceId], {})).toEqual([false]);
    expect(detectKind).not.toHaveBeenCalled();
  });

  it("parses every ID before asking Notion anything", async () => {
    await expect(check([pageId, "repo/1"])).rejects.toThrow();
    expect(detectKind).not.toHaveBeenCalled();
  });

  it("reuses an allowed answer for 15 minutes and a denial for 15 seconds", async () => {
    visible.set(CHILD, false);
    expect(await check([pageId, childId])).toEqual([true, false]);
    expect(detectKind.mock.calls.map(([id]) => id)).toEqual([PAGE_NORMALIZED, CHILD]);

    vi.advanceTimersByTime(ITEM_ACCESS_DENIED_TTL_MS + 1);
    visible.set(CHILD, true);
    visible.set(PAGE_NORMALIZED, false);
    expect(await check([pageId, childId])).toEqual([true, true]);
    expect(detectKind).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(ITEM_ACCESS_ALLOWED_TTL_MS);
    expect(await check([pageId])).toEqual([false]);
    expect(detectKind).toHaveBeenCalledTimes(4);
  });

  it("forgets every answer when new credentials are installed", async () => {
    expect(await check([pageId])).toEqual([true]);
    visible.set(PAGE_NORMALIZED, false);
    expect(await check([pageId])).toEqual([true]);

    nameNewCredentials(kv);
    expect(await check([pageId])).toEqual([false]);
    expect(detectKind).toHaveBeenCalledTimes(2);
  });

  it.each([
    new NotionApiError(404, "Not found", "object_not_found"),
    new NotionApiError(403, "Restricted", "restricted_resource"),
    new NotionApiError(400, "Invalid id", "validation_error"),
  ])("treats %s as a definite denial", async error => {
    visible.set(PAGE_NORMALIZED, error);
    expect(await check([pageId])).toEqual([false]);
  });

  it.each([
    new NotionApiError(401, "Unauthorized", "unauthorized"),
    new NotionApiError(429, "Slow down", "rate_limited"),
    new NotionApiError(502, "Bad gateway"),
    new NotionApiError(400, "Bad JSON", "invalid_json"),
    new Error("No Notion credentials set."),
  ])("throws %s without caching it", async error => {
    visible.set(PAGE_NORMALIZED, error);
    await expect(check([pageId])).rejects.toBe(error);

    visible.set(PAGE_NORMALIZED, true);
    expect(await check([pageId])).toEqual([true]);
    expect(detectKind).toHaveBeenCalledTimes(2);
  });

  it("names credentials only while the account holds an access token", () => {
    const empty = new FakeKv();
    expect(credentialsId(empty)).toBeUndefined();
    empty.put("accessToken", "token");
    const named = credentialsId(empty);
    expect(named).toEqual(expect.any(String));
    expect(credentialsId(empty)).toBe(named);
    nameNewCredentials(empty);
    expect(credentialsId(empty)).not.toBe(named);
  });
});
