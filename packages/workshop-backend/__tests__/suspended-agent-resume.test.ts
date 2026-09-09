import { describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo, AiChatMetadata, AiModelConfig } from "@gadgets/workshop-shared/api";
import { OverseerDurableObject, type ActionRecord } from "../src/overseer.js";
import type { UserAiModelRecord, UserChatContext } from "../src/user.js";

const CHAT_ID = 7;
const OWNER_USER_ID = "owner-user";
const OWNER_PROFILE_ID = "owner-profile";
const ORIGINAL_USER_ID = "original-user";
const ORIGINAL_MODEL_ID = "original-model";

const OWNER_PROFILE: AiChatAuthorInfo = {
  type: "user",
  id: OWNER_PROFILE_ID,
  name: "Approving Owner",
};

const ORIGINAL_INITIATOR: AiChatAuthorInfo = {
  type: "user",
  id: "original-profile",
  name: "Original Initiator",
};

const MODEL_CONFIG: AiModelConfig = {
  api: "openai",
  baseUrl: "https://models.example/v1",
  apiKey: "test-key",
  model: ORIGINAL_MODEL_ID,
};

const ORIGINAL_MODEL: UserAiModelRecord = {
  profile: { type: "agent", id: ORIGINAL_MODEL_ID, name: "Original Model" },
  config: MODEL_CONFIG,
};

type SuspendedAgentRecordForTest = {
  chatId: number;
  initiatorUserId: string;
  modelId: string;
  initiator: AiChatAuthorInfo;
  callbackInitiated: boolean;
  suspensionReason?: "connectionRequest" | "awaitDecision";
};

function makeUserMeta(aiModel: UserAiModelRecord): UserChatContext {
  return {
    profile: ORIGINAL_INITIATOR,
    aiModel,
    quickModel: undefined,
  };
}

