import { describe, expect, it, vi } from "vitest";
import { env, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  AgentTurnWorkflow,
  OverseerDurableObject,
  type AgentTurnWorkflowParams,
} from "../src/overseer.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const EVENT: Readonly<WorkflowEvent<AgentTurnWorkflowParams>> = {
  payload: { overseerId: "workspace-id", chatId: 17 },
  timestamp: new Date("2026-08-14T00:00:00Z"),
  instanceId: "workflow-id",
  workflowName: "workshop-backend-agent-turn",
};

function makeWorkflow(overseer: {
  prepareAgentWorkflow: (
    chatId: number,
    workflowId: string,
  ) => Promise<"running" | "complete">;
  failAgentWorkflow: (chatId: number, workflowId: string) => Promise<void>;
}): AgentTurnWorkflow {
  let workflow = Object.create(AgentTurnWorkflow.prototype) as AgentTurnWorkflow;
  Object.assign(workflow, {
    ctx: {
      exports: {
        OverseerDurableObject: {
          idFromString: (id: string) => id,
          get: () => overseer,
        },
      },
    },
  });
  return workflow;
}

function immediateStep(names: string[]): WorkflowStep {
  return {
    do: async (name: string, _config: unknown, callback: () => Promise<unknown>) => {
      names.push(name);
      return callback();
    },
    waitForEvent: async (name: string) => {
      names.push(name);
      return { payload: { chatId: 17 } };
    },
  } as unknown as WorkflowStep;
}

describe("AgentTurnWorkflow", () => {
  it("waits for completion after adopting a running turn", async () => {
    let names: string[] = [];
    let prepareAgentWorkflow = vi.fn(async () => "running" as const);
    let failAgentWorkflow = vi.fn(async () => {});

    await makeWorkflow({prepareAgentWorkflow, failAgentWorkflow})
      .run(EVENT, immediateStep(names));

    expect(names).toEqual(["prepare agent turn", "wait for agent turn"]);
    expect(prepareAgentWorkflow).toHaveBeenCalledWith(17, "workflow-id");
    expect(failAgentWorkflow).not.toHaveBeenCalled();
  });

  it("finishes when the turn completed before adoption", async () => {
    let names: string[] = [];
    let prepareAgentWorkflow = vi.fn(async () => "complete" as const);
    let failAgentWorkflow = vi.fn(async () => {});

    await makeWorkflow({prepareAgentWorkflow, failAgentWorkflow})
      .run(EVENT, immediateStep(names));

    expect(names).toEqual(["prepare agent turn"]);
    expect(failAgentWorkflow).not.toHaveBeenCalled();
  });

  it("clears the turn after Workflow preparation exhausts its retries", async () => {
    let names: string[] = [];
    let error = new Error("Durable Object unavailable");
    let prepareAgentWorkflow = vi.fn(async () => { throw error; });
    let failAgentWorkflow = vi.fn(async () => {});

    await expect(makeWorkflow({prepareAgentWorkflow, failAgentWorkflow})
      .run(EVENT, immediateStep(names))).rejects.toBe(error);

    expect(names).toEqual(["prepare agent turn", "mark agent turn failed"]);
    expect(failAgentWorkflow).toHaveBeenCalledWith(17, "workflow-id");
  });
});

type TestActiveAgentRecord = {
  chatId: number;
  workflowId: string;
  workflowPromoteAt?: number;
  workflowPromotionAttempts?: number;
  workflowStarted?: boolean;
  initiatorUserId: string;
  modelId: string;
  initiator: {type: "user"; id: string; name: string};
  callbackInitiated: boolean;
};

type TestAgentWorkflowCompletionNotification = {
  workflowId: string;
  chatId: number;
  nextAttemptAt: number;
  expiresAt: number;
  attempts: number;
};

type TestOverseerImpl = {
  env: Record<string, unknown>;
  storage: {
    activeAgents: {
      get(chatId: number): TestActiveAgentRecord | undefined;
      put(record: TestActiveAgentRecord): void;
      delete(chatId: number): void;
    };
    agentWorkflowCompletionNotifications: {
      get(workflowId: string): TestAgentWorkflowCompletionNotification | undefined;
      put(record: TestAgentWorkflowCompletionNotification): void;
      delete(workflowId: string): void;
    };
  };
  ctx: { storage: { deleteAlarm(): void; getAlarm(): Promise<number | null> } };
  handleAlarm(): Promise<void>;
  removeDeletedAgentTurn(chatId: number): void;
};

const TEST_INITIATOR = {type: "user", id: "user-id", name: "Test User"} as const;

function activeRecord(overrides: Partial<TestActiveAgentRecord> = {}): TestActiveAgentRecord {
  return {
    chatId: 17,
    workflowId: "workflow-id",
    initiatorUserId: "user-object-id",
    modelId: "model-id",
    initiator: TEST_INITIATOR,
    callbackInitiated: false,
    ...overrides,
  };
}

async function withPromotionTest(
    name: string,
    create: (request: unknown) => Promise<unknown>,
    callback: (impl: TestOverseerImpl) => Promise<void>,
    get: (workflowId: string) => Promise<unknown> = async () => {
      throw new Error("Workflow not found");
    },
): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(name);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as {impl: TestOverseerImpl}).impl;
    Object.assign(impl.env, {
      AGENT_TURN_WORKFLOW: {create, get},
    });
    try {
      await callback(impl);
    } finally {
      impl.storage.activeAgents.delete(17);
      impl.storage.agentWorkflowCompletionNotifications.delete("workflow-id");
      impl.ctx.storage.deleteAlarm();
    }
  });
}

