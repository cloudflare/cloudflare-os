// The branch approval model (plans/forking-reality.md):
// accepting a chat applies what staging holds on its connections and then the chat's actions,
// discarding or deleting it rejects them, auto-approval accepts a chat whose actions rules cover
// all of, and an awaited action keeps a decision of its own; staged actions apply at once unless
// staging holds them, and gadgets run on a chat's branch when the chat calls for it. The gatekeeper
// facets are plain objects, as in apply-actions.test.ts; packages/integration-tests drives real
// ones and real turns.

import { env, RpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplyActionsResult, BranchView } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer";
import type { UserDurableObject } from "../src/user";
import {
  OVERSEER_STORAGE_VERSION, migrateToHeldStaging,
} from "../src/storage-schema/overseer-migrations";
import {
  chatKeyPrefix, type ActionRecord, type GatekeeperCaller,
} from "../src/storage-schema/overseer-storage";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];

const GK = 7;
const USER = {type: "user" as const, id: "approver", name: "Approver"};
const RULE_OWNER = {type: "user" as const, id: "rules", name: "Rule Owner"};
const STAGED: GatekeeperCaller = {from: "user"};
const CHAT_A: GatekeeperCaller = {from: "user", chatId: 1};
const CHAT_B: GatekeeperCaller = {from: "user", chatId: 2};
const AGENT_A: GatekeeperCaller = {from: "agent", chatId: 1};
const EDITS = {tag: "edit", label: "Edits"};

afterEach(() => { vi.restoreAllMocks(); });

// A workspace owned by a real user, with chats 1 ("Mine") and 2 ("Theirs") and connection GK,
// whose facet is `facet`.
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
    for (const [id, title] of [[1, "Mine"], [2, "Theirs"]] as const) {
      impl.storage.chatMeta.put({id, title, started: new Date(0), lastActive: new Date(id)});
    }
    vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue(facet as never);
  });
  return {
    visit,
    client: () => env.TEST_OVERSEER.get(stub.id).open(user.id.toString(), USER.id,
        new RpcStub(() => {})),
  };
}

// A gatekeeper that applies one action at a time, recording the order, and refuses `refuse`.
function legacyGatekeeper() {
  const applied: number[] = [];
  const rejected: number[] = [];
  const next: {refuse?: number} = {};
  const facet = {
    async applyAction(action: number) {
      if (next.refuse === action) throw new Error("Out of order.");
      applied.push(action);
    },
    async rejectAction(action: number) { rejected.push(action); },
  };
  return {applied, rejected, next, facet};
}

// A gatekeeper that has adopted branches, applying whatever a list names.
function branchGatekeeper() {
  const calls: {branch: string | null, actions: number[]}[] = [];
  const next: {fail?: NonNullable<ApplyActionsResult["failed"]>} = {};
  const facet = {
    async applyActions(view: BranchView, actions: number[]): Promise<ApplyActionsResult> {
      calls.push({branch: view.branch, actions});
      const failed = next.fail;
      delete next.fail;
      return failed ? {applied: actions.slice(0, actions.indexOf(failed.action)), failed}
                    : {applied: actions};
    },
    async rejectAction() {},
  };
  return {calls, next, facet};
}

function description(autoApprovable = false, awaitDecision = false) {
  return {title: "Set the value", description: "", implementsRevert: false, autoApprovable,
    actionKind: EDITS, ...(awaitDecision ? {awaitDecision} : {})};
}

function record(impl: Impl, action: number): ActionRecord & {type: "action"} {
  const found = [...impl.storage.actions.list()]
      .find(r => r.type === "action" && r.gatekeeperId === GK && r.action === action);
  if (found?.type !== "action") throw new Error(`No record of action ${action}`);
  return found;
}

const states = (impl: Impl, ...actions: number[]) =>
  actions.map(action => record(impl, action).state);

// Staging holds what it is given while the workspace has read restricted data (see
// OverseerImpl.#stagedRun), which tests of what a chat's accept does with staging rely on.
const holdStaging = (impl: Impl) => impl.storage.containsRestrictedData.put(true);

// Stands in for an upgrade from before staging applied at once: what `arrange` submits is pending
// then, and the version-10 migration marks what of it is staged (see migrateToHeldStaging).
async function upgradeWith(impl: Impl, arrange: () => Promise<unknown>) {
  holdStaging(impl);
  await arrange();
  impl.storage.containsRestrictedData.put(false);
  impl.storage.version.put(9);
  migrateToHeldStaging(impl);
}

const enableRule = (impl: Impl) =>
  impl.storage.autoApproveTags.put({gatekeeperId: GK, actionKind: EDITS, enabledBy: RULE_OWNER});