function makeHarness(messages: object[], actions = new Map<number, ActionRecord>(), options: {
  originalGetChatContext?: (modelId: string | null) => Promise<UserChatContext>;
  gatekeepers?: Map<number, object>;
  suspensionReason?: "connectionRequest" | "awaitDecision";
  sensitive?: boolean;
  rejectAction?: () => Promise<void>;
} = {}) {
  let chatMeta: AiChatMetadata = {
    id: CHAT_ID,
    title: "Chat",
    started: new Date(0),
    lastActive: new Date(0),
  };
  let chatMessages = [...messages];
  let waitUntil: Promise<unknown>[] = [];
  let startAgent = vi.fn();
  let originalGetChatContext = vi.fn(options.originalGetChatContext ?? (async (modelId: string | null) => {
    expect(modelId).toBe(ORIGINAL_MODEL_ID);
    return makeUserMeta(ORIGINAL_MODEL);
  }));
  let ownerGetChatContext = vi.fn(async (_modelId: string | null) => ({
    profile: OWNER_PROFILE,
    aiModel: {
      profile: { type: "agent" as const, id: "owner-model", name: "Owner Model" },
      config: { ...MODEL_CONFIG, model: "owner-model" },
    },
    quickModel: undefined,
  }));

  let users = new Map<string, object>([
    [OWNER_USER_ID, {
      id: { toString: () => OWNER_USER_ID },
      getGadget: async () => ({ id: "workspace-id", title: "Workspace", created: new Date(0) }),
      getChatContext: ownerGetChatContext,
      whoami: async () => OWNER_PROFILE,
    }],
    [ORIGINAL_USER_ID, {
      id: { toString: () => ORIGINAL_USER_ID },
      getChatContext: originalGetChatContext,
      whoami: async () => ORIGINAL_INITIATOR,
    }],
  ]);
  let gatekeepers = options.gatekeepers ?? new Map<number, object>([[42, {
    id: 42,
    resourceTitle: "Repository",
    resourceUrl: "https://github.com/acme/repo",
    creationSpec: {
      type: "gatekeeper",
      vendorId: "github",
      resourceUrl: "https://github.com/acme/repo",
      typeUrlPattern: "https://github.com/:owner/:repo",
    },
  }]]);

  let suspended: SuspendedAgentRecordForTest | undefined = {
    chatId: CHAT_ID,
    initiatorUserId: ORIGINAL_USER_ID,
    modelId: ORIGINAL_MODEL_ID,
    initiator: ORIGINAL_INITIATOR,
    callbackInitiated: false,
    suspensionReason: options.suspensionReason ?? "awaitDecision" as const,
  };

  let impl: any = {
    ownerId: OWNER_USER_ID,
    ownerProfileId: OWNER_PROFILE_ID,
    isWorkspaceDeleting: () => false,
    withWorkspaceMutation: <T>(operation: () => Promise<T>) => operation(),
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    users: {
      idFromString: (id: string) => id,
      get: (id: string) => users.get(id),
    },
    ctx: {
      id: { toString: () => "workspace-id" },
      waitUntil: (promise: Promise<unknown>) => { waitUntil.push(promise); },
      exports: {
        AdminSettings: {
          getByName: () => ({ getFinanceWorkspaceClaim: async () => null }),
        },
      },
    },
    storage: {
      ownerId: { put: vi.fn() },
      title: { get: () => "Workspace" },
      prohibitAllSharing: { get: () => options.sensitive ?? false },
      chatMeta: {
        get: (id: number) => id === CHAT_ID ? chatMeta : undefined,
        put: (meta: AiChatMetadata) => { chatMeta = meta; },
      },
      chats: {
        list: ({ reverse }: { prefix?: string; reverse?: boolean } = {}) =>
          reverse ? chatMessages.toReversed() : [...chatMessages],
        put: (message: object) => {
          let sequence = (message as { sequence?: number }).sequence;
          let index = chatMessages.findIndex(existing =>
            sequence !== undefined && (existing as { sequence?: number }).sequence === sequence);
          if (index >= 0) chatMessages[index] = message;
          else chatMessages.push(message);
        },
      },
      suspendedAgents: {
        get: (id: number) => id === CHAT_ID ? suspended : undefined,
        put: (record: SuspendedAgentRecordForTest) => { suspended = record; },
        delete: (id: number) => { if (id === CHAT_ID) suspended = undefined; },
      },
      actions: {
        get: (id: number) => actions.get(id),
        put: (record: ActionRecord) => actions.set(record.id, record),
        list: () => [...actions.values()],
      },
      gatekeepers: {
        get: (id: number) => gatekeepers.get(id),
      },
    },
    ensureAmbientCapsules: async () => {},
    markOutputsDirty: vi.fn(),
    joinPresence: () => () => {},
    joinOutputsFanout: () => () => {},
    waitForChatMessagePreparation: () => undefined,
    getChatTimestamp: () => new Date(chatMessages.length + 1),
    startAgent,
    addChatMessages: vi.fn((chatId: number, author: AiChatAuthorInfo, bodies: object[]) => {
      for (let body of bodies) {
        chatMessages.push({ chatId, sequence: chatMessages.length + 1, timestamp: new Date(), author, ...body });
      }
    }),
    postAgentErrorMessage: vi.fn((chatId: number, author: AiChatAuthorInfo, message: string) => {
      chatMessages.push({ chatId, sequence: chatMessages.length + 1, timestamp: new Date(), author, type: "error", message });
    }),
    applyPendingAction: vi.fn(async (record: ActionRecord & { type: "action" }, resolvedBy: AiChatAuthorInfo) => {
      record.state = "approved";
      record.resolvedBy = resolvedBy;
      actions.set(record.id, record);
    }),
    drainAutoApprovals: vi.fn(async () => {}),
    getGatekeeperFacet: () => ({rejectAction: options.rejectAction ?? (async () => {})}),
  };

  impl.resumeSuspendedAgent = vi.fn(async (chatId: number) => {
    if (!suspended || chatMeta.activeAgent) return;
    let pendingAwaited = chatMessages
      .filter((msg): msg is { type: "action"; actionId: number } => (msg as { type?: string }).type === "action")
      .map(msg => actions.get(msg.actionId))
      .some(record => record?.type === "action" && record.caller.from === "agent" &&
          !!record.description.awaitDecision && record.state === "pending");
    if (pendingAwaited) return;
    try {
      let user = users.get(suspended.initiatorUserId) as { getChatContext(id: string): Promise<UserChatContext> };
      let userMeta = await user.getChatContext(suspended.modelId);
      if (!userMeta.aiModel) throw new Error("missing model");
      chatMeta.activeAgent = userMeta.aiModel.profile;
      startAgent(chatId, userMeta.aiModel, suspended.initiator, suspended.initiatorUserId);
    } catch {
      let author = suspended.initiator;
      suspended = undefined;
      impl.postAgentErrorMessage(chatId, author,
          "Agent could not be resumed because its AI model is no longer available.");
    }
  });

  impl.maybeResumeAfterActionDecision = vi.fn(async (chatId: number, author?: AiChatAuthorInfo) => {
    let awaited = chatMessages
      .filter((msg): msg is { type: "action"; actionId: number } => (msg as { type?: string }).type === "action")
      .map(msg => actions.get(msg.actionId))
      .filter((record): record is ActionRecord & { type: "action" } =>
        record?.type === "action" && record.caller.from === "agent" && !!record.description.awaitDecision);
    if (awaited.length === 0 || awaited.some(record => record.state === "pending") ||
        awaited.some(record => record.state === "rejected")) return;
    if (!chatMessages.some(msg => (msg as { type?: string; text?: string }).type === "agentNudge" &&
        (msg as { text?: string }).text === "approved")) {
      impl.addChatMessages(chatId, author ?? suspended?.initiator ?? OWNER_PROFILE,
          [{ type: "agentNudge", text: "approved" }]);
    }
    await impl.resumeSuspendedAgent(chatId);
  });

  let overseer = {
    open: OverseerDurableObject.prototype.open,
    impl,
  } satisfies Pick<OverseerDurableObject, "open"> & { impl: object };

  return {
    overseer,
    startAgent,
    waitUntil: async () => { await Promise.all(waitUntil); },
    ownerGetChatContext,
    originalGetChatContext,
    getChatMeta: () => chatMeta,
    getMessages: () => chatMessages,
    getSuspended: () => suspended,
  };
}

