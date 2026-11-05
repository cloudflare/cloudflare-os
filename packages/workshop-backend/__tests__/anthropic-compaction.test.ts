import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { z } from "zod";
import {
  createFauxCore, fauxAssistantMessage, fauxText, Type, type AssistantMessage, type Context,
  type Message,
} from "@earendil-works/pi-ai";
import type { AiChatAuthorInfo, AiChatMessage, AiChatMetadata } from "@gadgets/workshop-shared/api";
import { runAgent, type AgentHooks } from "../src/agent.js";
import { AgentTurnError, zeroUsage } from "../src/ai-invoke.js";
import { getModel } from "../src/ai-models.js";
import {
  requestAnthropicCompaction, withAnthropicCompactionBlock,
} from "../src/anthropic-compaction.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { GadgetRecord } from "../src/storage-schema/overseer-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Claude Sonnet 5.5 on a gateway whose binding answers with the queued Anthropic responses,
// recording each request's body and beta header. pi's own adapter builds and reads every request,
// so these tests see what Anthropic would.
function claude() {
  const bodies: Record<string, unknown>[] = [];
  const betas: string[][] = [];
  const responses: Response[] = [];
  const fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    betas.push((request.headers.get("anthropic-beta") ?? "").split(",").filter(Boolean));
    bodies.push(await request.json());
    return responses.shift() ?? new Response(null, { headers: { "content-type": "text/event-stream" } });
  });
  // Only the gateway settings and binding that getModel reads.
  const gatewayEnv = {
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
    CF_AI_GATEWAY_PROVIDERS: "anthropic",
    WORKERS_AI: { fetch },
  } as unknown as Cloudflare.Env;
  const handle = getModel(gatewayEnv,
      { provider: "anthropic", model: "claude-sonnet-5-5", apiToken: "" },
      { type: "user", id: "user-123", name: "User" });
  const respond = (...events: object[]) => {
    responses.push(new Response(sse(events), { headers: { "content-type": "text/event-stream" } }));
  };
  const fail = (status: number) => {
    responses.push(Response.json(
        { type: "error", error: { type: "rate_limit_error", message: "Slow down." } }, { status }));
  };
  return { handle, bodies, betas, respond, fail };
}

function sse(events: object[]): string {
  return [
    { type: "message_start", message: {
      id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [],
      stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 },
    } },
    ...events,
    { type: "message_stop" },
  ].map(event => {
    const { type } = z.object({ type: z.string() }).parse(event);
    return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  }).join("");
}

const Messages = z.array(z.object({ role: z.string(), content: z.unknown() }).loose());

/** Each message's role, with pi's effort-only system messages as "effort". */
function roles(body: Record<string, unknown> | undefined): string[] {
  return Messages.parse(body?.messages).map(message =>
    message.role === "system" && Array.isArray(message.content) && message.content.length === 0
      ? "effort" : message.role);
}

// The block as Anthropic returns it, with a field this code knows nothing about.
const BLOCK = {
  type: "compaction",
  content: "The user asked for a recipe app; the data model is agreed.",
  signature: "EuYBCkQY",
  tool_changes: [],
};
const SUMMARY_EVENTS = [
  { type: "content_block_start", index: 0, content_block: BLOCK },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "compaction" }, usage: {
    input_tokens: 0, output_tokens: 0,
    iterations: [{ type: "compaction", input_tokens: 1200, output_tokens: 80 }],
  } },
];
const REPLY_EVENTS = [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
];
const SUMMARY_TEXT = "<prior_conversation>summary</prior_conversation>";

const tool = {
  name: "readFile", description: "Read a file.", parameters: Type.Object({ path: Type.String() }),
};
const system: Message = {
  role: "system", content: "You are a coding agent.", toolsAdded: [tool], timestamp: 0,
};
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant", content, api: "anthropic-messages", provider: "anthropic",
  model: "claude-sonnet-5-5", usage: zeroUsage(), stopReason: "stop", timestamp: 0,
  providerThinkingLevel: "high",
});
const call = assistant([{ type: "toolCall", id: "call-1", name: "readFile", arguments: { path: "a" } }]);
const result: Message = {
  role: "toolResult", toolCallId: "call-1", toolName: "readFile",
  content: [{ type: "text", text: "contents" }], isError: false, timestamp: 0,
};