describe("accepting a chat", () => {
  it("applies staging on its connection and then its own actions, in ID order, one at a time",
      async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      holdStaging(impl);
      await impl.submitAction(GK, 1, description(), STAGED);
      await impl.submitAction(GK, 2, description(), CHAT_A);
      await impl.submitAction(GK, 3, description(), CHAT_B);
      await impl.submitAction(GK, 4, description(), CHAT_A);
      await impl.submitAction(GK, 5, description(), STAGED);

      await expect(impl.acceptBranch(1, impl.branchSnapshot(1), USER)).resolves.toBe(true);
      expect(gatekeeper.applied).toEqual([1, 2, 4, 5]);
      expect(states(impl, 1, 2, 3, 4, 5))
          .toEqual(["approved", "approved", "pending", "approved", "approved"]);
      expect(record(impl, 4)).toMatchObject({resolvedBy: USER, autoApproved: false});
    });
  });

  it("applies only what was pending when it began, on every connection", async () => {
    const GK2 = 8;
    const parked = Promise.withResolvers<void>();
    const applying = Promise.withResolvers<void>();
    const applied: number[] = [];
    const {visit} = await workspace({
      async applyAction(action: number) {
        if (action === 1) {
          applying.resolve();
          await parked.promise;
        }
        applied.push(action);
      },
    });
    await visit(async impl => {
      holdStaging(impl);
      impl.storage.gatekeepers.put({id: GK2, class: {} as never});
      await impl.submitAction(GK, 1, description(), CHAT_A);
      await impl.submitAction(GK2, 2, description(), CHAT_A);
      const accept = impl.acceptBranch(1, impl.branchSnapshot(1), USER);
      await applying.promise;
      // Submitted while the first connection applies, before the second is listed.
      await impl.submitAction(GK2, 3, description(), CHAT_A);
      await impl.submitAction(GK2, 4, description(), STAGED);
      parked.resolve();
      await expect(accept).resolves.toBe(true);
      expect(applied).toEqual([1, 2]);
      expect([...impl.storage.actions.pendingByGatekeeper.get(GK2)]
          .map(r => r.type === "action" ? r.action : null)).toEqual([3, 4]);
    });
  });

  it("hands a gatekeeper that has adopted branches staging first, then the chat's, in one list",
      async () => {
    const gatekeeper = branchGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      holdStaging(impl);
      await impl.adoptsBranches(GK);
      await impl.submitAction(GK, 1, description(), CHAT_A);
      await impl.submitAction(GK, 2, description(), CHAT_B);
      await impl.submitAction(GK, 3, description(), STAGED);
      await impl.acceptBranch(1, impl.branchSnapshot(1), USER);
      expect(gatekeeper.calls).toEqual([{branch: "chat:1", actions: [3, 1]}]);
      expect(states(impl, 1, 2, 3)).toEqual(["approved", "pending", "approved"]);
    });
  });

  it("stops at a failure, naming the chat whose earlier action is in the way", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await impl.submitAction(GK, 1, description(), CHAT_B);
      await impl.submitAction(GK, 2, description(), CHAT_A);
      await impl.submitAction(GK, 3, description(), CHAT_A);
      gatekeeper.next.refuse = 2;

      await expect(impl.acceptBranch(1, impl.branchSnapshot(1), USER)).resolves.toBe(false);
      expect(states(impl, 1, 2, 3)).toEqual(["pending", "pending", "pending"]);
      expect(record(impl, 2).applyError).toEqual({
        message: 'Out of order. (The chat "Theirs" has an earlier pending action on this ' +
            "connection. Accept that chat's changes or deny the action, then try again.)",
        retryable: true,
      });

      // Once that chat is accepted, the retry goes through.
      delete gatekeeper.next.refuse;
      await impl.acceptBranch(2, impl.branchSnapshot(2), USER);
      await expect(impl.acceptBranch(1, impl.branchSnapshot(1), USER)).resolves.toBe(true);
      expect(gatekeeper.applied).toEqual([1, 2, 3]);
    });
  });

  it("stops at a staged action that fails, before the chat's own", async () => {
    const gatekeeper = branchGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      holdStaging(impl);
      await impl.adoptsBranches(GK);
      await impl.submitAction(GK, 1, description(), CHAT_A);
      await impl.submitAction(GK, 2, description(), STAGED);
      gatekeeper.next.fail = {action: 2, message: "Quota exceeded.", retryable: true};
      await expect(impl.acceptBranch(1, impl.branchSnapshot(1), USER)).resolves.toBe(false);
      expect(states(impl, 1, 2)).toEqual(["pending", "pending"]);
      // A gatekeeper that has adopted branches sees no other chat's actions: no hint.
      expect(record(impl, 2).applyError?.message).toBe("Quota exceeded.");
    });
  });

  it("is what mergeChanges() does first, and its failure is the outcome", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit, client} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await impl.submitAction(GK, 1, description(), CHAT_A);
      await impl.submitAction(GK, 2, description(), CHAT_A);
    });
    using overseer = await client();
    await visit(() => { gatekeeper.next.refuse = 2; });
    expect(await overseer.mergeChanges(1)).toEqual({outcome: "failed"});
    await visit(() => { delete gatekeeper.next.refuse; });
    expect(await overseer.mergeChanges(1)).toEqual({outcome: "merged"});
    await visit(impl => {
      expect(gatekeeper.applied).toEqual([1, 2]);
      expect(states(impl, 1, 2)).toEqual(["approved", "approved"]);
    });
  });

  it("applies nothing past the highest action the user was shown, which waits for the next",
      async () => {
    const GK2 = 8;
    const gatekeeper = legacyGatekeeper();
    const {visit, client} = await workspace(gatekeeper.facet);
    const through = await visit(async impl => {
      holdStaging(impl);
      impl.storage.gatekeepers.put({id: GK2, class: {} as never});
      await impl.submitAction(GK, 1, description(), CHAT_A);
      await impl.submitAction(GK, 2, description(), STAGED);
      await impl.submitAction(GK2, 3, description(), STAGED);
      const shown = impl.storage.nextActionId.get() - 1;
      // Submitted after the user looked: staging on a connection the chat has acted on, the
      // chat's own, and the chat's first on a connection where staging held one all along.
      await impl.submitAction(GK, 4, description(), STAGED);
      await impl.submitAction(GK, 5, description(), CHAT_A);
      await impl.submitAction(GK2, 6, description(), CHAT_A);
      return shown;
    });
    using overseer = await client();
    // Shown nothing pending, the user accepts nothing.
    expect(await overseer.mergeChanges(1, {through: -1})).toEqual({outcome: "merged"});
    expect(await visit(() => gatekeeper.applied)).toEqual([]);

    expect(await overseer.mergeChanges(1, {through})).toEqual({outcome: "merged"});
    await visit(impl => {
      expect(gatekeeper.applied).toEqual([1, 2]);
      expect(states(impl, 4, 5)).toEqual(["pending", "pending"]);
      expect([...impl.storage.actions.pendingByGatekeeper.get(GK2)]).toHaveLength(2);
    });
    // With no bound, as before, everything pending.
    expect(await overseer.mergeChanges(1)).toEqual({outcome: "merged"});
    expect(await visit(() => gatekeeper.applied)).toEqual([1, 2, 4, 5, 3, 6]);
  });

  it("cuts a list for a gatekeeper that has adopted branches at the same ID in every group",
      async () => {
    const gatekeeper = branchGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      holdStaging(impl);
      await impl.adoptsBranches(GK);
      await impl.submitAction(GK, 1, description(), CHAT_A);
      await impl.submitAction(GK, 2, description(), STAGED);
      const through = record(impl, 2).id;
      await impl.submitAction(GK, 3, description(), STAGED);
      await impl.submitAction(GK, 4, description(), CHAT_A);
      await impl.acceptBranch(1, impl.branchSnapshot(1, through), USER);
      await impl.acceptBranch(1, impl.branchSnapshot(1), USER);
      expect(gatekeeper.calls).toEqual([
        {branch: "chat:1", actions: [2, 1]},
        {branch: "chat:1", actions: [3, 4]},
      ]);
    });
  });

  it("is refused while a creation on the branch has no account chosen", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await impl.submitAction(GK, "create", description(), AGENT_A);
      await impl.submitAction(GK, 1, description(), CHAT_A);
      await expect(impl.acceptBranch(1, impl.branchSnapshot(1), USER))
          .rejects.toThrow("Choose one of your accounts");
      expect(gatekeeper.applied).toEqual([]);
    });
  });
});

