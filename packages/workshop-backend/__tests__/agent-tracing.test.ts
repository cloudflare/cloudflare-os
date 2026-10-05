// Agent turns emit the spans Cloudflare's Agents dashboard reads (src/agent-tracing.ts). Drives
// real turns on a real OverseerDurableObject, with the model provider's HTTP API stubbed, and
// reads the spans back from the streaming tail worker in vitest.config.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata, AiModelConfig,
} from "@gadgets/workshop-shared/api";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { ActionRecord, AutoApproveTagRecord }
  from "../src/storage-schema/overseer-storage.js";

// The OverseerImpl members these tests drive; the class itself is private to overseer.ts.
interface OverseerInternals {
  env: Cloudflare.Env;
  ownerId: string;
  users: {
    idFromString(id: string): string;
    get(): {
      getChatContext(): Promise<{ profile: AiChatAuthorInfo, aiModel: AiModel }>;
      getCloudflareGatekeeperAccount(): Promise<null>;
      consumeDailyLlmCall(): Promise<{ withinLimits: boolean }>;
    };
  };
  storage: {
    chatMeta: { put(meta: AiChatMetadata): void };
    chats: { put(message: AiChatMessage): void };
    gatekeepers: { put(record: object): void };
    actions: { list(): Iterable<ActionRecord> };
    autoApproveTags: { put(record: AutoApproveTagRecord): void };
  };
  nextChatSequence(chatId: number): number;
  startAgent(chatId: number, aiModel: AiModel, initiator: AiChatAuthorInfo,
             initiatorUserId: string): void;
  deliverAgentCallback(chatId: number, methodName: string, args: unknown[],
                       initiatorUserId: string, initiatorModelId: string): Promise<void>;
  waitForAllAgentsToComplete(): Promise<void>;
  cancelAgent(chatId: number): void;
  submitAction(gatekeeperId: number, action: number, description: ActionDescription,
               caller: { from: "agent", chatId: number } | { from: "user" }): Promise<unknown>;
  drainAutoApprovals(gatekeeperId: number): Promise<void>;
  getGatekeeperFacet(): Promise<{ applyAction(): Promise<void> }>;
  applyPendingAction(record: ActionRecord, author: AiChatAuthorInfo, autoApproved: boolean)
      : Promise<void>;
}

interface AiModel {
  profile: AiChatAuthorInfo;
  config: AiModelConfig;
}

interface RecordedSpan {
  name: string;
  spanId: string;
  parentSpanId: string | undefined;
  attributes: Record<string, unknown>;
  closed: boolean;
}

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    SPAN_RECORDER: Service<{ spans(): RecordedSpan[] }>;
  }
}

const OWNER_USER_ID = "owner-user-do";
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const MODEL: AiChatAuthorInfo = { type: "agent", id: "claude", name: "Claude" };
const MODEL_ID = "claude-tracing-test";
const API_URL = "https://anthropic.test";
const CHAT_ID = 1;
// Stands in for anything the user or the model wrote; no span may carry it.
const SECRET = "sentinel-7f3a";

interface Turn {
  workspace: string;
  gadgetId: string;
  // The request that started the turn, which stays open until the turn ends.
  session: Promise<void>;
  // Resolves once the turn has started its first model request.
  requested: Promise<void>;
  // Lets that first request respond.
  release(): void;
}

type ContentBlock =
  | { type: "text", text: string }
  | { type: "tool_use", id: string, name: string, input: object };

// A streamed Anthropic Messages response, in the event order the API sends.
function anthropicResponse(
    blocks: ContentBlock[], stopReason: string,
    usage: { input: number, cacheRead: number, cacheWrite: number, output: number },
    model = MODEL_ID): Response {
  let events: Record<string, unknown>[] = [
    { type: "message_start", message: {
      id: `msg_${stopReason}`, type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: {
        input_tokens: usage.input, cache_read_input_tokens: usage.cacheRead,
        cache_creation_input_tokens: usage.cacheWrite, output_tokens: 1,
      },
    } },
    ...blocks.flatMap((block, index) => [
      block.type === "text"
        ? { type: "content_block_start", index, content_block: { type: "text", text: "" } }
        : { type: "content_block_start", index,
            content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } },
      block.type === "text"
        ? { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }
        : { type: "content_block_delta", index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage.output } },
    { type: "message_stop" },
  ];
  let body = events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  return new Response(body.join(""), {
    headers: { "content-type": "text/event-stream", "cf-aig-log-id": `log_${stopReason}` },
  });
}

