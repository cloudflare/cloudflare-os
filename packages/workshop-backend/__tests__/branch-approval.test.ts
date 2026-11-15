// The branch approval model (plans/forking-reality.md, behind the BRANCH_APPROVAL setting):
// accepting a chat applies what staging holds on its connections and then the chat's actions,
// discarding or deleting it rejects them, auto-approval accepts a chat whose actions rules cover
// all of, and an awaited action keeps a decision of its own. The gatekeeper facets are plain
// objects, as in apply-actions.test.ts; packages/integration-tests drives real ones and real turns.

import { env, RpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplyActionsResult, BranchView } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer";
import type { UserDurableObject } from "../src/user";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations";
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
// whose facet is `facet`, running the branch approval model unless `on` is false.
async function workspace(facet: object, on = true) {
  const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const user = env.TEST_USER.getByName(crypto.randomUUID());
  await runInDurableObject(user, instance => { instance["storage"].profile.put(USER); });
  await user.newWorkspace(stub.id.toString(), "Branches");
  const visit = <T>(fn: (impl: Impl) => T | Promise<T>) =>
    runInDurableObject(env.TEST_OVERSEER.get(stub.id), ({impl}) => {
      vi.spyOn(impl, "branchApproval", "get").mockReturnValue(on);
      return fn(impl);
    });
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

const enableRule = (impl: Impl) =>
  impl.storage.autoApproveTags.put({gatekeeperId: GK, actionKind: EDITS, enabledBy: RULE_OWNER});

describe("accepting a chat", () => {
  it("applies staging on its connection and then its own actions, in ID order, one at a time",
      async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
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

  it("leaves actions alone with the model off", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit, client} = await workspace(gatekeeper.facet, false);
    await visit(impl => impl.submitAction(GK, 1, description(), CHAT_A));
    using overseer = await client();
    expect(await overseer.mergeChanges(1)).toEqual({outcome: "merged"});
    await visit(impl => {
      expect(gatekeeper.applied).toEqual([]);
      expect(states(impl, 1)).toEqual(["pending"]);
    });
  });
});

describe("approving one action", () => {
  it("applies its chat's earlier actions and the older staged ones first, in ID order", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
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
  it("applies a staged action at submit, but leaves a chat's for its accept", async () => {
    const gatekeeper = legacyGatekeeper();
    const {visit} = await workspace(gatekeeper.facet);
    await visit(async impl => {
      enableRule(impl);
      await impl.submitAction(GK, 1, description(true), CHAT_A);
      await impl.submitAction(GK, 2, description(true), STAGED);
      await vi.waitFor(() => expect(states(impl, 2)).toEqual(["approved"]));
      expect(states(impl, 1)).toEqual(["pending"]);
      expect(gatekeeper.applied).toEqual([2]);
    });
  });

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
    ["staging holds an action that needs one on its connection", async (impl: Impl) => {
      await impl.submitAction(GK, 3, description(false), STAGED);
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
      await arrange(impl);
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
  it.each([[true, "rejected"], [false, "pending"]] as const)(
      "with the model %s leaves its pending actions %s", async (on, state) => {
    const {visit} = await workspace(legacyGatekeeper().facet, on);
    await visit(async impl => {
      await impl.submitAction(GK, 1, description(), CHAT_A);
      impl.removeGatekeeper(GK);
      expect(states(impl, 1)).toEqual([state]);
    });
  });
});