describe("approving one action", () => {
  it("applies its chat's earlier actions and the older staged ones first, in ID order", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      holdStaging(impl);
      await impl.submitAction(GK, 1, description(), CHAT_A);
      await impl.submitAction(GK, 2, description(), STAGED);
      await impl.submitAction(GK, 3, description(), CHAT_B);
      await impl.submitAction(GK, 4, description(), CHAT_A);
      await impl.submitAction(GK, 5, description(), STAGED);
      await impl.applyPendingAction(record(impl, 4), USER, false);
      expect(gatekeeper.applied).toEqual([1, 2, 4]);
      expect(states(impl, 3, 5)).toEqual(["pending", "pending"]);
    });
  });
});

describe("auto-approval", () => {
  it("applies an awaited action at once when rules cover it and what it follows", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      enableRule(impl);
      await impl.submitAction(GK, 1, description(true), AGENT_A);
      await impl.submitAction(GK, 2, description(true, true), AGENT_A);
      await vi.waitFor(() => expect(states(impl, 1, 2)).toEqual(["approved", "approved"]));
      expect(impl.consumeCapturedActions(1)?.awaitDecision).toBe(false);
      expect(record(impl, 2)).toMatchObject({resolvedBy: RULE_OWNER, autoApproved: true});
    });
  });

  it("leaves an awaited action for a user when an earlier one needs one", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      enableRule(impl);
      await impl.submitAction(GK, 1, description(false), AGENT_A);
      await impl.submitAction(GK, 2, description(true, true), AGENT_A);
      expect(impl.consumeCapturedActions(1)?.awaitDecision).toBe(true);
      expect(states(impl, 1, 2)).toEqual(["pending", "pending"]);
      expect(gatekeeper.applied).toEqual([]);
    });
  });

  it("accepts a chat whose actions rules cover, as the users who enabled them", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await impl.submitAction(GK, 1, description(true), CHAT_A);
      await impl.submitAction(GK, 2, description(true), CHAT_A);
      await impl.autoAcceptBranch(1);
      expect(states(impl, 1, 2)).toEqual(["pending", "pending"]);  // no rule yet

      enableRule(impl);
      await impl.autoAcceptBranch(1);
      expect(states(impl, 1, 2)).toEqual(["approved", "approved"]);
      expect(record(impl, 2)).toMatchObject({resolvedBy: RULE_OWNER, autoApproved: true});
    });
  });

  it.each([
    ["one of its actions needs a user", async (impl: Impl) => {
      await impl.submitAction(GK, 3, description(false), CHAT_A);
    }],
    ["staging holds an action that failed on its connection",
        async (impl: Impl, gatekeeper: ReturnType<typeof legacyGatekeeper>) => {
      gatekeeper.next.refuse = 3;
      await impl.submitAction(GK, 3, description(true), STAGED);
      await impl.drainAutoApprovals(GK);
      expect(record(impl, 3).applyError?.message).toMatch(/^Out of order\./);
    }],
    ["holding is on in it", (impl: Impl) => {
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, holding: true});
    }],
    ["it proposes code changes", (impl: Impl) => {
      vi.spyOn(impl, "proposedChangeWorkpieceIds").mockReturnValue([5]);
    }],
    ["the workspace has read restricted data", (impl: Impl) => {
      impl.storage.containsRestrictedData.put(true);
    }],
  ])("accepts nothing when %s", async (_, arrange) => {
    const gatekeeper = legacyGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      enableRule(impl);
      await impl.submitAction(GK, 1, description(true), CHAT_A);
      await impl.submitAction(GK, 2, description(true), CHAT_A);
      await arrange(impl, gatekeeper);
      await impl.autoAcceptBranch(1);
      expect(states(impl, 1, 2)).toEqual(["pending", "pending"]);
      expect(gatekeeper.applied).toEqual([]);
    });
  });

  it("applies the awaited action a turn waits on once a rule covers it", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit, client} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await impl.submitAction(GK, 1, description(true, true), AGENT_A);
      expect(impl.consumeCapturedActions(1)?.awaitDecision).toBe(true);
      impl.addChatMessages(1, {type: "agent", id: "model", name: "Model"},
          [{type: "action", actionId: record(impl, 1).id}]);
    });
    using overseer = await client();
    await overseer.setAutoApprovedActionKind(GK, EDITS);
    await visit(impl => vi.waitFor(() => expect(states(impl, 1)).toEqual(["approved"])));
  });

  it("accepts idle chats once a rule is enabled", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit, client} = await workspace(gatekeeper.facet);
    await visit(impl => impl.submitAction(GK, 1, description(true), CHAT_A));
    using overseer = await client();
    await overseer.setAutoApprovedActionKind(GK, EDITS);
    await visit(impl => vi.waitFor(() => expect(states(impl, 1)).toEqual(["approved"])));
  });
});