// Stubs the provider to answer each model request with the next of `responses`, holding the first
// until the test releases it; a request aborted meanwhile fails the way a real fetch does.
function stubProvider(responses: (() => Response)[]): Pick<Turn, "requested" | "release"> {
  let release!: () => void;
  let released = new Promise<void>(resolve => { release = resolve; });
  let onRequested!: () => void;
  let requested = new Promise<void>(resolve => { onRequested = resolve; });
  let calls = 0;
  let realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== API_URL) return realFetch(input, init);
    let response = responses[calls++];
    if (response === undefined) throw new Error(`unexpected model request ${calls}`);
    if (calls === 1) {
      onRequested();
      let signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      await new Promise<void>((resolve, reject) => {
        void released.then(resolve);
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    }
    return response();
  });
  return { requested, release };
}

interface TurnOptions {
  config?: AiModelConfig;
  // Turns on the free-tier usage limit, which the owner has used up.
  usageLimited?: boolean;
}

// Seeds a chat whose owner asked something, then starts a turn from a request that stays open
// until the turn ends, as a Workshop browser session does.
function startTurn(responses: (() => Response)[], {
  config = { provider: "anthropic", model: MODEL_ID, apiToken: "test-key", apiUrl: API_URL },
  usageLimited = false,
}: TurnOptions = {}): Turn {
  let provider = stubProvider(responses);
  let workspace = `agent-tracing-${crypto.randomUUID()}`;
  let session = inOverseer(workspace, async impl => {
    if (usageLimited) impl.env = { ...impl.env, ENABLE_CLOUDFLARE_LIMITS: "true" };
    impl.ownerId = OWNER_USER_ID;
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({
        getChatContext: async () => ({ profile: OWNER, aiModel: { profile: MODEL, config } }),
        getCloudflareGatekeeperAccount: async () => null,
        consumeDailyLlmCall: async () => ({ withinLimits: false }),
      }),
    };
    impl.storage.chatMeta.put({
      id: CHAT_ID, title: "Chat", started: new Date(0), lastActive: new Date(0),
      activeAgent: MODEL,
    });
    impl.storage.chats.put({
      chatId: CHAT_ID, sequence: impl.nextChatSequence(CHAT_ID), timestamp: new Date(0),
      author: OWNER, type: "message", message: `Please look at ${SECRET}.`,
    });
    impl.startAgent(CHAT_ID, { profile: MODEL, config }, OWNER, OWNER_USER_ID);
    await impl.waitForAllAgentsToComplete();
  });
  let gadgetId = env.TEST_OVERSEER.idFromName(workspace).toString();
  return { workspace, gadgetId, session, ...provider };
}

async function inOverseer(
    name: string, fn: (impl: OverseerInternals) => Promise<void> | void): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(name);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // OverseerImpl is private to overseer.ts; OverseerInternals names the parts driven here.
    let internals = instance as unknown as { impl: OverseerInternals };
    await fn(internals.impl);
  });
}

// The spans of `turns` finished turns.
async function turnSpans(turn: Turn, turns = 1): Promise<RecordedSpan[]> {
  await turn.session;
  let spans: RecordedSpan[] = [];
  await vi.waitFor(async () => {
    spans = (await env.SPAN_RECORDER.spans())
        .filter(span => span.attributes["gen_ai.agent.id"] === turn.gadgetId);
    expect(spans.filter(span => span.name.startsWith("invoke_agent") && span.closed))
        .toHaveLength(turns);
  }, { timeout: 5000 });
  return spans;
}

function only(spans: RecordedSpan[], name: string): RecordedSpan {
  let matching = spans.filter(span => span.name === name);
  expect(matching).toHaveLength(1);
  return matching[0];
}

