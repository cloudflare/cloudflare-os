import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { ActionRecord, OverseerDurableObject } from "../src/overseer.js";

type GatekeeperCaller = ActionRecord["caller"];

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER: AiChatAuthorInfo = {type: "user", id: "owner", name: "Owner"};
const OWNER_USER_ID = "owner-user";
const AGENT: GatekeeperCaller = {from: "agent", chatId: 7};
const DESCRIPTION: ActionDescription = {
  title: "Export", description: "Export the selected data", implementsRevert: false,
  actionKind: {tag: "export", label: "Exports"}, autoApprovable: true, awaitDecision: true,
};

type Impl = OverseerDurableObject["impl"];

async function withWorkspace(test: (impl: Impl) => Promise<void>) {
  const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await test(instance["impl"]);
  });
}

function action(impl: Impl, id = 0) {
  const record = impl.storage.actions.get(id);
  if (record?.type !== "action") throw new Error("Expected queued action");
  return record;
}

async function latch(impl: Impl) {
  vi.spyOn(impl, "getSharingManager").mockResolvedValue({
    hasAnyShares: () => false,
  } as Awaited<ReturnType<Impl["getSharingManager"]>>);
  await impl.authorizeObservation(42, {
    title: "Sensitive read", description: "Owner-only data", prohibitAllSharing: true,
  }, AGENT);
}

function mockGatekeeper(impl: Impl) {
  impl.ownerId = OWNER_USER_ID;
  const applyAction = vi.fn(async () => {});
  vi.spyOn(impl, "getGatekeeperFacet").mockReturnValue({
    applyAction,
  } as ReturnType<Impl["getGatekeeperFacet"]>);
  return applyAction;
}

describe("sensitive workspace action approval", () => {
  afterEach(() => vi.restoreAllMocks());

  it("queues trusted agent actions as manual-only despite an enabled rule", async () => {
    await withWorkspace(async impl => {
      await latch(impl);
      impl.storage.autoApproveTags.put({gatekeeperId: 42,
        actionKind: DESCRIPTION.actionKind!, enabledBy: OWNER});
      const apply = mockGatekeeper(impl);
      await impl.submitAction(42, 100, DESCRIPTION, AGENT);
      const record = action(impl, 1); // sensitive observation occupies id 0
      expect(record).toMatchObject({state: "pending", description: {autoApprovable: false}});
      expect(DESCRIPTION.autoApprovable).toBe(true);
      expect(impl.consumeCapturedActions(7)).toMatchObject({awaitDecision: true});
      await impl.drainAutoApprovals(42);
      expect(apply).not.toHaveBeenCalled();
      await impl.applyPendingAction(record, OWNER, false, OWNER_USER_ID);
      expect(apply).toHaveBeenCalledWith(100);
      expect(action(impl, 1)).toMatchObject({state: "approved", resolvedBy: OWNER, autoApproved: false});
      expect(() => impl.getWebFetchEnv()).toThrow("prohibited from fetching");
      expect(impl.storage.prohibitAllSharing.get()).toBe(true);
    });
  });

  it.each<GatekeeperCaller>([
    {from: "gadget", chatId: 7},
    {from: "hook"},
    {from: "user", chatId: 7},
  ])("blocks $from submissions even with chat context", async caller => {
    await withWorkspace(async impl => {
      await latch(impl);
      await expect(impl.submitAction(42, 100, DESCRIPTION, caller)).rejects.toThrow("sensitive data");
      expect([...impl.storage.actions.list()]).toHaveLength(1);
    });
  });

  it("blocks old auto-eligible pending actions after latch, but permits manual agent apply", async () => {
    await withWorkspace(async impl => {
      await impl.submitAction(42, 100, DESCRIPTION, AGENT);
      const record = action(impl);
      expect(record.description.autoApprovable).toBe(true);
      await latch(impl);
      impl.storage.autoApproveTags.put({gatekeeperId: 42,
        actionKind: DESCRIPTION.actionKind!, enabledBy: OWNER});
      const apply = mockGatekeeper(impl);
      await impl.drainAutoApprovals(42);
      expect(apply).not.toHaveBeenCalled();
      await expect(impl.applyPendingAction(record, OWNER, true, undefined)).rejects.toThrow("manually approved agent");
      expect(action(impl).state).toBe("pending");
      await impl.applyPendingAction(record, OWNER, false, OWNER_USER_ID);
      expect(apply).toHaveBeenCalledTimes(1);
    });
  });

  it("checks sensitivity after the asynchronous admin-config read", async () => {
    await withWorkspace(async impl => {
      await impl.submitAction(42, 100, DESCRIPTION, AGENT);
      const apply = mockGatekeeper(impl);
      vi.spyOn(impl.env.BLUEPRINTS, "get").mockImplementationOnce(async () => {
        impl.storage.prohibitAllSharing.put(true);
        return null;
      });
      await expect(impl.applyPendingAction(action(impl), OWNER, true, undefined)).rejects.toThrow("manually approved agent");
      expect(apply).not.toHaveBeenCalled();
    });
  });

  it.each([
    [OWNER_USER_ID, false], ["former-collaborator", false], [undefined, false],
    [OWNER_USER_ID, true], ["former-collaborator", true], [undefined, true],
  ] as const)("requires current owner authority (%s, latch during await: %s)", async (userId, duringAwait) => {
    await withWorkspace(async impl => {
      await impl.submitAction(42, 100, DESCRIPTION, AGENT);
      const apply = mockGatekeeper(impl);
      const readingConfig = Promise.withResolvers<void>();
      const releaseConfig = Promise.withResolvers<void>();
      if (duringAwait) {
        vi.spyOn(impl.env.BLUEPRINTS, "get").mockImplementationOnce(async () => {
          readingConfig.resolve();
          await releaseConfig.promise;
          return null;
        });
      } else {
        impl.storage.prohibitAllSharing.put(true);
      }
      // Deliberately use the OWNER audit profile even for a stale collaborator: it is not authority.
      const pending = impl.applyPendingAction(action(impl), OWNER, false, userId);
      const checked = userId === OWNER_USER_ID
        ? expect(pending).resolves.toBeUndefined()
        : expect(pending).rejects.toThrow("approval from the workspace owner");
      if (duringAwait) {
        await readingConfig.promise;
        impl.storage.prohibitAllSharing.put(true);
        releaseConfig.resolve();
      }
      await checked;
      expect(apply).toHaveBeenCalledTimes(userId === OWNER_USER_ID ? 1 : 0);
      expect(action(impl).state).toBe(userId === OWNER_USER_ID ? "approved" : "pending");
    });
  });

  it.each<GatekeeperCaller>([
    {from: "gadget", chatId: 7}, {from: "hook"}, {from: "user", chatId: 7},
  ])("blocks manual apply of pre-latch $from actions", async caller => {
    await withWorkspace(async impl => {
      await impl.submitAction(42, 100, DESCRIPTION, caller);
      await latch(impl);
      const apply = mockGatekeeper(impl);
      await expect(impl.applyPendingAction(action(impl), OWNER, false, OWNER_USER_ID)).rejects.toThrow("manually approved agent");
      expect(apply).not.toHaveBeenCalled();
    });
  });
});