describe("discarding a chat", () => {
  it("rejects its actions from a point in the chat, newest first, or all of them", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      for (const action of [1, 2, 3]) {
        await impl.submitAction(GK, action, description(), CHAT_A);
        impl.addChatMessages(1, USER, [{type: "action", actionId: record(impl, action).id}]);
      }
      await impl.submitAction(GK, 4, description(), CHAT_A);  // no message yet
      await impl.submitAction(GK, 5, description(), CHAT_B);
      const from = [...impl.storage.chats.list({prefix: chatKeyPrefix(1)})]
          .find(msg => msg.type === "action" && msg.actionId === record(impl, 2).id)!.sequence;

      await impl.discardBranch(1, from, USER);
      expect(gatekeeper.rejected).toEqual([3, 2]);
      expect(states(impl, 1, 2, 3, 4)).toEqual(["pending", "rejected", "rejected", "pending"]);

      await impl.discardBranch(1, 0, USER);
      expect(gatekeeper.rejected).toEqual([3, 2, 4, 1]);
      expect(states(impl, 1, 4, 5)).toEqual(["rejected", "rejected", "pending"]);
      expect(record(impl, 1).resolvedBy).toEqual(USER);
    });
  });

  it("rejects all of its actions when it is deleted", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit, client} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await impl.submitAction(GK, 1, description(), CHAT_A);
      await impl.submitAction(GK, 2, description(), CHAT_B);
    });
    using overseer = await client();
    await overseer.deleteChat(1);
    await visit(impl => {
      expect(states(impl, 1, 2)).toEqual(["rejected", "pending"]);
    });
  });

  it("refuses an action submitted to a deleted chat", async () => {
    const {visit} = await workspace(legacyGatekeeper().facet);
    await visit(async impl => {
      impl.storage.chatMeta.delete(1);
      await expect(impl.submitAction(GK, 1, description(), CHAT_A))
          .rejects.toThrow("its chat has been deleted");
      expect([...impl.storage.actions.list()]).toEqual([]);
    });
  });
});

