// Applying a branch (plans/forking-reality.md): how the kernel finds out a gatekeeper has adopted
// branches, the lists it hands Gatekeeper.applyActions(), how it settles each action a call names,
// and the actions a gatekeeper reports it rejected along with one. The gatekeeper facet is a plain
// object here, as in git-push-actions.test.ts; packages/integration-tests drives a real one.

import { env, RpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionLogEntry } from "@gadgets/workshop-shared/api";
import type { ApplyActionsResult, BranchView } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer";
import type { UserDurableObject } from "../src/user";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations";
import type { ActionRecord, GatekeeperCaller } from "../src/storage-schema/overseer-storage";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];

const GK = 7;
const USER = {type: "user" as const, id: "approver", name: "Approver"};
const STAGED: GatekeeperCaller = {from: "user"};
const CHAT_A: GatekeeperCaller = {from: "user", chatId: 1};
const CHAT_B: GatekeeperCaller = {from: "user", chatId: 2};
const EDITS = {tag: "edit", label: "Edits"};

afterEach(() => { vi.restoreAllMocks(); });

// A workspace owned by a real user (approveAction() and rejectAction() read the client's profile)
// with connection GK, whose facet is `facet`.
async function workspace(facet: object) {
  const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const user = env.TEST_USER.getByName(crypto.randomUUID());
  await runInDurableObject(user, instance => { instance["storage"].profile.put(USER); });
  await user.newWorkspace(stub.id.toString(), "Branches");
  const visit = <T>(fn: (impl: Impl) => T | Promise<T>) =>
    runInDurableObject(env.TEST_OVERSEER.get(stub.id), ({impl}) => fn(impl));
  await visit(impl => {
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    impl.storage.ownerId.put(user.id.toString());
    impl.ownerId = user.id.toString();
    impl.storage.gatekeepers.put({id: GK, class: {} as never});
    vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue(facet as never);
  });
  return {
    visit,
    client: () => env.TEST_OVERSEER.get(stub.id).open(user.id.toString(), USER.id,
        new RpcStub(() => {})),
  };
}

// A gatekeeper that has adopted branches, holding its pending actions by number. A call applies
// the listed actions it holds, in order, stopping as `next` says once.
function branchGatekeeper() {
  const held = new Set<number>();
  const calls: {branch: string | null, actions: number[]}[] = [];
  const next: {
    limit?: number, fail?: NonNullable<ApplyActionsResult["failed"]>, lose?: boolean,
    alsoRejects?: number[],
  } = {};
  const facet = {
    async applyActions(view: BranchView, actions: number[]): Promise<ApplyActionsResult> {
      calls.push({branch: view.branch, actions});
      const applied: number[] = [];
      for (const action of actions) {
        if (!held.has(action)) continue;
        if (next.fail?.action === action) {
          const failed = next.fail;
          delete next.fail;
          return {applied, failed};
        }
        if (next.limit !== undefined && applied.length === next.limit) return {applied};
        held.delete(action);
        applied.push(action);
      }
      if (next.lose) {
        delete next.lose;
        throw new Error("The connection to the gatekeeper was lost.");
      }
      return {applied};
    },
    async rejectAction(action: number) {
      const rejected = next.alsoRejects ?? [];
      delete next.alsoRejects;
      for (const other of [action, ...rejected]) held.delete(other);
      return {rejected};
    },
  };
  return {held, calls, next, facet};
}

function description(autoApprovable = false) {
  return {title: "Set the value", description: "", implementsRevert: false, autoApprovable,
    actionKind: EDITS};
}

// Submits gatekeeper action `action` (which it then holds) and returns its kernel record.
async function submit(impl: Impl, gatekeeper: {held: Set<number>}, action: number,
                      caller: GatekeeperCaller, autoApprovable = false) {
  gatekeeper.held.add(action);
  await impl.submitAction(GK, action, description(autoApprovable), caller);
  return record(impl, action);
}

function record(impl: Impl, action: number): ActionRecord & {type: "action"} {
  const found = [...impl.storage.actions.list()]
      .find(r => r.type === "action" && r.gatekeeperId === GK && r.action === action);
  if (found?.type !== "action") throw new Error(`No record of action ${action}`);
  return found;
}

const states = (impl: Impl, ...actions: number[]) =>
  actions.map(action => record(impl, action).state);