describe("agent tracing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("traces a whole turn in the dashboard's shape, though requests arrive mid-turn", async () => {
    let turn = startTurn([
      () => anthropicResponse([
        { type: "tool_use", id: "toolu_read", name: "readFile",
          input: { workpiece: "NOPE", filename: SECRET } },
        { type: "tool_use", id: "toolu_invalid", name: "readFile",
          input: { workpiece: "NOPE", filename: SECRET, startLine: 0 } },
        { type: "tool_use", id: "toolu_bogus", name: SECRET, input: { query: SECRET } },
      ], "tool_use", { input: 10, cacheRead: 80, cacheWrite: 5, output: 7 },
          `${MODEL_ID}-snapshot`),
      () => anthropicResponse([{ type: "text", text: `Done with ${SECRET}.` }], "end_turn",
          { input: 3, cacheRead: 120, cacheWrite: 0, output: 4 }),
    ]);
    await turn.requested;
    await inOverseer(turn.workspace, () => {});
    turn.release();

    let spans = await turnSpans(turn);
    let identity = {
      "gen_ai.agent.name": "workshop-agent",
      "gen_ai.agent.id": turn.gadgetId,
      "gen_ai.conversation.id": `${turn.gadgetId}:${CHAT_ID}`,
    };

    let root = only(spans, "invoke_agent workshop-agent");
    expect(root.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent", ...identity,
      "gen_ai.provider.name": "anthropic", "gen_ai.request.model": MODEL_ID,
      operation: "agent.run", gadgetId: turn.gadgetId, chatId: CHAT_ID, modelId: MODEL.id,
    });
    expect(root.attributes["error.type"]).toBeUndefined();

    let chats = spans.filter(span => span.name === `chat ${MODEL_ID}`);
    expect(chats.map(span => span.attributes)).toMatchObject([
      {
        "gen_ai.operation.name": "chat", ...identity,
        "gen_ai.provider.name": "anthropic", "gen_ai.request.model": MODEL_ID,
        "gen_ai.response.model": `${MODEL_ID}-snapshot`, "gen_ai.response.id": "msg_tool_use",
        "cloudflare.agents.response.finish_reason": "toolUse",
        "cloudflare.ai_gateway.log.id": "log_tool_use",
        // Input includes the cached prompt tokens.
        "gen_ai.usage.input_tokens": 95, "gen_ai.usage.output_tokens": 7,
        "gen_ai.usage.cache_read.input_tokens": 80, "gen_ai.usage.cache_creation.input_tokens": 5,
        "cloudflare.agents.usage.total_tokens": 102,
      },
      {
        "gen_ai.response.id": "msg_end_turn", "cloudflare.agents.response.finish_reason": "stop",
        "cloudflare.ai_gateway.log.id": "log_end_turn",
        "gen_ai.usage.input_tokens": 123, "gen_ai.usage.output_tokens": 4,
        "gen_ai.usage.cache_read.input_tokens": 120, "gen_ai.usage.cache_creation.input_tokens": 0,
        "cloudflare.agents.usage.total_tokens": 127,
      },
    ]);
    // The provider reported the requested model, which is not repeated as the response model.
    expect(chats[1].attributes["gen_ai.response.model"]).toBeUndefined();

    let toolSpans = new Map(spans.filter(span => span.name.startsWith("execute_tool"))
        .map(span => [span.attributes["gen_ai.tool.call.id"], span]));
    expect(toolSpans.size).toBe(3);
    expect(toolSpans.get("toolu_read")).toMatchObject({ name: "execute_tool readFile", attributes: {
      "gen_ai.operation.name": "execute_tool", ...identity,
      "gen_ai.tool.name": "readFile", "gen_ai.tool.type": "function", "error.type": "Error",
    } });
    // pi rejects invalid arguments before it runs the tool.
    expect(toolSpans.get("toolu_invalid")).toMatchObject({ name: "execute_tool readFile",
      attributes: { "gen_ai.tool.name": "readFile", "error.type": "rejected" } });
    // A tool that does not exist, under the name the model made up, which is not recorded.
    expect(toolSpans.get("toolu_bogus")).toMatchObject({ name: "execute_tool",
      attributes: { "error.type": "rejected" } });

    for (let span of spans) {
      expect(span.closed).toBe(true);
      if (span !== root) expect(span.parentSpanId).toBe(root.spanId);
      expect(JSON.stringify(span.attributes)).not.toContain(SECRET);
    }
  });

  it.each([
    { failure: "an HTTP error", errorType: "400", response: () => Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "bad" } },
        { status: 400 }) },
    // A refusal arrives in a 200 response, so no status names the failure.
    { failure: "a refusal", errorType: "_OTHER", response: () => anthropicResponse(
        [], "refusal", { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }) },
  ])("marks a model request that fails with $failure on the request and the turn",
      async ({ errorType, response }) => {
    let turn = startTurn([response]);
    turn.release();

    let spans = await turnSpans(turn);
    expect(only(spans, `chat ${MODEL_ID}`).attributes).toMatchObject({
      "cloudflare.agents.response.finish_reason": "error", "error.type": errorType,
    });
    expect(only(spans, "invoke_agent workshop-agent").attributes["error.type"]).toBe(errorType);
  });

  it("traces a turn that fails before it reaches a model", async () => {
    // A Workers AI model with no credentials, which getModel() refuses.
    let turn = startTurn([], { config: { provider: "cloudflare", model: "@cf/m", apiToken: "" } });

    let spans = await turnSpans(turn);
    expect(spans.map(span => span.name)).toEqual(["invoke_agent workshop-agent"]);
    expect(spans[0].attributes).toMatchObject({ modelId: MODEL.id, "error.type": "Error" });
  });

  it("traces a turn the usage limit blocks as failed", async () => {
    let turn = startTurn([], { usageLimited: true });

    let spans = await turnSpans(turn);
    expect(spans.map(span => span.name)).toEqual(["invoke_agent workshop-agent"]);
    expect(spans[0].attributes["error.type"]).toBe("usage_limit");
  });

  it("starts the chat's next turn beside the one before, not inside it", async () => {
    let reply = () => anthropicResponse([{ type: "text", text: "Done." }], "end_turn",
        { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 });
    let turn = startTurn([reply, reply]);
    await turn.requested;
    // A callback that arrives mid-turn waits for the turn to end, and its teardown starts the next.
    await inOverseer(turn.workspace, impl =>
        impl.deliverAgentCallback(CHAT_ID, "ping", [], OWNER_USER_ID, MODEL.id));
    turn.release();

    let [first, second] = (await turnSpans(turn, 2))
        .filter(span => span.name.startsWith("invoke_agent"));
    expect(second.parentSpanId).toBe(first.parentSpanId);
  });

  it("marks a stopped turn canceled, not failed", async () => {
    let turn = startTurn([() => anthropicResponse(
        [{ type: "text", text: "Never sent." }], "end_turn",
        { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 })]);
    await turn.requested;
    await inOverseer(turn.workspace, impl => impl.cancelAgent(CHAT_ID));

    let spans = await turnSpans(turn);
    for (let span of [only(spans, `chat ${MODEL_ID}`), only(spans, "invoke_agent workshop-agent")]) {
      expect(span.attributes["cloudflare.agents.canceled"]).toBe(true);
      expect(span.attributes["error.type"]).toBeUndefined();
    }
  });

  it("traces approval of actions an agent submits", async () => {
    let workspace = `agent-tracing-${crypto.randomUUID()}`;
    let gadgetId = env.TEST_OVERSEER.idFromName(workspace).toString();
    let poke = { tag: "poke", label: "Pokes" };
    await inOverseer(workspace, async impl => {
      impl.storage.gatekeepers.put({
        id: 7, resourceTitle: "Repository", class: {},
        creationSpec: {
          type: "gatekeeper", vendorId: "testvendor",
          resourceUrl: "https://example.com/repo", typeUrlPattern: "https://*",
        },
      });
      impl.storage.autoApproveTags.put({ gatekeeperId: 7, actionKind: poke, enabledBy: OWNER });
      impl.getGatekeeperFacet = async () => ({ applyAction: async () => {} });

      // A rule approves this action without a request. (Submitted first: a pending manual gate
      // holds back every later action of its connection.)
      await impl.submitAction(7, 1, {
        title: "Poke", description: "", implementsRevert: false, autoApprovable: true,
        actionKind: poke,
      }, { from: "agent", chatId: CHAT_ID });
      await impl.drainAutoApprovals(7);
      await impl.submitAction(7, 2, {
        title: `Send ${SECRET}`, description: SECRET, implementsRevert: false,
      }, { from: "agent", chatId: CHAT_ID });
      // Actions a user submits are not the agent's.
      await impl.submitAction(7, 3, {
        title: "Mine", description: "", implementsRevert: false,
      }, { from: "user" });

      let records = [...impl.storage.actions.list()];
      let action = (number: number) =>
          records.find(record => record.type === "action" && record.action === number);
      expect(action(1)?.state).toBe("approved");
      let manual = action(2);
      if (manual === undefined) throw new Error("the agent's action was not queued");
      await impl.applyPendingAction(manual, OWNER, false);
    });

    let approvals: RecordedSpan[] = [];
    await vi.waitFor(async () => {
      approvals = (await env.SPAN_RECORDER.spans()).filter(span =>
          span.name.startsWith("tool_approval") && span.attributes["gen_ai.agent.id"] === gadgetId);
      expect(approvals).toHaveLength(3);
    }, { timeout: 5000 });
    expect(approvals.map(span => [span.name, span.attributes])).toMatchObject([
      ["tool_approval testvendor", { "cloudflare.agents.tool.approval.state": "approved" }],
      ["tool_approval testvendor", {
        "gen_ai.operation.name": "execute_tool",
        "cloudflare.agents.operation.name": "tool.approval",
        "cloudflare.agents.tool.approval.state": "requested",
        "gen_ai.agent.name": "workshop-agent",
        "gen_ai.conversation.id": `${gadgetId}:${CHAT_ID}`,
        "gen_ai.tool.name": "testvendor",
      }],
      ["tool_approval testvendor", { "cloudflare.agents.tool.approval.state": "approved" }],
    ]);
    for (let span of approvals) expect(JSON.stringify(span.attributes)).not.toContain(SECRET);
  });
});