describe("Anthropic compaction", () => {
  it("has Anthropic write the summary, and sends its block back unchanged", async () => {
    const { handle, bodies, betas, respond } = claude();
    respond(...SUMMARY_EVENTS);
    const context: Context = { messages: [system, user("Plan a recipe app."), assistant([
      { type: "text", text: "Recipe, Ingredient and Step." },
    ])] };
    // What the request's trace records, which reads the result of the stream.
    let traced: AssistantMessage | undefined;
    const written = await requestAnthropicCompaction(handle, (model, request, options) => {
      const response = handle.stream(model, request, options);
      void response.result().then(message => { traced = message; });
      return response;
    }, context, "Write a handoff.", {});

    expect(written.summary).toBe(BLOCK.content);
    expect(JSON.parse(written.block)).toStrictEqual(BLOCK);
    expect(traced).toMatchObject({ stopReason: "stop", usage: { input: 1200, output: 80 } });
    expect(bodies[0]?.compaction).toStrictEqual({
      type: "summarize", instructions: "Write a handoff.\n\nDo not call tools.",
    });
    // The beta joins those pi sends rather than replacing them.
    expect(betas[0]).toContain("compact-2026-09-04");
    expect(betas[0]?.length).toBeGreaterThan(1);

    respond(...REPLY_EVENTS);
    const stream = withAnthropicCompactionBlock(handle.stream, written.block, SUMMARY_TEXT);
    const reply = await stream(handle.model, {
      messages: [system, user(SUMMARY_TEXT), user("Now add a Tag entity.")],
    }).result();

    expect(reply.stopReason).toBe("stop");
    expect(Messages.parse(bodies[1]?.messages)[0]).toStrictEqual(
        { role: "assistant", content: [BLOCK] });
    expect(JSON.stringify(bodies[1])).not.toContain("prior_conversation");
    expect(betas[1]).toContain("compact-2026-09-04");
  });

  // Thinking in the retained messages stays valid only if the summarized messages end as they did
  // in the request that produced the first retained one, and the retained ones follow the block.
  it("ends the summarized messages as the request that produced the next one did", async () => {
    const { handle, bodies, respond } = claude();
    respond(...SUMMARY_EVENTS);
    respond(...SUMMARY_EVENTS);
    const reply = assistant([{ type: "text", text: "Read it." }]);
    // The next retained message is a user's, which followed the assistant reply directly.
    await requestAnthropicCompaction(handle, handle.stream,
        { messages: [system, user("Read a."), call, result, reply] }, "Summarize.", {});
    // The next retained message is the step that the request ending in this tool result produced.
    await requestAnthropicCompaction(handle, handle.stream,
        { messages: [system, user("Read a."), call, result] }, "Summarize.", {});

    expect(roles(bodies[0]).at(-1)).toBe("assistant");
    expect(roles(bodies[1]).slice(-2)).toStrictEqual(["user", "effort"]);

    respond(...REPLY_EVENTS);
    await withAnthropicCompactionBlock(handle.stream, JSON.stringify(BLOCK), SUMMARY_TEXT)(
        handle.model, { messages: [system, user(SUMMARY_TEXT), call, result] }).result();
    expect(roles(bodies[2])).toStrictEqual(["assistant", "assistant", "user", "effort"]);
  });

  it("fails when the model ends without a summary", async () => {
    const { handle, respond } = claude();
    respond({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 0 } });
    await expect(requestAnthropicCompaction(handle, handle.stream,
        { messages: [system, user("Hello.")] }, "Summarize.", {}))
        .rejects.toThrow("no summary");
  });

  // The status lets the overseer tell an expected provider 4xx, such as a rate limit, from an
  // incident, as it does for any other failed model request.
  it("fails a rejected request with its HTTP status", async () => {
    const { handle, fail } = claude();
    fail(429);
    const request = requestAnthropicCompaction(handle, handle.stream,
        { messages: [system, user("Hello.")] }, "Summarize.", {});
    await expect(request).rejects.toBeInstanceOf(AgentTurnError);
    await expect(request).rejects.toMatchObject({ statusCode: 429 });
  });

  it("refuses a request that does not start with the summary it replaces", async () => {
    const { handle } = claude();
    const stream = withAnthropicCompactionBlock(handle.stream, JSON.stringify(BLOCK), SUMMARY_TEXT);
    const reply = await stream(handle.model, { messages: [system, user("Hello.")] }).result();
    expect(reply.stopReason).toBe("error");
    expect(reply.errorMessage).toContain("does not start with the compaction summary");
  });

  // Compacting again when nothing new follows the summary: pi marks the last message for caching,
  // which sends its text as a block rather than a string.
  it("finds the summary when it is the request's last message", async () => {
    const { handle, bodies, respond } = claude();
    respond(...SUMMARY_EVENTS);
    await requestAnthropicCompaction(handle,
        withAnthropicCompactionBlock(handle.stream, JSON.stringify(BLOCK), SUMMARY_TEXT),
        { messages: [system, user(SUMMARY_TEXT)] }, "Summarize.", {});
    expect(Messages.parse(bodies[0]?.messages)).toStrictEqual(
        [{ role: "assistant", content: [BLOCK] }]);
  });
});