describe("lazy agent Workflow promotion", () => {
  it("returns without creating a Workflow before the grace deadline", async () => {
    let create = vi.fn(async () => ({}));
    await withPromotionTest("workflow-not-due", create, async impl => {
      impl.storage.activeAgents.put(activeRecord({workflowPromoteAt: Date.now() + 60_000}));

      await impl.handleAlarm();

      expect(create).not.toHaveBeenCalled();
      expect(impl.storage.activeAgents.get(17)?.workflowStarted).not.toBe(true);
    });
  });

  it("promotes a turn only after its grace deadline", async () => {
    let create = vi.fn(async () => ({}));
    await withPromotionTest("workflow-due", create, async impl => {
      impl.storage.activeAgents.put(activeRecord({workflowPromoteAt: Date.now() - 1}));

      await impl.handleAlarm();

      expect(create).toHaveBeenCalledWith({
        id: "workflow-id",
        params: {overseerId: expect.any(String), chatId: 17},
      });
      expect(impl.storage.activeAgents.get(17)).toMatchObject({workflowStarted: true});
      expect(impl.storage.activeAgents.get(17)?.workflowPromoteAt).toBeUndefined();
    });
  });

  it("adopts an existing Workflow when create reports a duplicate", async () => {
    let create = vi.fn(async () => { throw new Error("already exists"); });
    let get = vi.fn(async () => ({}));
    await withPromotionTest("workflow-existing", create, async impl => {
      impl.storage.activeAgents.put(activeRecord({workflowPromoteAt: Date.now() - 1}));

      await impl.handleAlarm();

      expect(get).toHaveBeenCalledWith("workflow-id");
      expect(impl.storage.activeAgents.get(17)).toMatchObject({workflowStarted: true});
    }, get);
  });

  it("retains the turn and schedules retry after transient promotion failure", async () => {
    let create = vi.fn(async () => { throw new Error("Workflow unavailable"); });
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withPromotionTest("workflow-retry", create, async impl => {
        impl.storage.activeAgents.put(activeRecord({workflowPromoteAt: Date.now() - 1}));

        let before = Date.now();
        await impl.handleAlarm();

        expect(impl.storage.activeAgents.get(17)).toMatchObject({
          workflowId: "workflow-id",
          workflowPromotionAttempts: 1,
        });
        expect(impl.storage.activeAgents.get(17)!.workflowPromoteAt).toBeGreaterThan(before);
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("clears a recovered turn after promotion remains unavailable", async () => {
    let create = vi.fn(async () => { throw new Error("Workflow unavailable"); });
    let error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withPromotionTest("workflow-recovery-exhausted", create, async impl => {
        impl.storage.activeAgents.put(activeRecord({
          workflowPromoteAt: Date.now() - 1,
          workflowPromotionAttempts: 4,
        }));

        await impl.handleAlarm();

        expect(create).toHaveBeenCalledOnce();
        expect(impl.storage.activeAgents.get(17)).toBeUndefined();
      });
    } finally {
      error.mockRestore();
    }
  });

  it("delivers and removes a queued completion notification", async () => {
    let create = vi.fn(async () => ({}));
    let sendEvent = vi.fn(async () => {});
    await withPromotionTest("workflow-completion", create, async impl => {
      impl.storage.agentWorkflowCompletionNotifications.put({
        workflowId: "workflow-id",
        chatId: 17,
        nextAttemptAt: Date.now() - 1,
        expiresAt: Date.now() + 60_000,
        attempts: 0,
      });

      await impl.handleAlarm();

      expect(sendEvent).toHaveBeenCalledWith({
        type: "agent-turn-complete",
        payload: {chatId: 17},
      });
      expect(impl.storage.agentWorkflowCompletionNotifications.get("workflow-id"))
        .toBeUndefined();
      expect(await impl.ctx.storage.getAlarm()).toBeNull();
    }, async () => ({sendEvent}));
  });

  it("retains a completion notification when delivery needs retry", async () => {
    let create = vi.fn(async () => ({}));
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withPromotionTest("workflow-completion-retry", create, async impl => {
        impl.storage.agentWorkflowCompletionNotifications.put({
          workflowId: "workflow-id",
          chatId: 17,
          nextAttemptAt: Date.now() - 1,
          expiresAt: Date.now() + 60_000,
          attempts: 0,
        });

        let before = Date.now();
        await impl.handleAlarm();

        expect(impl.storage.agentWorkflowCompletionNotifications.get("workflow-id"))
          .toMatchObject({attempts: 1});
        expect(impl.storage.agentWorkflowCompletionNotifications.get("workflow-id")!
          .nextAttemptAt).toBeGreaterThan(before);
      }, async () => ({
        sendEvent: async () => { throw new Error("Workflow unavailable"); },
      }));
    } finally {
      warn.mockRestore();
    }
  });

  it("releases a started Workflow when its chat is deleted", async () => {
    let create = vi.fn(async () => ({}));
    await withPromotionTest("workflow-chat-delete", create, async impl => {
      impl.storage.activeAgents.put(activeRecord({workflowStarted: true}));

      impl.removeDeletedAgentTurn(17);

      expect(impl.storage.activeAgents.get(17)).toBeUndefined();
      expect(impl.storage.agentWorkflowCompletionNotifications.get("workflow-id"))
        .toMatchObject({workflowId: "workflow-id", chatId: 17, attempts: 0});
    });
  });
});