describe("finding out whether a gatekeeper has adopted branches", () => {
  const MISSING = new TypeError('The RPC receiver does not implement the method "applyActions".');

  it.each([
    ["has no such member", {}],
    ["is refused by Workers RPC", {get applyActions() { throw MISSING; }}],
    ["reads as undefined", {applyActions: undefined}],
  ])("is no when the method %s, and marks no leftovers", async (_, facet) => {
    const {visit} = await workspace(facet);
    await visit(async impl => {
      await expect(impl.adoptsBranches(GK)).resolves.toBe(false);
      expect(impl.storage.gatekeepers.get(GK)?.leftoversThrough).toBeUndefined();
    });
  });

  it("propagates any other failure to read it", async () => {
    const {visit} = await workspace({get applyActions() { throw new TypeError("Network lost"); }});
    await visit(async impl => {
      await expect(impl.adoptsBranches(GK)).rejects.toThrow("Network lost");
    });
  });

  it("is yes when it is implemented, and the first yes marks where leftovers end", async () => {
    const gatekeeper = branchGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await submit(impl, gatekeeper, 1, STAGED);
      const through = impl.storage.nextActionId.get() - 1;
      await expect(impl.adoptsBranches(GK)).resolves.toBe(true);
      await submit(impl, gatekeeper, 2, STAGED);
      await expect(impl.adoptsBranches(GK)).resolves.toBe(true);
      expect(impl.storage.gatekeepers.get(GK)?.leftoversThrough).toBe(through);
    });
  });

  it("is asked once per session, before its first submission is recorded", async () => {
    let reads = 0;
    const gatekeeper = branchGatekeeper();
    const facet = {
      ...gatekeeper.facet,
      get applyActions() { reads++; return gatekeeper.facet.applyActions; },
      startSession: (queue: unknown) => queue,
    };
    const {visit} = await workspace(facet);
    await visit(async impl => {
      await submit(impl, gatekeeper, 1, STAGED);  // a leftover: submitted by no session
      type Queue = {submitAction(action: number, d: object): Promise<void>,
                    holdsAction(action: number): Promise<boolean>};
      const queue = await impl.openGatekeeperSession(GK, facet as never, CHAT_A) as unknown as Queue;
      await queue.submitAction(2, description());
      await queue.submitAction(3, description());
      expect(reads).toBe(1);
      // The first session's own submission is not taken for a leftover.
      expect(impl.storage.gatekeepers.get(GK)?.leftoversThrough).toBe(record(impl, 1).id);

      // holdsAction() answers from what is pending on this connection.
      await expect(queue.holdsAction(2)).resolves.toBe(true);
      await expect(queue.holdsAction(9)).resolves.toBe(false);
      await impl.applyPendingAction(record(impl, 2), USER, false);
      await expect(queue.holdsAction(2)).resolves.toBe(false);
    });
  });
});