describe("removing a connection", () => {
  it("rejects its pending actions", async () => {
    const {visit} = await workspace(legacyGatekeeper().facet);
    await visit(async impl => {
      await impl.submitAction(GK, 1, description(), CHAT_A);
      impl.removeGatekeeper(GK);
      expect(states(impl, 1)).toEqual(["rejected"]);
    });
  });
});

describe("staging", () => {
  it("applies a staged action at once, as the owner, whatever its verdict", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await impl.submitAction(GK, 1, description(false), CHAT_A);
      await impl.submitAction(GK, 2, description(false), STAGED);
      await impl.drainAutoApprovals(GK);
      expect(states(impl, 1, 2)).toEqual(["pending", "approved"]);
      expect(gatekeeper.applied).toEqual([2]);
      expect(record(impl, 2)).toMatchObject({resolvedBy: USER, autoApproved: true});
    });
  });

  it("holds staged actions while the workspace has read restricted data, until accepted",
      async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit, client} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      holdStaging(impl);
      await impl.submitAction(GK, 1, description(), STAGED);
      await impl.submitAction(GK, 2, description(), CHAT_A);
      await impl.submitAction(GK, 3, description(), STAGED);
      await impl.drainAutoApprovals(GK);
      expect(states(impl, 1, 2, 3)).toEqual(["pending", "pending", "pending"]);
    });
    using overseer = await client();
    expect((await overseer.getMetadata()).stagedActions).toBe(2);
    expect(await overseer.acceptStagedActions()).toEqual({outcome: "applied"});
    expect((await overseer.getMetadata()).stagedActions).toBeUndefined();
    await visit(impl => {
      expect(gatekeeper.applied).toEqual([1, 3]);
      expect(states(impl, 1, 2, 3)).toEqual(["approved", "pending", "approved"]);
      expect(record(impl, 3)).toMatchObject({resolvedBy: USER, autoApproved: false});
    });
  });

  it("is accepted up to the highest action the user was shown", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit, client} = await workspace(gatekeeper.facet);
    const through = await visit(async impl => {
      holdStaging(impl);
      await impl.submitAction(GK, 1, description(), STAGED);
      await impl.submitAction(GK, 2, description(), STAGED);
      const shown = record(impl, 2).id;
      await impl.submitAction(GK, 3, description(), STAGED);
      return shown;
    });
    using overseer = await client();
    expect(await overseer.acceptStagedActions(-1)).toEqual({outcome: "applied"});
    expect(await overseer.acceptStagedActions(through)).toEqual({outcome: "applied"});
    await visit(impl => {
      expect(gatekeeper.applied).toEqual([1, 2]);
      expect(states(impl, 3)).toEqual(["pending"]);
    });
    expect(await overseer.acceptStagedActions()).toEqual({outcome: "applied"});
    expect(await visit(() => gatekeeper.applied)).toEqual([1, 2, 3]);
  });

  it("holds what follows a staged action that failed, and retries it at the next apply",
      async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit, client} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      gatekeeper.next.refuse = 1;
      await impl.submitAction(GK, 1, description(), STAGED);
      await impl.drainAutoApprovals(GK);
      await impl.submitAction(GK, 2, description(), STAGED);
      await impl.drainAutoApprovals(GK);
      expect(states(impl, 1, 2)).toEqual(["pending", "pending"]);
      expect(record(impl, 1).applyError).toEqual({message: "Out of order.", retryable: true});
    });
    using overseer = await client();
    expect(await overseer.acceptStagedActions()).toEqual({outcome: "failed"});
    await visit(async impl => {
      delete gatekeeper.next.refuse;
      await impl.submitAction(GK, 3, description(), STAGED);
      await impl.drainAutoApprovals(GK);
      expect(gatekeeper.applied).toEqual([1, 2, 3]);
      expect(states(impl, 1, 2, 3)).toEqual(["approved", "approved", "approved"]);
      expect(record(impl, 1).applyError).toBeUndefined();
    });
  });

  it("rejects a staged action that can never apply, with what it takes along, and goes on",
      async () => {
    const calls: number[][] = [];
    const rejected: number[] = [];
    const {visit} = await workspace({
      async applyActions(_view: BranchView, actions: number[]): Promise<ApplyActionsResult> {
        calls.push(actions);
        return actions[0] === 1
          ? {applied: [], failed: {action: 1, message: "Gone.", retryable: false}}
          : {applied: actions};
      },
      async rejectAction(action: number) {
        rejected.push(action);
        return {rejected: [2]};
      },
    });
    await visit(async impl => {
      await impl.adoptsBranches(GK);
      // Submitted together, before the first at-once apply has the owner's profile to apply as.
      await impl.submitAction(GK, 1, description(), STAGED);
      await impl.submitAction(GK, 2, description(), STAGED);
      await impl.submitAction(GK, 3, description(), STAGED);
      await impl.drainAutoApprovals(GK);
      expect(states(impl, 1, 2, 3)).toEqual(["rejected", "rejected", "approved"]);
      expect(rejected).toEqual([1]);
      expect(calls).toEqual([[1, 2, 3], [3]]);
      expect(record(impl, 1)).toMatchObject({
        resolvedBy: USER, applyError: {message: "Gone.", retryable: false},
      });
    });
  });

  it("is discarded newest first, leaving the chats' actions",
      async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit, client} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      holdStaging(impl);
      await impl.submitAction(GK, 1, description(), STAGED);
      await impl.submitAction(GK, 2, description(), CHAT_A);
      await impl.submitAction(GK, 3, description(), STAGED);
    });
    using overseer = await client();
    await overseer.discardStagedActions();
    expect((await overseer.getMetadata()).stagedActions).toBeUndefined();
    await visit(impl => {
      expect(gatekeeper.rejected).toEqual([3, 1]);
      expect(states(impl, 1, 2, 3)).toEqual(["rejected", "pending", "rejected"]);
      expect(record(impl, 1).resolvedBy).toEqual(USER);
    });
  });

  it("is waited for by a chat's accept, which applies what staging still holds", async () => {
    const parked = Promise.withResolvers<void>();
    const applied: number[] = [];
    const {visit} = await workspace({
      async applyAction(action: number) {
        if (action === 1) await parked.promise;
        applied.push(action);
      },
    });
    await visit(async impl => {
      await impl.drainAutoApprovals(GK);  // the owner's profile, so the drain starts at once
      await impl.submitAction(GK, 1, description(), STAGED);
      await impl.submitAction(GK, 2, description(), CHAT_A);
      const accept = impl.acceptBranch(1, impl.branchSnapshot(1), USER);
      parked.resolve();
      await expect(accept).resolves.toBe(true);
      expect(applied).toEqual([1, 2]);
      expect(record(impl, 1)).toMatchObject({autoApproved: true});
    });
  });
});