async function openOwnerClient(harness: ReturnType<typeof makeHarness>) {
  return await harness.overseer.open(
      OWNER_USER_ID, OWNER_PROFILE_ID, new NativeRpcStub<() => void>(() => {}));
}

describe("suspended agent resume identity", () => {
  it.each([
    ["approveAction", "approveAction"],
    ["approveAction", "rejectAction"],
    ["rejectAction", "approveAction"],
  ] as const)("serializes %s / %s with the real common apply guard", async (firstMethod, secondMethod) => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      const impl = instance["impl"];
      impl.ownerId = OWNER_USER_ID;
      impl.storage.prohibitAllSharing.put(true);
      impl.storage.actions.put({
        id: 99, type: "action", gatekeeperId: 42, caller: {from: "agent", chatId: CHAT_ID},
        createdAt: new Date(0), state: "pending", action: 123,
        description: {title: "Export", description: "Export data", implementsRevert: false},
      });
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const perform = vi.fn(async () => { started.resolve(); await release.promise; });
      const apply = vi.fn(async () => perform());
      const reject = vi.fn(async () => perform());
      const facet = vi.spyOn(impl, "getGatekeeperFacet").mockReturnValue({
        applyAction: apply,
      } as ReturnType<typeof impl.getGatekeeperFacet>);
      const harness = makeHarness([], new Map(), {sensitive: true, rejectAction: reject});
      // Keep the existing RPC client fixture, but use real storage, serialization, and apply code.
      harness.overseer.impl.storage.actions = impl.storage.actions;
      harness.overseer.impl.withWorkspaceMutation = impl.withWorkspaceMutation.bind(impl);
      harness.overseer.impl.applyPendingAction = impl.applyPendingAction.bind(impl);
      const client = await openOwnerClient(harness);
      try {
        const first = client[firstMethod](99);
        await started.promise;
        const second = client[secondMethod](99).then(
            () => undefined, (error: Error) => error.message);
        release.resolve();
        await first;
        expect(await second).toContain("not pending");
        await harness.waitUntil();
        expect(apply).toHaveBeenCalledTimes(firstMethod === "approveAction" ? 1 : 0);
        expect(reject).toHaveBeenCalledTimes(firstMethod === "rejectAction" ? 1 : 0);
        expect(impl.storage.actions.get(99)?.state).toBe(
            firstMethod === "approveAction" ? "approved" : "rejected");
      } finally {
        release.resolve();
        facet.mockRestore();
      }
    });
  });

  it("resumes an accepted connection request as the original initiator", async () => {
    let requestId = `${CHAT_ID}:request`;
    let harness = makeHarness([{
      type: "connectionRequest",
      chatId: CHAT_ID,
      sequence: 1,
      author: { type: "agent", id: ORIGINAL_MODEL_ID, name: "Original Model" },
      timestamp: new Date(0),
      requestId,
      vendorId: "github",
      vendorName: "GitHub",
      resourceTitle: "Repository",
      resourceUrlPattern: "https://github.com/:owner/:repo",
      reason: "Need repository access",
      state: "pending",
      bindingName: "REPO",
    }]);
    let client = await openOwnerClient(harness);

    await client.acceptConnectionRequest(requestId, { gatekeeperId: 42 });

    expect(harness.originalGetChatContext).toHaveBeenCalledWith(ORIGINAL_MODEL_ID);
    expect(harness.ownerGetChatContext).not.toHaveBeenCalled();
    expect(harness.getChatMeta().activeAgent).toEqual(ORIGINAL_MODEL.profile);
    expect(harness.startAgent).toHaveBeenCalledWith(
        CHAT_ID, ORIGINAL_MODEL, ORIGINAL_INITIATOR, ORIGINAL_USER_ID);
  });

  it("accepts a vendor-only Jira connection request after the user explicitly picks a resource", async () => {
    let requestId = `${CHAT_ID}:request`;
    let harness = makeHarness([{
      type: "connectionRequest",
      chatId: CHAT_ID,
      sequence: 1,
      author: { type: "agent", id: ORIGINAL_MODEL_ID, name: "Original Model" },
      timestamp: new Date(0),
      requestId,
      vendorId: "jira",
      vendorName: "Jira",
      reason: "Need Jira access; user should choose the site or issue.",
      state: "pending",
      bindingName: "JIRA",
    }], new Map(), {
      gatekeepers: new Map<number, object>([[42, {
        id: 42,
        resourceTitle: "Jira Issue",
        resourceUrl: "https://acme.atlassian.net/browse/ENG-1",
        creationSpec: {
          type: "gatekeeper",
          vendorId: "jira",
          resourceUrl: "https://acme.atlassian.net/browse/ENG-1",
          typeUrlPattern: "https://:site.atlassian.net/browse/:issueKey",
        },
      }]]),
      suspensionReason: "connectionRequest",
    });
    let client = await openOwnerClient(harness);

    await client.acceptConnectionRequest(requestId, { gatekeeperId: 42 });

    expect((harness.getMessages()[0] as { state?: string }).state).toBe("accepted");
    expect(harness.startAgent).toHaveBeenCalledWith(
        CHAT_ID, ORIGINAL_MODEL, ORIGINAL_INITIATOR, ORIGINAL_USER_ID);
  });

  it.each([false, true])("resumes an owner-approved awaitDecision action (sensitive: %s)", async sensitive => {
    let action: ActionRecord = {
      id: 99,
      type: "action",
      gatekeeperId: 42,
      caller: { from: "agent", chatId: CHAT_ID },
      createdAt: new Date(0),
      state: "pending",
      action: 123,
      description: {
        title: "Deploy",
        description: "Deploy the app",
        awaitDecision: true,
      },
    };
    let harness = makeHarness([{
      type: "action",
      chatId: CHAT_ID,
      sequence: 1,
      author: { type: "agent", id: ORIGINAL_MODEL_ID, name: "Original Model" },
      timestamp: new Date(0),
      actionId: action.id,
    }], new Map([[action.id, action]]), {sensitive});
    let client = await openOwnerClient(harness);

    await client.approveAction(action.id);
    await harness.waitUntil();

    expect(harness.overseer.impl.applyPendingAction).toHaveBeenCalledWith(
        action, OWNER_PROFILE, false, OWNER_USER_ID);
    expect(harness.originalGetChatContext).toHaveBeenCalledWith(ORIGINAL_MODEL_ID);
    expect(harness.ownerGetChatContext).not.toHaveBeenCalled();
    expect(harness.getChatMeta().activeAgent).toEqual(ORIGINAL_MODEL.profile);
    expect(harness.startAgent).toHaveBeenCalledWith(
        CHAT_ID, ORIGINAL_MODEL, ORIGINAL_INITIATOR, ORIGINAL_USER_ID);
  });

  it.each([false, true])("denies a sensitive agent action and ends the turn (notification fails: %s)", async fails => {
    let action: ActionRecord = {
      id: 99, type: "action", gatekeeperId: 42, caller: {from: "agent", chatId: CHAT_ID},
      createdAt: new Date(0), state: "pending", action: 123,
      description: {title: "Export", description: "Export data", implementsRevert: false,
        awaitDecision: true, autoApprovable: false},
    };
    let rejectAction = vi.fn(async () => { if (fails) throw new Error("Unavailable"); });
    let harness = makeHarness([], new Map([[action.id, action]]), {sensitive: true, rejectAction});
    let client = await openOwnerClient(harness);
    await client.rejectAction(action.id);
    expect(rejectAction).toHaveBeenCalledWith(123);
    expect(action).toMatchObject({state: "rejected", resolvedBy: OWNER_PROFILE});
    expect(harness.getSuspended()).toBeUndefined();
    expect(harness.startAgent).not.toHaveBeenCalled();
    expect(harness.overseer.impl.applyPendingAction).not.toHaveBeenCalled();
  });

  it("does not resume an accepted connection request until same-turn awaited actions are approved", async () => {
    let requestId = `${CHAT_ID}:request`;
    let action: ActionRecord = {
      id: 101,
      type: "action",
      gatekeeperId: 42,
      caller: { from: "agent", chatId: CHAT_ID },
      createdAt: new Date(0),
      state: "pending",
      action: 125,
      description: {
        title: "Deploy",
        description: "Deploy the app",
        awaitDecision: true,
      },
    };
    let harness = makeHarness([{
      type: "connectionRequest",
      chatId: CHAT_ID,
      sequence: 1,
      author: { type: "agent", id: ORIGINAL_MODEL_ID, name: "Original Model" },
      timestamp: new Date(0),
      requestId,
      vendorId: "github",
      vendorName: "GitHub",
      resourceTitle: "Repository",
      resourceUrlPattern: "https://github.com/:owner/:repo",
      reason: "Need repository access",
      state: "pending",
      bindingName: "REPO",
    }, {
      type: "action",
      chatId: CHAT_ID,
      sequence: 2,
      author: { type: "agent", id: ORIGINAL_MODEL_ID, name: "Original Model" },
      timestamp: new Date(0),
      actionId: action.id,
    }], new Map([[action.id, action]]), { suspensionReason: "connectionRequest" });
    let client = await openOwnerClient(harness);

    await client.acceptConnectionRequest(requestId, { gatekeeperId: 42 });

    expect(harness.startAgent).not.toHaveBeenCalled();
    expect(harness.getChatMeta().activeAgent).toBeUndefined();

    await client.approveAction(action.id);
    await harness.waitUntil();

    expect(harness.startAgent).toHaveBeenCalledTimes(1);
    expect(harness.startAgent).toHaveBeenCalledWith(
        CHAT_ID, ORIGINAL_MODEL, ORIGINAL_INITIATOR, ORIGINAL_USER_ID);
    expect(harness.getMessages().filter(msg =>
      (msg as { type?: string }).type === "agentNudge")).toHaveLength(1);
  });

  it("rechecks an early-approved awaitDecision action after the action card is flushed", async () => {
    let action: ActionRecord = {
      id: 100,
      type: "action",
      gatekeeperId: 42,
      caller: { from: "agent", chatId: CHAT_ID },
      createdAt: new Date(0),
      state: "pending",
      action: 124,
      description: {
        title: "Deploy",
        description: "Deploy the app",
        awaitDecision: true,
      },
    };
    let harness = makeHarness([], new Map([[action.id, action]]));
    let client = await openOwnerClient(harness);

    await client.approveAction(action.id);
    await harness.waitUntil();

    expect(harness.startAgent).not.toHaveBeenCalled();

    harness.getMessages().push({
      type: "action",
      chatId: CHAT_ID,
      sequence: 1,
      author: { type: "agent", id: ORIGINAL_MODEL_ID, name: "Original Model" },
      timestamp: new Date(0),
      actionId: action.id,
    });
    await (harness.overseer.impl as any).maybeResumeAfterActionDecision(CHAT_ID, ORIGINAL_INITIATOR);
    await (harness.overseer.impl as any).maybeResumeAfterActionDecision(CHAT_ID, ORIGINAL_INITIATOR);

    expect(harness.startAgent).toHaveBeenCalledTimes(1);
    expect(harness.getMessages().filter(msg =>
      (msg as { type?: string }).type === "agentNudge")).toHaveLength(1);
    expect(harness.startAgent).toHaveBeenCalledWith(
        CHAT_ID, ORIGINAL_MODEL, ORIGINAL_INITIATOR, ORIGINAL_USER_ID);
  });

  it("rejects an accepted connection result for a different gatekeeper capability", async () => {
    let requestId = `${CHAT_ID}:request`;
    let harness = makeHarness([{
      type: "connectionRequest",
      chatId: CHAT_ID,
      sequence: 1,
      author: { type: "agent", id: ORIGINAL_MODEL_ID, name: "Original Model" },
      timestamp: new Date(0),
      requestId,
      vendorId: "github",
      vendorName: "GitHub",
      resourceTitle: "Repository",
      resourceUrl: "https://github.com/acme/repo",
      resourceUrlPattern: "https://github.com/:owner/:repo",
      reason: "Need repository access",
      state: "pending",
      bindingName: "REPO",
    }], new Map(), {
      gatekeepers: new Map<number, object>([[42, {
        id: 42,
        resourceTitle: "Calendar",
        resourceUrl: "https://calendar.example/acme",
        creationSpec: {
          type: "gatekeeper",
          vendorId: "calendar",
          resourceUrl: "https://calendar.example/acme",
          typeUrlPattern: "https://calendar.example/:account",
        },
      }]]),
    });
    let client = await openOwnerClient(harness);

    await expect(client.acceptConnectionRequest(requestId, { gatekeeperId: 42 }))
      .rejects.toThrow("Accepted connection does not match");

    expect(harness.startAgent).not.toHaveBeenCalled();
    expect((harness.getMessages()[0] as { state?: string }).state).toBe("pending");
  });

  it("rejects an accepted connection result for a different requested resource", async () => {
    let requestId = `${CHAT_ID}:request`;
    let harness = makeHarness([{
      type: "connectionRequest",
      chatId: CHAT_ID,
      sequence: 1,
      author: { type: "agent", id: ORIGINAL_MODEL_ID, name: "Original Model" },
      timestamp: new Date(0),
      requestId,
      vendorId: "github",
      vendorName: "GitHub",
      resourceTitle: "Repository",
      resourceUrl: "https://github.com/acme/repo",
      resourceUrlPattern: "https://github.com/:owner/:repo",
      reason: "Need repository access",
      state: "pending",
      bindingName: "REPO",
    }], new Map(), {
      gatekeepers: new Map<number, object>([[42, {
        id: 42,
        resourceTitle: "Other Repository",
        resourceUrl: "https://github.com/evil/repo",
        creationSpec: {
          type: "gatekeeper",
          vendorId: "github",
          resourceUrl: "https://github.com/evil/repo",
          typeUrlPattern: "https://github.com/:owner/:repo",
        },
      }]]),
    });
    let client = await openOwnerClient(harness);

    await expect(client.acceptConnectionRequest(requestId, { gatekeeperId: 42 }))
      .rejects.toThrow("Accepted connection does not match the requested resource.");

    expect(harness.startAgent).not.toHaveBeenCalled();
    expect((harness.getMessages()[0] as { state?: string }).state).toBe("pending");
  });

  it("rejects an accepted connection result for a different requested resource type", async () => {
    let requestId = `${CHAT_ID}:request`;
    let harness = makeHarness([{
      type: "connectionRequest",
      chatId: CHAT_ID,
      sequence: 1,
      author: { type: "agent", id: ORIGINAL_MODEL_ID, name: "Original Model" },
      timestamp: new Date(0),
      requestId,
      vendorId: "github",
      vendorName: "GitHub",
      resourceTitle: "Repository",
      resourceUrlPattern: "https://github.com/:owner/:repo",
      reason: "Need repository access",
      state: "pending",
      bindingName: "REPO",
    }], new Map(), {
      gatekeepers: new Map<number, object>([[42, {
        id: 42,
        resourceTitle: "Organization",
        resourceUrl: "https://github.com/acme",
        creationSpec: {
          type: "gatekeeper",
          vendorId: "github",
          resourceUrl: "https://github.com/acme",
          typeUrlPattern: "https://github.com/:org",
        },
      }]]),
    });
    let client = await openOwnerClient(harness);

    await expect(client.acceptConnectionRequest(requestId, { gatekeeperId: 42 }))
      .rejects.toThrow("Accepted connection does not match the requested resource type.");

    expect(harness.startAgent).not.toHaveBeenCalled();
    expect((harness.getMessages()[0] as { state?: string }).state).toBe("pending");
  });

  it("clears a stale suspension and posts one error when resume model resolution fails", async () => {
    let requestId = `${CHAT_ID}:request`;
    let harness = makeHarness([{
      type: "connectionRequest",
      chatId: CHAT_ID,
      sequence: 1,
      author: { type: "agent", id: ORIGINAL_MODEL_ID, name: "Original Model" },
      timestamp: new Date(0),
      requestId,
      vendorId: "github",
      vendorName: "GitHub",
      resourceTitle: "Repository",
      resourceUrlPattern: "https://github.com/:owner/:repo",
      reason: "Need repository access",
      state: "pending",
      bindingName: "REPO",
    }], new Map(), {
      originalGetChatContext: async () => { throw new Error("model gone"); },
    });
    let client = await openOwnerClient(harness);

    await client.acceptConnectionRequest(requestId, { gatekeeperId: 42 });
    await client.acceptConnectionRequest(requestId, { gatekeeperId: 42 }).catch(() => undefined);

    expect(harness.getSuspended()).toBeUndefined();
    expect(harness.startAgent).not.toHaveBeenCalled();
    expect(harness.getMessages().filter(msg => (msg as { type?: string }).type === "error"))
      .toHaveLength(1);
  });
});