describe("approving an action of a gatekeeper that has adopted branches", () => {
  it("applies staging and the action's branch up to it, leftovers first, in one list", async () => {
    const gatekeeper = branchGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await submit(impl, gatekeeper, 1, CHAT_A);   // leftovers
      await submit(impl, gatekeeper, 2, STAGED);
      await submit(impl, gatekeeper, 3, CHAT_B);
      await impl.adoptsBranches(GK);
      await submit(impl, gatekeeper, 4, CHAT_A);
      const target = await submit(impl, gatekeeper, 5, CHAT_A);
      await submit(impl, gatekeeper, 6, STAGED);   // newer than the target, and staged
      await submit(impl, gatekeeper, 7, CHAT_A);   // after the target
      await submit(impl, gatekeeper, 8, CHAT_B);

      await impl.applyPendingAction(target, USER, false);

      expect(gatekeeper.calls).toEqual([{branch: "chat:1", actions: [1, 2, 6, 4, 5]}]);
      expect(states(impl, 1, 2, 3, 4, 5, 6, 7, 8)).toEqual([
        "approved", "approved", "pending", "approved", "approved", "approved", "pending", "pending",
      ]);
      expect(record(impl, 6)).toMatchObject({resolvedBy: USER, autoApproved: false});
      expect(record(impl, 6).applying).toBeUndefined();
    });
  });

  it("calls again with what is left while a call applies something", async () => {
    const gatekeeper = branchGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await impl.adoptsBranches(GK);
      for (const action of [1, 2]) await submit(impl, gatekeeper, action, CHAT_A);
      const last = await submit(impl, gatekeeper, 3, CHAT_A);
      gatekeeper.next.limit = 1;
      await impl.applyPendingAction(last, USER, false);
      expect(gatekeeper.calls.map(call => call.actions)).toEqual([[1, 2, 3], [2, 3], [3]]);
      expect(states(impl, 1, 2, 3)).toEqual(["approved", "approved", "approved"]);
    });
  });

  it("stops at a failure, keeping its error, and resumes there on retry", async () => {
    const gatekeeper = branchGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await impl.adoptsBranches(GK);
      for (const action of [1, 2]) await submit(impl, gatekeeper, action, CHAT_A);
      const last = await submit(impl, gatekeeper, 3, CHAT_A);
      gatekeeper.next.fail = {action: 2, message: "The value is locked.", retryable: true};

      await expect(impl.applyPendingAction(last, USER, false)).rejects.toThrow("The value is locked.");
      expect(states(impl, 1, 2, 3)).toEqual(["approved", "pending", "pending"]);
      expect(record(impl, 2).applyError).toEqual({message: "The value is locked.", retryable: true});
      expect([record(impl, 2).applying, record(impl, 3).applying]).toEqual([undefined, undefined]);

      await impl.applyPendingAction(record(impl, 3), USER, false);
      expect(gatekeeper.calls.at(-1)?.actions).toEqual([2, 3]);
      expect(states(impl, 2, 3)).toEqual(["approved", "approved"]);
      expect(record(impl, 2).applyError).toBeUndefined();
    });
  });

  it("rejects the actions a denial reports it rejected along with it", async () => {
    const gatekeeper = branchGatekeeper();
    const {visit, client} = await workspace(gatekeeper.facet);
    let ids: number[] = [];
    await visit(async impl => {
      await impl.adoptsBranches(GK);
      for (const action of [1, 2, 3]) await submit(impl, gatekeeper, action, CHAT_A);
      ids = [1, 2, 3].map(action => record(impl, action).id);
      gatekeeper.next.alsoRejects = [2, 99];
    });
    using overseer = await client();
    await overseer.rejectAction(ids[0]);
    await overseer.approveAction(ids[2]);
    await visit(impl => {
      expect(states(impl, 1, 2, 3)).toEqual(["rejected", "rejected", "approved"]);
      expect(record(impl, 2).resolvedBy).toEqual(USER);
      expect(gatekeeper.calls.map(call => call.actions)).toEqual([[3]]);
    });
  });

  it("takes a call that threw as having applied what the next call finds gone", async () => {
    const gatekeeper = branchGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await impl.adoptsBranches(GK);
      await submit(impl, gatekeeper, 1, CHAT_A);
      const last = await submit(impl, gatekeeper, 2, CHAT_A);
      gatekeeper.next.lose = true;
      await expect(impl.applyPendingAction(last, USER, false)).rejects.toThrow("was lost");
      expect(states(impl, 1, 2)).toEqual(["pending", "pending"]);
      expect([record(impl, 1).applying, record(impl, 2).applying]).toEqual([true, true]);

      await impl.applyPendingAction(record(impl, 2), USER, false);
      expect(states(impl, 1, 2)).toEqual(["approved", "approved"]);
      expect(record(impl, 1).applyError).toBeUndefined();
    });
  });

  it("rejects a named action the gatekeeper never kept", async () => {
    const gatekeeper = branchGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await impl.adoptsBranches(GK);
      await submit(impl, gatekeeper, 1, CHAT_A);
      gatekeeper.held.delete(1);  // as if its submitAction() reply was lost
      const last = await submit(impl, gatekeeper, 2, CHAT_A);
      await impl.applyPendingAction(last, USER, false);
      expect(states(impl, 1, 2)).toEqual(["rejected", "approved"]);
      expect(record(impl, 1).applyError?.retryable).toBe(false);
    });
  });

  it("keeps an earlier call's mark on an action the next call does not reach", async () => {
    const gatekeeper = branchGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await impl.adoptsBranches(GK);
      const chat = await submit(impl, gatekeeper, 1, CHAT_A);
      gatekeeper.next.lose = true;
      await expect(impl.applyPendingAction(chat, USER, false)).rejects.toThrow("was lost");
      // Staging, applied first, now stops the next call before the chat's action.
      await submit(impl, gatekeeper, 2, STAGED);
      gatekeeper.next.fail = {action: 2, message: "Not yet.", retryable: true};
      await expect(impl.applyPendingAction(record(impl, 1), USER, false)).rejects.toThrow("Not yet.");
      expect(record(impl, 1).applying).toBe(true);

      await impl.applyPendingAction(record(impl, 1), USER, false);
      expect(states(impl, 1, 2)).toEqual(["approved", "approved"]);
    });
  });
});