describe("staging pending from before it applied at once", () => {
  const HOOK: GatekeeperCaller = {from: "hook", gadgetId: 9};

  it("is held, with what follows it, through rules and auto-accepts, until staging is accepted",
      async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit, client} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await upgradeWith(impl, async () => {
        await impl.submitAction(GK, 1, description(true), STAGED);
        await impl.submitAction(GK, 2, description(true), HOOK);
      });
      enableRule(impl);
      await impl.submitAction(GK, 3, description(true), STAGED);
      await impl.drainAutoApprovals(GK);
      await impl.submitAction(GK, 4, description(true), CHAT_A);
      await impl.autoAcceptBranch(1);
      await impl.submitAction(GK, 5, description(true, true), {from: "agent", chatId: 2});
      expect(impl.consumeCapturedActions(2)?.awaitDecision).toBe(true);
      expect(states(impl, 1, 2, 3, 4, 5)).toEqual(Array(5).fill("pending"));
      expect(gatekeeper.applied).toEqual([]);
    });
    using overseer = await client();
    expect((await overseer.getMetadata()).stagedActions).toBe(3);
    expect(await overseer.acceptStagedActions()).toEqual({outcome: "applied"});
    await visit(async impl => {
      expect(gatekeeper.applied).toEqual([1, 2, 3]);
      expect(states(impl, 1, 2, 3, 4)).toEqual(["approved", "approved", "approved", "pending"]);
      expect(record(impl, 1)).toMatchObject({resolvedBy: USER, autoApproved: false});
      await impl.submitAction(GK, 6, description(), STAGED);
      await impl.drainAutoApprovals(GK);
      expect(gatekeeper.applied).toEqual([1, 2, 3, 6]);
    });
  });

  it("is rejected by a discard, after which staging applies at once again", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit, client} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await upgradeWith(impl, () => impl.submitAction(GK, 1, description(), STAGED));
      await impl.submitAction(GK, 2, description(), STAGED);
      await impl.drainAutoApprovals(GK);
      expect(states(impl, 1, 2)).toEqual(["pending", "pending"]);
    });
    using overseer = await client();
    await overseer.discardStagedActions();
    await visit(async impl => {
      expect(gatekeeper.rejected).toEqual([2, 1]);
      await impl.submitAction(GK, 3, description(), STAGED);
      await impl.drainAutoApprovals(GK);
      expect(gatekeeper.applied).toEqual([3]);
    });
  });

  it("is released by denying it, and what followed it applies in order at the next apply",
      async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit, client} = await workspace(gatekeeper.facet);
    let held = 0;
    await visit(async impl => {
      await upgradeWith(impl, () => impl.submitAction(GK, 1, description(), STAGED));
      await impl.submitAction(GK, 2, description(), STAGED);
      await impl.drainAutoApprovals(GK);
      held = record(impl, 1).id;
    });
    using overseer = await client();
    await overseer.rejectAction(held);
    await visit(async impl => {
      expect(states(impl, 1, 2)).toEqual(["rejected", "pending"]);
      await impl.submitAction(GK, 3, description(), STAGED);
      await impl.drainAutoApprovals(GK);
      expect(gatekeeper.applied).toEqual([2, 3]);
    });
  });

  it("is applied by accepting a chat on its connection, ahead of the chat's own", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await upgradeWith(impl, () => impl.submitAction(GK, 1, description(), STAGED));
      await impl.submitAction(GK, 2, description(), CHAT_A);
      await expect(impl.acceptBranch(1, impl.branchSnapshot(1), USER)).resolves.toBe(true);
      expect(gatekeeper.applied).toEqual([1, 2]);
      expect(record(impl, 1)).toMatchObject({resolvedBy: USER, autoApproved: false});
    });
  });

  it("is nothing in a workspace that had none", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      await upgradeWith(impl, () => impl.submitAction(GK, 1, description(), CHAT_A));
      await impl.submitAction(GK, 2, description(), STAGED);
      await impl.drainAutoApprovals(GK);
      expect(states(impl, 1, 2)).toEqual(["pending", "approved"]);
    });
  });
});