// The OverseerImpl members these tests drive; the class itself is private to overseer.ts.
interface OverseerInternals extends AgentHooks {
  storage: {
    gadgets: { put(record: GadgetRecord): void };
    chatMeta: { put(meta: AiChatMetadata): void };
    chats: { put(message: AiChatMessage): void };
  };
  nextChatSequence(chatId: number): number;
}

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const AGENT: AiChatAuthorInfo = { type: "agent", id: "claude-sonnet-5-5", name: "Claude" };
const CHAT_ID = 1;
let doCounter = 0;

async function withImpl(fn: (impl: OverseerInternals) => Promise<void>): Promise<void> {
  const stub = env.TEST_OVERSEER.getByName(`anthropic-compaction-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // OverseerImpl is private to overseer.ts, so the object's `impl` field has no public type.
    const internals = instance as unknown as { impl: OverseerInternals };
    await fn(internals.impl);
  });
}

// The chat's timestamps are unique, so each seeded record is stamped with its sequence.
function post(impl: OverseerInternals, author: AiChatAuthorInfo, text: string): void {
  const sequence = impl.nextChatSequence(CHAT_ID);
  impl.storage.chats.put({
    chatId: CHAT_ID, sequence, timestamp: new Date(sequence), author, type: "message",
    message: text,
  });
}

describe("Anthropic compaction in a chat", () => {
  it("compacts through Anthropic, sends the block on later turns, and the text to other models",
      () => withImpl(async impl => {
    impl.storage.gadgets.put({
      type: "gadget", id: 100, title: "App", created: new Date(0), bindingName: "APP",
      bindings: {},
    });
    impl.storage.chatMeta.put(
        { id: CHAT_ID, title: "Chat", started: new Date(0), lastActive: new Date(0) });
    post(impl, OWNER, "Plan a recipe app.");
    post(impl, AGENT, "Recipe, Ingredient and Step.");
    post(impl, OWNER, "Add tags.");
    post(impl, AGENT, "Added a Tag entity.");
    const compact = impl.nextChatSequence(CHAT_ID);
    impl.storage.chats.put({
      chatId: CHAT_ID, sequence: compact, timestamp: new Date(compact), author: OWNER,
      type: "slashCommand", request: { id: { builtin: true, commandId: "compact" }, args: "" },
    });

    const { handle, bodies, respond } = claude();
    const claudeTurn = () => runAgent(impl, handle, CHAT_ID, AGENT, new AbortController().signal,
        OWNER, { provider: "anthropic", model: "claude-sonnet-5-5", apiToken: "" });

    // `/compact` on a short chat keeps only the newest record, the agent's last reply, and has
    // Anthropic summarize the messages before it.
    respond(...SUMMARY_EVENTS);
    await claudeTurn();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.compaction).toBeDefined();
    const summarized = JSON.stringify(bodies[0]?.messages);
    expect(summarized).toContain("Add tags.");
    expect(summarized).not.toContain("Added a Tag entity.");
    const checkpoint = impl.loadChatHistory(CHAT_ID).checkpoint;
    expect(checkpoint?.summary).toBe(BLOCK.content);
    expect(JSON.parse(checkpoint?.anthropicCompactionBlock ?? "null")).toStrictEqual(BLOCK);

    post(impl, OWNER, "Now add search.");
    respond(...REPLY_EVENTS);
    await claudeTurn();
    const turn = Messages.parse(bodies[1]?.messages);
    expect(turn[0]).toStrictEqual({ role: "assistant", content: [BLOCK] });
    expect(JSON.stringify(turn[1])).toContain("Added a Tag entity.");
    expect(JSON.stringify(turn)).not.toContain("Add tags.");
    expect(JSON.stringify(turn)).not.toContain("prior_conversation");

    // A model that can't read the block gets the summary text in its place.
    post(impl, OWNER, "And sorting?");
    const faux = createFauxCore({ models: [{ id: "faux-model" }] });
    faux.setResponses([fauxAssistantMessage(fauxText("Sorted."))]);
    const contexts: Context[] = [];
    await runAgent(impl, {
      model: faux.getModel(),
      stream: (model, context, options) => {
        contexts.push(context);
        return faux.stream(model, context, options);
      },
    }, CHAT_ID, { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal,
        OWNER, { provider: "cloudflare", model: "faux-model", apiToken: "" });
    const summary = contexts[0]?.messages.find(message => message.role === "user");
    expect(summary?.content).toContain("<prior_conversation");
    expect(summary?.content).toContain(BLOCK.content);
  }));
});
