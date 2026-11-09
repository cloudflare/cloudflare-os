// A "use" collaborator who cannot be verified against a gadget's data gets the owner's view of it
// instead of a refusal (docs/sharing.md, "Shared views"), but only while the view exists and the
// deployment serves views; access still refuses exactly like a missing gadget, and the view
// client reaches nothing a live one would.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding) with the real sharing
// graph and a real gadget, loaded from a real commit; a forged UseOverseerInterface
// (openFakeOverseer) delegates to it, and gatekeeper facets and User DOs are the only fakes. The
// test environment has no admin config, so the policy check is replaced where a test needs views
// served.

import { describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  CollaboratorAccess, GadgetClient, ObserverBindingNeed, PermissionEdge,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { GatekeeperRecord } from "../src/storage-schema/overseer-storage.js";
import { openFakeOverseer } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type ObserverImpl = OverseerDurableObject["impl"];

const OWNER = "owner";
const OWNER_USER = "owner-user";
// openFakeOverseer opens "use" sessions as this User DO and profile.
const VIEWER_USER = "viewer-id";
const VIEWER = `${VIEWER_USER}-profile`;
const GADGET = 100;
// A gadget that keeps a value in each kind of storage and reports what its env holds.
const SERVER_JS = `
import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v TEXT)");
  }
  async put(k, v) { await this.ctx.storage.put(k, v); }
  async get(k) { return await this.ctx.storage.get(k); }
  sqlPut(k, v) { this.ctx.storage.sql.exec("INSERT OR REPLACE INTO t VALUES (?, ?)", k, v); }
  sqlGet(k) { return this.ctx.storage.sql.exec("SELECT v FROM t WHERE k = ?", k).toArray()[0]?.v; }
  envKeys() { return Object.keys(this.env); }
}
`;

const fakeGatekeeperClass = {} as unknown as GatekeeperRecord["class"];

let doCounter = 0;

async function withImpl(fn: (impl: ObserverImpl) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`shared-views-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = instance["impl"];
    impl.ownerProfileId = OWNER;
    impl.ownerId = OWNER_USER;
    await fn(impl);
  });
}

// A gadget reading one connection, shared with the viewer, who has chosen no account for it.
function seedSharedGadget(impl: ObserverImpl): void {
  impl.storage.gatekeepers.put({
    id: 1, resourceTitle: "finance.accounts", class: fakeGatekeeperClass,
    creationSpec: {
      type: "gatekeeper", vendorId: "testvendor", resourceUrl: "https://example.com/1",
      typeUrlPattern: "https://*",
    },
  });
  impl.storage.gadgets.put({
    type: "gadget", id: GADGET, title: "Workers Paid billing", created: new Date(0),
    bindingName: "G", bindings: { DB: { target: 1 } }, commitId: "a".repeat(40),
  });
  let addedBy: PermissionEdge[] = [
    { type: "user", sharer: OWNER, created: new Date(0), role: "use", gadgetId: GADGET },
  ];
  impl.storage.collaborators.put({ profile: { id: VIEWER, name: "Bob" }, addedBy });
}

// Gives the gadget real code at a real commit, and returns the commit.
async function commitGadget(impl: ObserverImpl, clientJs = "render()"): Promise<string> {
  let commitId = await impl.gitCache.writeFilesAsCommit(
      new Map([["server.js", SERVER_JS], ["client.js", clientJs]]), {
        parents: [], author: { name: "Phillip", email: "phillip@example.com" },
        message: "gadget", timestamp: new Date(1700000000_000),
      });
  impl.storage.gadgets.put({ ...impl.getGadgetRecord(GADGET), commitId });
  return commitId;
}

// A view record as the owner's open leaves one, without the clone (see takeView for that).
function publishView(impl: ObserverImpl): Date {
  let takenAt = new Date("2026-11-06T10:42:00Z");
  impl.storage.views.put({
    gadgetId: GADGET, takenAt, byProfileId: OWNER, commitId: "a".repeat(40),
    requirementKeys: ["1:finance.accounts"],
  });
  return takenAt;
}

// A refresh the interval allows: waits for the clone to land.
async function takeView(impl: ObserverImpl): Promise<void> {
  let before = impl.storage.views.get(GADGET)?.takenAt.valueOf();
  void impl.refreshView(GADGET);
  await vi.waitFor(() => {
    let after = impl.storage.views.get(GADGET)?.takenAt.valueOf();
    expect(after !== undefined && after !== before).toBe(true);
  });
}

// Gatekeeper facets admitting the viewer unless `refuse` says otherwise.
function facets(impl: ObserverImpl, refuse = false): void {
  const getFacet = async (id: number) => ({
    describe: async () => ({
      url: `https://example.com/${id}`, title: "finance.accounts", snippet: "",
      suggestedBindingName: "C", tsType: "C",
    }),
    addObserver: async () => {
      if (refuse) throw new Error("bob@cloudflare.com can't open finance.accounts");
    },
    removeObserver: async () => {},
  });
  impl.getGatekeeperFacet = getFacet as unknown as ObserverImpl["getGatekeeperFacet"];
}