describe("auto-approval", () => {
  it("applies the eligible run in lists, each read through one view", async () => {
    const gatekeeper = branchGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await impl.adoptsBranches(GK);
      await submit(impl, gatekeeper, 1, STAGED);
      await submit(impl, gatekeeper, 2, CHAT_A);
      await submit(impl, gatekeeper, 3, STAGED);
      await submit(impl, gatekeeper, 4, CHAT_B, false);  // a manual gate
      impl.storage.autoApproveTags.put({gatekeeperId: GK, actionKind: EDITS, enabledBy: USER});
      for (const action of [1, 2, 3]) {
        const found = record(impl, action);
        impl.storage.actions.put({...found, description: description(true)});
      }
      await impl.drainAutoApprovals(GK);
      expect(gatekeeper.calls).toEqual([
        {branch: "chat:1", actions: [1, 2]},
        {branch: null, actions: [3]},
      ]);
      expect(states(impl, 1, 2, 3, 4)).toEqual(["approved", "approved", "approved", "pending"]);
      expect(record(impl, 3).autoApproved).toBe(true);
    });
  });
});

describe("a gatekeeper that applies one action at a time", () => {
  it("stops auto-approving at a rule withdrawn while an earlier action applies", async () => {
    const parked = Promise.withResolvers<void>();
    const applying = Promise.withResolvers<void>();
    const applied: number[] = [];
    const {visit} = await workspace({
      async applyAction(action: number) {
        if (applied.length === 0) {
          applying.resolve();
          await parked.promise;
        }
        applied.push(action);
      },
    });
    await visit(async impl => {
      impl.storage.autoApproveTags.put({gatekeeperId: GK, actionKind: EDITS, enabledBy: USER});
      await impl.submitAction(GK, 1, description(true), STAGED);
      await impl.submitAction(GK, 2, description(true), STAGED);
      const drain = impl.drainAutoApprovals(GK);
      await applying.promise;
      impl.storage.autoApproveTags.delete(`${GK}:${EDITS.tag}`);
      parked.resolve();
      await drain;
      expect(applied).toEqual([1]);
      expect(states(impl, 1, 2)).toEqual(["approved", "pending"]);
    });
  });

  it("records submissions in the order they arrive while a session looks for applyActions",
      async () => {
    const look = Promise.withResolvers<undefined>();
    const facet = {get applyActions() { return look.promise; }, startSession: (queue: unknown) => queue};
    const {visit} = await workspace(facet);
    await visit(async impl => {
      type Queue = {submitAction(action: number, d: object): Promise<void>};
      const open = async (caller: GatekeeperCaller) =>
        await impl.openGatekeeperSession(GK, facet as never, caller) as unknown as Queue;
      const [first, second] = [await open(CHAT_A), await open(CHAT_B)];
      // The first session's look is answered at once.
      look.resolve(undefined);
      await first.submitAction(1, description());

      // A new session's first submission looks again, and one arriving meanwhile waits for it.
      const slow = Promise.withResolvers<undefined>();
      Object.defineProperty(facet, "applyActions", {get: () => slow.promise});
      const looking = second.submitAction(2, description());
      const following = first.submitAction(3, description());
      slow.resolve(undefined);
      await Promise.all([looking, following]);
      expect(record(impl, 2).id).toBeLessThan(record(impl, 3).id);
    });
  });

  it("is handed only the approved action, and its failure is recorded until it applies", async () => {
    const applied: number[] = [];
    let failNext = true;
    const {visit, client} = await workspace({
      async applyAction(action: number) {
        if (failNext) {
          failNext = false;
          throw new Error("Try again later.");
        }
        applied.push(action);
      },
    });
    let id = 0;
    await visit(async impl => {
      for (const action of [1, 2]) {
        await impl.submitAction(GK, action, description(), CHAT_A);
      }
      id = record(impl, 2).id;
    });
    using overseer = await client();
    // (Settled here: an RPC promise's rejection reaches vitest as unhandled through `rejects`.)
    expect(await overseer.approveAction(id).then(() => null, (error: Error) => error.message))
        .toBe("Try again later.");
    const pending = (await overseer.listActions({filter: "pending"})).entries
        .find(entry => entry.id === id) as ActionLogEntry & {type: "action"};
    expect(pending.applyError).toEqual({message: "Try again later.", retryable: true});
    await overseer.approveAction(id);
    await visit(impl => {
      expect(applied).toEqual([2]);
      expect(states(impl, 1, 2)).toEqual(["pending", "approved"]);
      expect(record(impl, 2).applyError).toBeUndefined();
      expect(impl.storage.gatekeepers.get(GK)?.leftoversThrough).toBeUndefined();
    });
  });
});