describe("staging during a chat's accept", () => {
  it("applies a staged action submitted meanwhile after the chat's actions", async () => {
    const parked = Promise.withResolvers<void>();
    const applying = Promise.withResolvers<void>();
    const applied: number[] = [];
    const {visit} = await workspace({
      async applyAction(action: number) {
        if (action === 1) {
          applying.resolve();
          await parked.promise;
        }
        applied.push(action);
      },
    });
    await visit(async impl => {
      await impl.drainAutoApprovals(GK);  // the owner's profile, so the drain starts at once
      await impl.submitAction(GK, 1, description(), CHAT_A);
      const accept = impl.acceptBranch(1, impl.branchSnapshot(1), USER);
      await applying.promise;
      await impl.submitAction(GK, 2, description(), STAGED);
      await impl.drainAutoApprovals(GK);
      expect(applied).toEqual([]);
      parked.resolve();
      await expect(accept).resolves.toBe(true);
      await vi.waitFor(() => expect(applied).toEqual([1, 2]));
      expect(states(impl, 1, 2)).toEqual(["approved", "approved"]);
    });
  });
});

describe("gadgets", () => {
  const addGadget = (impl: Impl, id: number) => impl.storage.gadgets.put({
    type: "gadget", id, title: `G${id}`, created: new Date(0), bindingName: `G${id}`, bindings: {},
  } as never);
  const branchGadgets = (impl: Impl, chatId: number) =>
    impl.chatMetaForClient(impl.storage.chatMeta.get(chatId)!).branchGadgets;

  it("run on a chat's branch while it has pending actions, holding, or an agent invoked them",
      async () => {
    const {visit} = await workspace(legacyGatekeeper().facet);
    await visit(async impl => {
      holdStaging(impl);
      addGadget(impl, 10);
      addGadget(impl, 11);
      expect(branchGadgets(impl, 1)).toBeUndefined();

      // An agent turn's call puts the gadget on the branch.
      vi.spyOn(impl, "getGadgetFacet").mockResolvedValue({} as never);
      await impl.startGatekeeperSession({type: "gadget", id: 11}, AGENT_A);
      expect(branchGadgets(impl, 1)).toEqual([11]);
      expect(impl.getGadgetFacet).toHaveBeenCalledWith(11, 1);

      // A pending action on the branch puts every gadget there; a staged one does not.
      await impl.submitAction(GK, 1, description(), STAGED);
      expect(branchGadgets(impl, 2)).toBeUndefined();
      await impl.submitAction(GK, 2, description(), CHAT_B);
      const meta = impl.chatMetaForClient(impl.storage.chatMeta.get(2)!);
      expect(meta).toMatchObject({pendingActions: 1, branchGadgets: [10, 11]});
      await impl.discardBranch(2, 0, USER);
      expect(branchGadgets(impl, 2)).toBeUndefined();

      // So does holding.
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(2)!, holding: true});
      expect(branchGadgets(impl, 2)).toEqual([10, 11]);
    });
  });

  it("are sent again in a chat's metadata as its actions come and go", async () => {
    const {visit} = await workspace(legacyGatekeeper().facet);
    await visit(async impl => {
      const sent: (number | undefined)[] = [];
      impl.storage.chatMeta.subscribe({
        add: () => {},
        update: (_old, meta) => { sent.push(impl.chatMetaForClient(meta).pendingActions); },
        remove: () => {},
      });
      await impl.submitAction(GK, 1, description(), CHAT_A);
      await impl.discardBranch(1, 0, USER);
      expect(sent).toEqual([1, undefined]);
    });
  });

  it("restart on the branch a denial says was built on, or everywhere for a staged one",
      async () => {
    const {visit} = await workspace({
      async applyAction() {},
      async rejectAction() { return {restart: true}; },
    });
    await visit(async impl => {
      holdStaging(impl);
      addGadget(impl, 10);
      addGadget(impl, 11);
      await impl.submitAction(GK, 1, description(), CHAT_A);
      await impl.submitAction(GK, 2, description(), CHAT_A);
      await impl.submitAction(GK, 3, description(), STAGED);
      // Gadget 10 runs on chat 1's branch, and 11 outside any chat.
      await impl.getGadgetFacetFetcher(10, 1);
      await impl.getGadgetFacetFetcher(11);
      const abort = vi.spyOn(impl.ctx.facets, "abort");
      const aborted = () => abort.mock.calls.map(([name]) => name).toSorted();

      await impl.rejectPendingAction(record(impl, 1), USER);
      expect(aborted()).toEqual([impl.gadgetFacetName(10)]);
      abort.mockClear();
      await impl.rejectPendingAction(record(impl, 3), USER);
      expect(aborted()).toEqual([impl.gadgetFacetName(10), impl.gadgetFacetName(11)]);
    });
  });

  it("tell a chat's agent of a denial its simulated work was built on", async () => {
    const restart = {value: true};
    const run = async (caller: GatekeeperCaller) => {
      const {visit, client} = await workspace({
        async applyAction() {},
        async rejectAction() { return {restart: restart.value}; },
      });
      const id = await visit(async impl => {
        await impl.submitAction(GK, 1, description(), caller);
        return record(impl, 1).id;
      });
      using overseer = await client();
      await overseer.rejectAction(id);
      return visit(impl => [...impl.storage.chats.list({prefix: chatKeyPrefix(1)})]
          .filter(msg => msg.type === "actionDenied")
          .map(msg => msg.type === "actionDenied" && {actionId: msg.actionId, title: msg.title}));
    };
    expect(await run(AGENT_A))
        .toEqual([{actionId: expect.any(Number), title: "Set the value"}]);
    expect(await run(CHAT_A)).toHaveLength(1);
    restart.value = false;
    expect(await run(AGENT_A)).toEqual([]);
  });

  it("include a gadget created later, in the metadata of a chat that takes them all", async () => {
    const {visit} = await workspace(legacyGatekeeper().facet);
    await visit(async impl => {
      addGadget(impl, 10);
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, holding: true});
      const sent: (number[] | undefined)[] = [];
      impl.storage.chatMeta.subscribe({
        add: () => {},
        update: (_old, meta) => { sent.push(impl.chatMetaForClient(meta).branchGadgets); },
        remove: () => {},
      });
      addGadget(impl, 11);
      await vi.waitFor(() => expect(sent.at(-1)).toEqual([10, 11]));
    });
  });
});

describe("holding", () => {
  it("is turned on and off in a chat", async () => {
    const {client} = await workspace(legacyGatekeeper().facet);
    using overseer = await client();
    await overseer.setChatHolding(1, true);
    expect((await overseer.listChats()).find(chat => chat.id === 1)?.holding).toBe(true);
    await overseer.setChatHolding(1, false);
    expect((await overseer.listChats()).find(chat => chat.id === 1)?.holding).toBeUndefined();
  });
});