const users = (whoami: { id: string, name: string }) => ({
  idFromString: (id: string) => id,
  get: () => ({
    id: { toString: () => VIEWER_USER },
    getVerifier: async () => ({}),
    describeConnectedAccount: async () => null,
    whoami: async () => ({ type: "user", ...whoami }),
    recordSharedWorkspaceOpen: async () => {},
    syncWorkspaceOutputs: async () => {},
  }),
});

function openViewer(impl: ObserverImpl, access: CollaboratorAccess = {
  role: "use", gadgetIds: [GADGET],
}) {
  // The owner's User DO answers whoami for the view's `owner`.
  impl.users = users({ id: OWNER, name: "Phillip Jones" }) as unknown as ObserverImpl["users"];
  impl.wrapUserDo = ((stub: unknown) => stub) as ObserverImpl["wrapUserDo"];
  return openFakeOverseer({ gadgets: impl.storage.gadgets }, { role: "use", access, impl: {
    env: impl.env,
    ctx: impl.ctx,
    users: users({ id: VIEWER, name: "Bob" }),
    joinSession: (kind: "use", gadgetId?: number) => impl.joinSession(kind, gadgetId),
    authorizeGadget: (...args: Parameters<ObserverImpl["authorizeGadget"]>) =>
        impl.authorizeGadget(...args),
    getGadgetRecord: (id: number) => impl.getGadgetRecord(id),
    getGadgetUiBundle: (id: number) => impl.getGadgetUiBundle(id),
    sharedViewsAvailable: () => impl.sharedViewsAvailable(),
    readView: (id: number) => impl.readView(id),
    getViewUiBundle: (id: number) => impl.getViewUiBundle(id),
    getViewFacet: (id: number) => impl.getViewFacet(id),
    refreshView: (id: number) => impl.refreshView(id),
  } });
}

// Answers the configuration prompt with account 10 for every binding asked about, then gives up
// on a re-prompt, as the explore dialog's "Done" does.
function chooseAccount(): never {
  return new NativeRpcStub({
    configure: async (needs: ObserverBindingNeed[]) => {
      if (needs.some(need => need.failure)) throw new Error("Not now.");
      return needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: 10 }));
    },
  }) as never;
}

// Counts the sessions joined and not yet left from here on.
function countSessions(impl: ObserverImpl): { count: number } {
  let live = { count: 0 };
  let join = impl.joinSession.bind(impl);
  impl.joinSession = (...args: Parameters<ObserverImpl["joinSession"]>) => {
    let leave = join(...args);
    live.count++;
    let left = false;
    return () => {
      if (!left) live.count--;
      left = true;
      leave();
    };
  };
  return live;
}

function servesViews(impl: ObserverImpl, enabled = true): void {
  impl.sharedViewsAvailable = async () => enabled;
}

// (The view client holds nothing to release, so it has no dispose of its own.)
function dispose(value: unknown): void {
  (value as Partial<Disposable>)[Symbol.dispose]?.();
}

