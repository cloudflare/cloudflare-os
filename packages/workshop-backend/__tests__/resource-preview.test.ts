import { RpcStub, RpcTarget } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ResourcePreview } from "@gadgets/workshop-shared/gatekeeper";
import { makeActionStorage, openFakeOverseer, putAction, type ActionTestStorage } from "./fixtures.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const GATEKEEPER = 3;

// The gatekeeper numbers action N as 100 + N, so a test can tell its numbers from log entry ids.
function queue(storage: ActionTestStorage, id: number, state: "pending" | "approved" = "pending") {
  putAction(storage, id, { gatekeeperId: GATEKEEPER, state });
  let record = storage.actions.get(id)!;
  storage.actions.put({ ...record, action: 100 + id } as typeof record);
}

function preview(actions: number[], omitted?: ResourcePreview["omitted"]): ResourcePreview {
  return {
    title: "Plan", actions, omitted,
    content: { type: "document", tabs: [{ id: "t", title: "Tab", markdown: "", edits: [] }] },
  };
}

// Reaches the facet as a real RPC stub, so a gatekeeper lacking the method fails as workerd fails.
function scenario(target: RpcTarget, opts: { ownerId?: string } = {}) {
  let storage = makeActionStorage();
  storage.gatekeepers.put({ id: GATEKEEPER, resourceTitle: "Plan", class: {} as any });
  let open = () => openFakeOverseer(storage, { impl: {
    ...opts,
    getGatekeeperFacet: async (id: number) => {
      expect(id).toBe(GATEKEEPER);
      return new RpcStub(target);
    },
  } });
  return { storage, open };
}

class Previewer extends RpcTarget {
  constructor(private result: ResourcePreview | null, private calls: (string | undefined)[] = []) {
    super();
  }
  async previewResource(subject?: string) {
    this.calls.push(subject);
    return this.result;
  }
}

describe("previewResource", () => {
  it("gives the owner the preview, numbered by log entry id", async () => {
    let calls: (string | undefined)[] = [];
    let s = scenario(new Previewer(preview([102, 101], [{ action: 104, reason: "Stale" }]), calls));
    for (let id of [1, 2, 4]) queue(s.storage, id);

    let result = await (await s.open()).previewResource(GATEKEEPER, "doc-1");
    expect(calls).toEqual(["doc-1"]);
    expect(result).toMatchObject({ title: "Plan", actions: [2, 1], omitted: [{ action: 4, reason: "Stale" }] });
    // No observation recorded.
    expect([...s.storage.actions.list()].map(record => record.type)).toEqual(["action", "action", "action"]);
  });

  it("keeps the indices of actions decided meanwhile, and drops their omissions", async () => {
    let s = scenario(new Previewer(preview([101, 102, 103], [{ action: 102, reason: "Stale" }])));
    queue(s.storage, 1);
    queue(s.storage, 2, "approved");
    queue(s.storage, 3);

    let result = await (await s.open()).previewResource(GATEKEEPER);
    expect(result).toMatchObject({ actions: [1, -1, 3], omitted: [] });
  });

  it("answers null to a build collaborator without asking the gatekeeper", async () => {
    let calls: (string | undefined)[] = [];
    let s = scenario(new Previewer(preview([]), calls), { ownerId: "someone-else" });

    expect(await (await s.open()).previewResource(GATEKEEPER)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("answers null when the gatekeeper does not implement it", async () => {
    let s = scenario(new RpcTarget());
    expect(await (await s.open()).previewResource(GATEKEEPER)).toBeNull();
  });

  it("passes on the gatekeeper's own failures", async () => {
    class Failing extends RpcTarget {
      async previewResource(): Promise<never> { throw new TypeError("Cannot read the document"); }
    }
    let s = scenario(new Failing());
    await expect((await s.open()).previewResource(GATEKEEPER)).rejects.toThrow("Cannot read the document");
  });

  it("refuses an unknown connection", async () => {
    let s = scenario(new Previewer(null));
    await expect((await s.open()).previewResource(99)).rejects.toThrow("No such gatekeeper: 99");
  });
});