describe("getGadget for a collaborator who can't be verified", () => {
  it("hands out the owner's view, with no prompt and no session counted", () =>
      withImpl(async impl => {
    seedSharedGadget(impl);
    facets(impl);
    servesViews(impl);
    let takenAt = publishView(impl);
    let live = countSessions(impl);
    let client = await openViewer(impl);
    live.count = 0;  // the shell's own session

    // No configuration callback: the silent first open of someone who never chose an account.
    let gadget: GadgetClient = await client.getGadget(GADGET);

    expect(await gadget.getAccessMode()).toBe("view");
    expect(await gadget.getTitle()).toBe("Workers Paid billing");
    let view = await gadget.getView();
    expect(view.takenAt).toEqual(takenAt);
    expect(view.owner).toMatchObject({ id: OWNER, name: "Phillip Jones" });
    // A widening finds no session to sever: the view holds nothing it would need to.
    expect(live.count).toBe(0);
    expect(impl.storage.collaboratorOpens.get(VIEWER)?.gadgets[GADGET]?.mode).toBe("view");
    dispose(gadget);
    dispose(client);
  }));

  it("serves the view: the owner's storage, the view's code, no bindings", () =>
      withImpl(async impl => {
    seedSharedGadget(impl);
    facets(impl);
    servesViews(impl);
    await commitGadget(impl, "render(1)");
    using running = await impl.getGadgetFacet(GADGET);
    await running.put("k", "v1");
    await running.sqlPut("s", "sv1");
    await takeView(impl);
    // Within the refresh interval, the view stays as it was taken.
    await commitGadget(impl, "render(2)");
    await running.put("k", "v2");
    let client = await openViewer(impl);
    let gadget = await client.getGadget(GADGET);

    expect(await gadget.getUiBundle()).toEqual({ jsCode: "render(1)" });
    using copy = await gadget.connectToGadget();
    expect(await copy.get("k")).toBe("v1");
    expect(await copy.sqlGet("s")).toBe("sv1");
    expect(await copy.envKeys()).toEqual([]);
    // What a viewer changes in the copy never reaches the gadget.
    await copy.put("k", "theirs");
    expect(await running.get("k")).toBe("v2");
    dispose(gadget);
    dispose(client);
  }));

  it("opening the view retakes a stale one, so what the gadget wrote since reaches viewers", () =>
      withImpl(async impl => {
    seedSharedGadget(impl);
    facets(impl);
    servesViews(impl);
    await commitGadget(impl, "render(1)");
    using running = await impl.getGadgetFacet(GADGET);
    await running.put("k", "v1");
    await takeView(impl);
    // The owner is away; the gadget's scheduled work writes, and its code moves on.
    await running.put("k", "from the schedule");
    await commitGadget(impl, "render(2)");
    impl.storage.views.put({ ...impl.storage.views.get(GADGET)!, takenAt: new Date(0) });

    let client = await openViewer(impl);
    let gadget = await client.getGadget(GADGET);
    // The open took the new view before handing it over: its time, UI and copy agree.
    expect((await gadget.getView()).takenAt.valueOf()).toBeGreaterThan(0);
    expect(await gadget.getUiBundle()).toEqual({ jsCode: "render(2)" });
    using copy = await gadget.connectToGadget();
    expect(await copy.get("k")).toBe("from the schedule");
    dispose(gadget);
    dispose(client);
  }));

  it("the owner's next open replaces the copy, viewers' changes and all", () =>
      withImpl(async impl => {
    seedSharedGadget(impl);
    facets(impl);
    servesViews(impl);
    await commitGadget(impl);
    using running = await impl.getGadgetFacet(GADGET);
    await running.put("k", "v1");
    await takeView(impl);
    let client = await openViewer(impl);
    let gadget = await client.getGadget(GADGET);
    using copy = await gadget.connectToGadget();
    await copy.put("k", "theirs");

    await running.put("k", "v2");
    impl.storage.views.put({ ...impl.storage.views.get(GADGET)!, takenAt: new Date(0) });
    await takeView(impl);

    // The viewer's connection ended with the copy it was to ("Facet was cloned-over"; GadgetUI
    // reconnects on it). Not exercised through `copy`: a call on a stub whose facet is gone is
    // rejected as expected but also reported as an unhandled rejection by the runtime, which
    // fails the run. The next connection is to the new copy.
    using fresh = await gadget.connectToGadget();
    expect(await fresh.get("k")).toBe("v2");
    dispose(gadget);
    dispose(client);
  }));

  it("a view client reaches no gatekeeper and never the running gadget", () =>
      withImpl(async impl => {
    seedSharedGadget(impl);
    facets(impl);
    servesViews(impl);
    publishView(impl);
    let client = await openViewer(impl);
    let gadget = await client.getGadget(GADGET);

    for (let call of [
      // A chat names code the viewer may not see.
      () => gadget.connectToGadget(1),
      () => gadget.getUiBundle(1),
      () => gadget.openView(),
      () => gadget.export("html"),
      () => gadget.getExportFormats(),
      () => gadget.listBindings(),
      () => gadget.getBinding("DB"),
    ]) {
      await expect(call()).rejects.toThrow(/Unauthorized/);
    }
    dispose(gadget);
    dispose(client);
  }));

  it("takes the view for the owner's preview before anyone has the gadget, audited", () =>
      withImpl(async impl => {
    impl.storage.gadgets.put({
      type: "gadget", id: GADGET, title: "Workers Paid billing", created: new Date(0),
      bindingName: "G", bindings: {},
    });
    servesViews(impl);
    await commitGadget(impl);
    using running = await impl.getGadgetFacet(GADGET);
    await running.put("k", "mine");
    // Nobody holds it, so an open by the owner takes nothing...
    await impl.refreshView(GADGET);
    expect(impl.storage.views.get(GADGET)).toBeUndefined();
    // ...but their preview does, and records it like any other.
    await impl.refreshView(GADGET, true);
    expect(impl.storage.views.get(GADGET)).toBeDefined();
    expect([...impl.storage.actions.list()].filter(a => a.type === "viewPublished")).toHaveLength(1);
    using copy = await impl.getViewFacet(GADGET);
    expect(await copy.get("k")).toBe("mine");
  }));

  it("lets the owner open the view as people see it", () => withImpl(async impl => {
    seedSharedGadget(impl);
    servesViews(impl);
    await commitGadget(impl, "render(1)");
    using running = await impl.getGadgetFacet(GADGET);
    await running.put("k", "v1");
    await expect(impl.getViewFacet(GADGET)).rejects.toThrow(/no view/);
    await takeView(impl);

    using copy = await impl.getViewFacet(GADGET);
    expect(await copy.get("k")).toBe("v1");
    expect(await impl.getViewUiBundle(GADGET)).toEqual({ jsCode: "render(1)" });
  }));

  it("hands out the view when a check with the remembered account fails", () =>
      withImpl(async impl => {
    seedSharedGadget(impl);
    facets(impl, true);
    servesViews(impl);
    publishView(impl);
    let client = await openViewer(impl);

    let gadget = await client.getGadget(GADGET, chooseAccount());

    expect(await gadget.getAccessMode()).toBe("view");
    // A failed check publishes no account choice: observations would otherwise check it too.
    expect(impl.storage.observers.get(VIEWER)?.accountChoices).toEqual({});
    dispose(gadget);
    dispose(client);
  }));

  it("admits a collaborator who verifies to the live gadget", () => withImpl(async impl => {
    seedSharedGadget(impl);
    facets(impl);
    servesViews(impl);
    publishView(impl);
    let client = await openViewer(impl);

    let gadget = await client.getGadget(GADGET, chooseAccount());

    expect(await gadget.getAccessMode()).toBe("live");
    await expect(gadget.getView()).rejects.toThrow(/Unauthorized/);
    await expect(gadget.openView()).rejects.toThrow(/Unauthorized/);
    expect(impl.storage.collaboratorOpens.get(VIEWER)?.gadgets[GADGET]?.mode).toBe("live");
    dispose(gadget);
    dispose(client);
  }));

  it("refuses someone removed from the gadget like a missing gadget", () =>
      withImpl(async impl => {
    seedSharedGadget(impl);
    facets(impl);
    servesViews(impl);
    publishView(impl);
    impl.storage.collaborators.put({ profile: { id: VIEWER, name: "Bob" }, addedBy: [] });
    let client = await openViewer(impl);

    await expect(client.getGadget(GADGET)).rejects.toThrow(`No such gadget: ${GADGET}`);
    expect(impl.storage.collaboratorOpens.get(VIEWER)).toBeUndefined();
    dispose(client);
  }));

  it("throws as before when the deployment does not serve views", () =>
      withImpl(async impl => {
    seedSharedGadget(impl);
    facets(impl);
    servesViews(impl, false);
    publishView(impl);
    let client = await openViewer(impl);

    await expect(client.getGadget(GADGET)).rejects.toThrow(/no configuration channel/);
    dispose(client);
  }));

  it("throws as before when no view has been taken", () => withImpl(async impl => {
    seedSharedGadget(impl);
    facets(impl);
    servesViews(impl);
    let client = await openViewer(impl);

    await expect(client.getGadget(GADGET)).rejects.toThrow(/no configuration channel/);
    dispose(client);
  }));

  it("refuses a link joiner under ownerInvitesOnly, view or not", () => withImpl(async impl => {
    seedSharedGadget(impl);
    facets(impl);
    servesViews(impl);
    publishView(impl);
    impl.storage.shareKeys.put({
      id: "link-1", created: new Date(0), createdBy: OWNER, role: "use", gadgetId: GADGET,
    });
    impl.storage.collaborators.put({
      profile: { id: VIEWER, name: "Bob" },
      addedBy: [{ type: "shareKey", keyId: "link-1", created: new Date(0) }],
    });
    impl.storage.ownerInvitesOnly.put(true);
    let client = await openViewer(impl);

    await expect(client.getGadget(GADGET)).rejects.toThrow(`No such gadget: ${GADGET}`);
    dispose(client);
  }));

  it("withdraws a view whose publisher no longer holds build", () => withImpl(async impl => {
    seedSharedGadget(impl);
    facets(impl);
    servesViews(impl);
    publishView(impl);
    impl.storage.views.put({ ...impl.storage.views.get(GADGET)!, byProfileId: "former-editor" });
    let client = await openViewer(impl);

    await expect(client.getGadget(GADGET)).rejects.toThrow(/no configuration channel/);
    expect(impl.storage.views.get(GADGET)).toBeUndefined();
    dispose(client);
  }));
});

describe("lastOpened", () => {
  it("reports how each collaborator last opened the gadgets they still hold", () =>
      withImpl(async impl => {
    seedSharedGadget(impl);
    impl.storage.collaboratorOpens.put({ profileId: VIEWER, gadgets: {
      [GADGET]: { at: new Date(1), mode: "view" },
      101: { at: new Date(2), mode: "live" },
    } });
    let [info] = impl.withLastOpened((await impl.getSharingManager()).listCollaborators());

    expect(info!.lastOpened).toEqual({ [GADGET]: { at: new Date(1), mode: "view" } });
  }));
});

describe("taking the owner's view", () => {
  // Counts the clones #takeView goes on to attempt: it reads the gadget's files only once it has
  // decided a view is wanted. With `screen`, the gadget has one and the clone goes ahead; without,
  // it stops there.
  function countRenders(impl: ObserverImpl, screen = false): { count: number } {
    let renders = { count: 0 };
    servesViews(impl);
    impl.readGadgetFiles = (async () => {
      renders.count++;
      return new Map(screen ? [["client.js", ""], ["server.js", ""]] : []);
    }) as ObserverImpl["readGadgetFiles"];
    return renders;
  }

  it("doesn't let an open with nobody to show it hold back the view for the first share", () =>
      withImpl(async impl => {
    impl.storage.gadgets.put({
      type: "gadget", id: GADGET, title: "Workers Paid billing", created: new Date(0),
      bindingName: "G", bindings: {}, commitId: "a".repeat(40),
    });
    let renders = countRenders(impl);
    void impl.refreshView(GADGET);
    // Nobody holds the gadget through "use", so no view is wanted...
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(renders.count).toBe(0);

    // ...and once someone does, the next call renders at once rather than waiting out the interval.
    seedSharedGadget(impl);
    void impl.refreshView(GADGET);
    await vi.waitFor(() => expect(renders.count).toBe(1));
  }));

  it("clones at most once per interval once a view is wanted", () => withImpl(async impl => {
    seedSharedGadget(impl);
    let renders = countRenders(impl, true);
    void impl.refreshView(GADGET);
    await vi.waitFor(() => expect(renders.count).toBe(1));
    await vi.waitFor(() => expect(impl.storage.views.get(GADGET)).toBeDefined());
    void impl.refreshView(GADGET);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(renders.count).toBe(1);
  }));

  it("records what the view may hold, and removes it with the gadget", () =>
      withImpl(async impl => {
    seedSharedGadget(impl);
    servesViews(impl);
    await commitGadget(impl);
    await takeView(impl);
    let view = impl.storage.views.get(GADGET)!;
    expect(view).toMatchObject({ byProfileId: OWNER, commitId: impl.getGadgetRecord(GADGET).commitId });
    let [action] = [...impl.storage.actions.list()].filter(a => a.type === "viewPublished");
    expect(action).toMatchObject({ gadgetId: GADGET, requirementKeys: view.requirementKeys });

    await impl.removeWorkpiece(GADGET);
    expect(impl.storage.views.get(GADGET)).toBeUndefined();
  }));
});
