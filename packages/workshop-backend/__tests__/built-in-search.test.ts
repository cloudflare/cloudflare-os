// Built-in web search through pi's own adapters. Each model here is a gateway model whose binding
// answers with queued streams, so a request's body is what the provider would get, and the events
// are read as pi 1.6.0 hands them on. A pi release that changes either fails here first.
//
// The streams in built-in-search-fixtures/ are responses the providers sent on 2026-11-24 to
// requests this code built, through an AI Gateway, untrimmed unless a fixture says otherwise:
// - openai-search: gpt-6-luna searches (one call, two queries), opens a page of its index, and
//   answers with a link.
// - openai-search-tool-call: gpt-6-luna searches, then calls listBlueprints.
// - anthropic-search-answer: claude-haiku-5-5 thinks, searches, thinks, and answers with one
//   cited passage (run a4 of plans/built-in-web-search.md).
// - anthropic-search-tool-call: it thinks, searches, thinks, and calls listBlueprints (run a2).
// - anthropic-unanswered-search: it calls listBlueprints and starts a search in one step, which
//   ends the response before the search is answered (run a3).
// - anthropic-pause: asked for twelve searches one at a time with no cap on them, it runs ten
//   and Anthropic pauses the turn on the eleventh, unanswered (run p2). Sent directly, since
//   this code always caps the searches. Trimmed: each search's ten results are cut to the first.
// A `.content.json` beside an Anthropic stream is that response's content: the stream's events
// put together by the script that captured them, which Anthropic accepted back unchanged.

import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import { Type } from "typebox";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata, AiChatStreamEvent, AiModelConfig,
} from "@gadgets/workshop-shared/api";
import { WEB_SEARCH_VENDOR_ID } from "@gadgets/workshop-shared/web-search-gatekeeper";
import { runAgent, type AgentHooks } from "../src/agent.js";
import { completeText } from "../src/ai-invoke.js";
import { getModel, type ModelHandle } from "../src/ai-models.js";
import {
  WEB_SEARCH_FEE, withBuiltInSearch, type BuiltInSearchRecord,
} from "../src/built-in-search.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import type {
  ActionRecord, AiChatAgentContext, GadgetRecord, GatekeeperRecord,
} from "../src/storage-schema/overseer-storage.js";
import ANSWER_CONTENT from "./built-in-search-fixtures/anthropic-search-answer.content.json";
import ANSWER from "./built-in-search-fixtures/anthropic-search-answer.sse.txt";
import PAUSE_CONTENT from "./built-in-search-fixtures/anthropic-pause.content.json";
import PAUSE from "./built-in-search-fixtures/anthropic-pause.sse.txt";
import TOOL_CALL_CONTENT from "./built-in-search-fixtures/anthropic-search-tool-call.content.json";
import TOOL_CALL from "./built-in-search-fixtures/anthropic-search-tool-call.sse.txt";
import UNANSWERED from "./built-in-search-fixtures/anthropic-unanswered-search.sse.txt";
import OPENAI_SEARCH from "./built-in-search-fixtures/openai-search.sse.txt";
import OPENAI_SEARCH_TOOL_CALL from "./built-in-search-fixtures/openai-search-tool-call.sse.txt";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const USER: AiChatAuthorInfo = { type: "user", id: "user-123", name: "User" };
const GPT: AiModelConfig = { provider: "openai", model: "gpt-6-luna", apiToken: "", webSearch: true };

type Body = Record<string, unknown>;
// A queued answer: a stream, or what a provider that reads the request's body says to it.
type Answer = string | ((body: Body) => Response);

// A model on the deployment's gateway, or on `routing`'s, whose requests the queued answers
// meet in order.
function gateway(config: AiModelConfig, routing?: Parameters<typeof getModel>[3]) {
  const bodies: Body[] = [];
  const answers: Answer[] = [];
  const fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const body: Body = await new Request(input, init).json();
    bodies.push(body);
    const answer = answers.shift();
    if (answer === undefined) throw new Error("The provider received more requests than queued.");
    return typeof answer === "string"
      ? new Response(answer, { headers: { "content-type": "text/event-stream" } }) : answer(body);
  });
  // Only the gateway settings and binding that getModel reads.
  const gatewayEnv = {
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
    CF_AI_GATEWAY_PROVIDERS: "anthropic,openai",
    WORKERS_AI: { fetch },
  } as unknown as Cloudflare.Env;
  const handle = getModel(gatewayEnv, config, USER, { sessionAffinity: "chat-1", ...routing });
  return { handle, bodies, respond: (...queued: Answer[]) => { answers.push(...queued); }, fetch };
}

// Server-sent events, each named by its type as Anthropic and OpenAI name theirs.
type Event = { type: string; [field: string]: unknown };
const sse = (events: Event[]) =>
    events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

// An OpenAI response with no output, for a request whose answer a test does not read.
const OPENAI_DONE = sse([{
  type: "response.completed",
  response: {
    id: "response", status: "completed", output: [],
    usage: { input_tokens: 100, output_tokens: 1, total_tokens: 101 },
  },
}]);

// An OpenAI response that says `text`, as the summary a compaction asks for.
function openAiText(text: string): string {
  const item = {
    type: "message", id: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return sse([
    { type: "response.output_item.added", output_index: 0,
      item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: {
      id: "response", status: "completed", output: [item],
      usage: { input_tokens: 100, output_tokens: 1, total_tokens: 101 },
    } },
  ]);
}

const system: Message = {
  role: "system", content: "You are a coding agent.", timestamp: 0,
  toolsAdded: [{
    name: "listBlueprints", description: "List the blueprints a gadget can be made from.",
    parameters: Type.Object({}),
  }],
};
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const QUESTION = user("What is the latest stable release of Wrangler?");

// The tools of a request's body, by their `type`.
const toolTypes = (body: Record<string, unknown> | undefined) =>
    (Array.isArray(body?.tools) ? body.tools : [])
        .map((tool: { type?: string }) => tool.type);

// What a stream's searches were recorded as.
function recorder() {
  const records: BuiltInSearchRecord[] = [];
  return { records, observe: (...record: BuiltInSearchRecord) => { records.push(record); } };
}

describe("OpenAI's web search tool", () => {
  it("is declared cache-only with its cap, and everything it did is recorded once", async () => {
    const { handle, bodies, respond } = gateway(GPT);
    respond(OPENAI_SEARCH);
    const { records, observe } = recorder();
    const search = withBuiltInSearch(handle.stream, () => true, observe);
    const answer = await search.stream(handle.model, { messages: [system, QUESTION] }).result();

    expect(answer.stopReason).toBe("stop");
    expect(bodies[0]?.tools).toStrictEqual([{ type: "web_search", external_web_access: false }]);
    expect(bodies[0]?.max_tool_calls).toBe(5);

    // One search of two queries, then a page of OpenAI's index.
    expect(records).toHaveLength(2);
    const [[, searchUrl, searched], [pageTitle, pageUrl, page]] = records;
    expect(searchUrl).toBeUndefined();
    expect(searched.fields).toStrictEqual([{ label: "Queries", kind: "list", items: [
      "Cloudflare Wrangler CLI latest stable release npm wrangler",
      "site:github.com/cloudflare/workers-sdk/releases Wrangler latest release",
    ] }]);
    expect(pageUrl).toBe("https://github.com/cloudflare/workers-sdk/releases");
    expect(pageTitle).toContain("github.com");
    expect(page.fields).toStrictEqual(
        [{ label: "URL", kind: "inline", value: "https://github.com/cloudflare/workers-sdk/releases" }]);
    // The chat labels a record's row "Read", then the record's title.
    expect([searched.title, page.title].filter(title => title.startsWith("Read")))
        .toStrictEqual([]);
    // Only the search is charged for.
    expect(search.searched).toStrictEqual({ billed: 1 });
  });

  it("charges the searches OpenAI counted, and the completed ones where it gives no count",
      async () => {
    const counted = '"web_search":{"num_requests":1}';
    expect(OPENAI_SEARCH).toContain(counted);
    const billed = async (response: string) => {
      const { handle, respond } = gateway(GPT);
      respond(response);
      const search = withBuiltInSearch(handle.stream, () => true, () => {});
      await search.stream(handle.model, { messages: [system, QUESTION] }).result();
      return search.searched?.billed;
    };

    // A search OpenAI did not charge for still completed.
    expect(await billed(OPENAI_SEARCH.replaceAll(counted, '"web_search":{"num_requests":0}')))
        .toBe(0);
    expect(await billed(OPENAI_SEARCH.replaceAll(counted, '"web_search":{}'))).toBe(1);
  });

  it("records what the provider and the model chose as data, and every call whatever came of it",
      async () => {
    const { handle, respond } = gateway(GPT);
    const done = (action: object | undefined, status = "completed") => sse([{
      type: "response.output_item.done",
      item: { id: "ws_1", type: "web_search_call", status, action },
    }]);
    respond(
        done({ type: "search", queries: ["<img src=x> [a](javascript:alert(1))"] }) +
        done({ type: "find_in_page", url: "javascript:alert(1)", pattern: "**bold**" }) +
        done({ type: "summon" }) +
        done({ type: "search", queries: ["wrangler"] }, "failed") +
        done(undefined, "incomplete") +
        OPENAI_DONE);
    const { records, observe } = recorder();
    const search = withBuiltInSearch(handle.stream, () => true, observe);
    await search.stream(handle.model, { messages: [system, QUESTION] }).result();

    expect(records.map(([, url]) => url)).toStrictEqual(Array(5).fill(undefined));
    const [[, , searched], [, , page], [, , unknown], [, , failed], [, , cut]] = records;
    expect(searched.description).not.toContain("img");
    expect(searched.fields).toStrictEqual(
        [{ label: "Queries", kind: "list", items: ["<img src=x> [a](javascript:alert(1))"] }]);
    expect(page.description).not.toContain("bold");
    expect(page.fields?.map(field => "value" in field ? field.value : undefined))
        .toStrictEqual(["javascript:alert(1)", "**bold**"]);
    expect(unknown.description).toContain("summon");
    expect(unknown.fields).toBeUndefined();
    // A call that failed, and one cut short before its action was written, may have sent a query.
    expect(failed.fields).toStrictEqual([
      { label: "Queries", kind: "list", items: ["wrangler"] },
      { label: "Status", kind: "inline", value: "failed" },
    ]);
    expect(cut.fields).toStrictEqual([{ label: "Status", kind: "inline", value: "incomplete" }]);
    // Only the search that completed is charged for.
    expect(search.searched).toStrictEqual({ billed: 1 });
  });

  it("cannot start a search in a cache-warm resend", async () => {
    const { handle, bodies, respond } = gateway(GPT);
    respond(OPENAI_SEARCH, OPENAI_DONE);
    const search = withBuiltInSearch(handle.stream, () => true, async () => {});
    await search.stream(handle.model, { messages: [system, QUESTION] }).result();
    await handle.lastRequest?.resend();

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toStrictEqual({ ...bodies[0], max_output_tokens: 16, tool_choice: "none" });
  });

  it.each([
    { name: "a model whose admin left it off", config: { ...GPT, webSearch: false } },
    { name: "a workspace that is not offered it", offered: false },
    { name: "a user's own gateway", routing: { userGateway: { accountId: "user-account", apiKey: "key" } } },
    { name: "a provider with no such tool",
      config: { provider: "cloudflare", model: "@cf/zai-org/glm-5.2", apiToken: "", webSearch: true } },
  ] as const)("is not declared for $name", async ({ config = GPT, offered = true, routing }) => {
    const bodies: Record<string, unknown>[] = [];
    // A user's gateway is reached with the global fetch, so the request is captured there.
    const fetch: typeof globalThis.fetch = async (input, init) => {
      bodies.push(await new Request(input, init).json());
      return new Response(OPENAI_DONE, { headers: { "content-type": "text/event-stream" } });
    };
    const { handle } = gateway(config, routing);
    const search = withBuiltInSearch(handle.stream, () => offered, async () => {});
    await search.stream(handle.model, { messages: [system, QUESTION] }, { fetch }).result();

    expect(bodies).toHaveLength(1);
    expect(toolTypes(bodies[0])).not.toContain("web_search");
    expect(bodies[0]?.max_tool_calls).toBeUndefined();
  });

  // An endpoint can send search events in answer to a request that declared no tool: a user's
  // own endpoint, for example. Nothing is then recorded, charged or kept. A Claude answer still
  // lists the pages it cites, which it also does when it cites an earlier search.
  it.each([
    { name: "a model with the tool off", stream: OPENAI_SEARCH, config: { ...GPT, webSearch: false } },
    { name: "a chat that is not offered it", stream: OPENAI_SEARCH, config: GPT, offered: false },
    { name: "an effort the tool is refused for", stream: OPENAI_SEARCH,
      config: { ...GPT, model: "gpt-5", reasoning: "minimal" } },
    { name: "a user's own gateway", stream: OPENAI_SEARCH, config: GPT,
      routing: { userGateway: { accountId: "user-account", apiKey: "key" } } },
    { name: "a Claude model with the tool off", stream: ANSWER,
      config: { provider: "anthropic", model: "claude-haiku-5-5", apiToken: "" }, cited: true },
  ] as const)("reads no search from a response to a request that declared no tool: $name",
      async ({ stream, config, offered = true, routing, cited = false }) => {
    const bodies: Record<string, unknown>[] = [];
    // A user's gateway is reached with the global fetch, so the request is answered there.
    const fetch: typeof globalThis.fetch = async (input, init) => {
      bodies.push(await new Request(input, init).json());
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    };
    const { handle } = gateway(config, routing);
    const { records, observe } = recorder();
    const search = withBuiltInSearch(handle.stream, () => offered, observe);
    const message =
        await search.stream(handle.model, { messages: [system, QUESTION] }, { fetch }).result();

    expect(bodies).toHaveLength(1);
    expect(toolTypes(bodies[0]).join()).not.toContain("web_search");
    expect(message.stopReason).toBe("stop");
    expect(records).toStrictEqual([]);
    expect(search.searched).toBeUndefined();
    expect(message).not.toHaveProperty("providerContent");
    expect(search.sources !== undefined).toBe(cited);
  });

  // OpenAI refuses the tool for a request whose reasoning effort is "minimal". The level "off"
  // is sent to gpt-5 as that effort too, because the model cannot stop reasoning.
  it.each([
    { reasoning: "minimal", effort: "minimal", declared: false },
    { reasoning: "off", effort: "minimal", declared: false },
    { reasoning: "low", effort: "low", declared: true },
  ] as const)("is declared at the level $reasoning, sent as the effort $effort: $declared",
      async ({ reasoning, effort, declared }) => {
    const { handle, bodies, respond } = gateway({ ...GPT, model: "gpt-5", reasoning });
    respond(OPENAI_DONE, OPENAI_DONE);
    const search = withBuiltInSearch(handle.stream, () => true, async () => {});
    await search.stream(handle.model, { messages: [system, QUESTION] }).result();
    await completeText(handle, { prompt: "Reply with OK.", webSearch: true, thinking: true });

    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.reasoning).toMatchObject({ effort });
      expect(toolTypes(body).includes("web_search")).toBe(declared);
      expect(body.max_tool_calls).toBe(declared ? 5 : undefined);
    }
    // The agent's own tools are sent either way.
    expect(toolTypes(bodies[0])).toContain("function");
  });

  it("is declared by a one-shot request only when it asks, as the admin's model test does",
      async () => {
    const { handle, bodies, respond } = gateway(GPT);
    respond(OPENAI_DONE, OPENAI_DONE);
    await completeText(handle, { prompt: "Name this chat." });
    await completeText(handle, { prompt: "Reply with OK.", webSearch: true });

    expect(toolTypes(bodies[0])).toStrictEqual([]);
    expect(toolTypes(bodies[1])).toStrictEqual(["web_search"]);
  });
});

const CLAUDE: AiModelConfig =
    { provider: "anthropic", model: "claude-haiku-5-5", apiToken: "", webSearch: true };
const SSE = { headers: { "content-type": "text/event-stream" } };

// An Anthropic response made of `events`, for what no captured stream holds.
const claudeStream = (...events: Event[]) => sse([
  { type: "message_start", message: {
    id: "msg", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [],
    stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 },
  } },
  ...events,
  { type: "message_stop" },
]);
// The events of a tool call's block, whose input Anthropic streams as JSON text.
const called = (index: number, { input, ...call }: Record<string, unknown>): Event[] => [
  { type: "content_block_start", index, content_block: { ...call, input: {} } },
  { type: "content_block_delta", index,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
  { type: "content_block_stop", index },
];

// An Anthropic answer of one word, for a request whose answer a test does not read.
const CLAUDE_DONE = claudeStream(
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
);

// How Anthropic answered, on 2026-11-24, a request that sent anthropic-search-answer back the
// way pi 1.6.0 writes it, without the search's blocks.
const MODIFIED_THINKING = { type: "error", error: {
  type: "invalid_request_error",
  message: "messages.1.content.1: `thinking` or `redacted_thinking` blocks in the latest " +
      "assistant message cannot be modified. These blocks must remain as they were in the " +
      "original response.",
} };

// Anthropic as it treats a response that thought and searched: the next request must hold
// `content` unchanged as its latest assistant message.
const acceptsUnmodified = (content: unknown): Answer => body =>
    JSON.stringify(assistantContents(body).at(-1)) === JSON.stringify(content)
      ? new Response(CLAUDE_DONE, SSE) : Response.json(MODIFIED_THINKING, { status: 400 });

const Messages = z.array(z.looseObject({ role: z.string(), content: z.unknown() }));
const Blocks = z.array(z.looseObject({
  type: z.string(), id: z.string().optional(), tool_use_id: z.string().optional(),
}));

// The content of each assistant message of a request's body, oldest first.
const assistantContents = (body: Body | undefined) => Messages.parse(body?.messages)
    .flatMap(message => message.role === "assistant" ? [message.content] : []);
const blockTypes = (content: unknown) => Blocks.parse(content).map(block => block.type);

// Whether a request's body is one Anthropic takes: no marker, and no search without its result.
function expectSendable(body: Body | undefined): void {
  expect(JSON.stringify(body)).not.toContain("kept-content");
  for (const content of assistantContents(body)) {
    const blocks = Blocks.parse(content);
    const answered = blocks.map(block => block.tool_use_id);
    expect(blocks.filter(block => block.type === "server_tool_use" && !answered.includes(block.id)))
        .toStrictEqual([]);
  }
}

// The results of the tool calls of `message`, as the agent's loop would follow it with them.
const toolResults = (message: AssistantMessage): ToolResultMessage[] => message.content
    .flatMap(block => block.type !== "toolCall" ? [] : [{
      role: "toolResult", toolCallId: block.id, toolName: block.name,
      content: [{ type: "text", text: "No blueprints." }], isError: false, timestamp: 0,
    }]);

describe("Anthropic's web search tool", () => {
  // One response of Claude's to the question, and what the stream wrapper made of it.
  async function answered(stream: string, config = CLAUDE) {
    const model = gateway(config);
    model.respond(stream);
    const { records, observe } = recorder();
    const search = withBuiltInSearch(model.handle.stream, () => true, observe);
    const message = await search.stream(model.handle.model, { messages: [system, QUESTION] })
        .result();
    return { ...model, records, search, message };
  }

  it("is declared with its cap, and each search is recorded with its results and charged",
      async () => {
    const { bodies, records, search, message } = await answered(ANSWER);

    expect(message.stopReason).toBe("stop");
    expect(Array.isArray(bodies[0]?.tools) && bodies[0].tools.at(-1)).toStrictEqual(
        { type: "web_search_20250305", name: "web_search", max_uses: 5 });
    expect(records).toHaveLength(1);
    const [[, url, searched]] = records;
    expect(url).toBeUndefined();
    const [queries, results] = searched.fields ?? [];
    expect(queries).toStrictEqual(
        { label: "Queries", kind: "list", items: ["Wrangler CLI latest stable release"] });
    expect(results).toMatchObject({ label: "Results", kind: "list" });
    expect(results && "items" in results && results.items).toHaveLength(10);
    expect(JSON.stringify(results)).toContain("wrangler - npm: https://www.npmjs.com/package/wrangler");
    expect(search.searched).toStrictEqual({ billed: 1 });
  });

  it.each([
    { name: "and answered", stream: ANSWER, content: ANSWER_CONTENT, next: user("Thanks.") },
    { name: "and called a tool", stream: TOOL_CALL, content: TOOL_CALL_CONTENT },
    // The search Anthropic paused on had no answer yet.
    { name: "until Anthropic paused it", stream: PAUSE, content: PAUSE_CONTENT.slice(0, -1),
      next: user("Go on.") },
  ])("sends a response that searched $name back as Anthropic sent it", async (
      { stream, content, next }) => {
    const { handle, bodies, respond, search, message } = await answered(stream);
    respond(CLAUDE_DONE);
    await search.stream(handle.model, {
      messages: [system, QUESTION, message, ...toolResults(message), ...next ? [next] : []],
    }).result();

    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(assistantContents(bodies[1]))).toBe(JSON.stringify([content]));
    expectSendable(bodies[1]);
  });

  it("leaves a client tool call's input out of what it keeps, as the step's snapshot does",
      async () => {
    const { message } = await answered(TOOL_CALL);
    const { providerContent } = z.object({ providerContent: z.string() }).parse(message);
    expect(Blocks.parse(JSON.parse(providerContent)).at(-1))
        .toMatchObject({ type: "tool_use", name: "listBlueprints", input: null });
  });

  // Made from the search of anthropic-search-answer, not captured: the captured tool calls have
  // no input.
  it("restores each client tool call's input from what pi wrote for the call", async () => {
    const [, searched, result] = ANSWER_CONTENT;
    const calls = [
      { type: "tool_use", id: "toolu_1", name: "listBlueprints",
        input: { kind: "notes", tags: ["a", "b"] } },
      { type: "tool_use", id: "toolu_2", name: "listBlueprints", input: { kind: "lists" } },
    ];
    const { handle, bodies, respond, search, message } = await answered(claudeStream(
      ...called(0, Object(searched)),
      { type: "content_block_start", index: 1, content_block: result },
      { type: "content_block_stop", index: 1 },
      ...called(2, calls[0]),
      ...called(3, calls[1]),
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {
        output_tokens: 9, server_tool_use: { web_search_requests: 1 },
      } },
    ));
    respond(CLAUDE_DONE);
    await search.stream(handle.model, {
      messages: [system, QUESTION, message, ...toolResults(message)],
    }).result();

    expect(JSON.stringify(assistantContents(bodies[1])))
        .toBe(JSON.stringify([[searched, result, ...calls]]));
  });

  // Anthropic may end a response with more than one `message_delta`. The count of searches is
  // the response's so far: one event may repeat it, and another leave it out.
  it("charges what Anthropic counted, whichever of its last events says so", async () => {
    const last = sse([
      { type: "message_delta", delta: { stop_reason: null }, usage: {
        output_tokens: 880, server_tool_use: { web_search_requests: 1 },
      } },
      { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 900 } },
    ]);
    const { search, message } =
        await answered(ANSWER.replace("event: message_stop", `${last}event: message_stop`));
    expect(message.usage.output).toBe(900);
    expect(search.searched).toStrictEqual({ billed: 1 });
    expect(message).toHaveProperty("providerContent", JSON.stringify(ANSWER_CONTENT));
  });

  it("ends a paused turn, with every search it finished recorded and charged", async () => {
    const { records, search, message } = await answered(PAUSE);
    expect(message.stopReason).toBe("stop");
    expect(message.content.filter(block => block.type === "toolCall")).toStrictEqual([]);
    expect(records).toHaveLength(10);
    expect(search.searched).toStrictEqual({ billed: 10 });
  });

  // The model searches again once it has the tool's result. That search is kept, and the one
  // that went unanswered is in neither request.
  it("keeps the search that follows one a response left unanswered", async () => {
    const { handle, bodies, respond, records, search, message } = await answered(UNANSWERED);
    expect(records).toStrictEqual([]);
    expect(search.searched).toBeUndefined();

    respond(ANSWER, CLAUDE_DONE);
    const first = [system, QUESTION, message, ...toolResults(message)];
    const again = await search.stream(handle.model, { messages: first }).result();
    await search.stream(handle.model, { messages: [...first, again, user("Thanks.")] }).result();

    expect(assistantContents(bodies[1]).map(blockTypes)).toStrictEqual([["thinking", "tool_use"]]);
    const [unanswered, answer] = assistantContents(bodies[2]);
    expect(blockTypes(unanswered)).toStrictEqual(["thinking", "tool_use"]);
    expect(JSON.stringify(answer)).toBe(JSON.stringify(ANSWER_CONTENT));
    expectSendable(bodies[2]);
  });

  it("sends kept content back whatever the setting and the workspace are", async () => {
    const { message } = await answered(ANSWER);
    // The setting is off again and the workspace is restricted: no tool, the same content.
    const off = gateway({ ...CLAUDE, webSearch: false });
    off.respond(CLAUDE_DONE);
    await withBuiltInSearch(off.handle.stream, () => false, async () => {})
        .stream(off.handle.model, { messages: [system, QUESTION, message, user("Thanks.")] })
        .result();
    expect(JSON.stringify(off.bodies[0]?.tools)).not.toContain("web_search");
    expect(JSON.stringify(assistantContents(off.bodies[0]))).toBe(JSON.stringify([ANSWER_CONTENT]));
  });

  // The captured answer up to the thinking after its search, then a second search that the
  // response cap cuts off in the middle of its query. No result answers that call, so it is
  // not kept, and what the stream held of it cannot be sent back wrong.
  it.each([
    { name: "its query", cut: { type: "input_json_delta", partial_json: '{"query": "Wrang' } },
    { name: "a delta of an unknown type", cut: { type: "mystery_delta", mystery: "?" } },
  ])("keeps a finished search when the response is cut off in a later search, in $name",
      async ({ cut }) => {
    const finished = ANSWER.split("event: content_block_start").slice(0, 5)
        .join("event: content_block_start");
    const { handle, bodies, respond, records, search, message } = await answered(finished + sse([
      { type: "content_block_start", index: 4, content_block: {
        type: "server_tool_use", id: "srvtoolu_cut", name: "web_search", input: {},
      } },
      { type: "content_block_delta", index: 4, delta: cut },
      { type: "content_block_stop", index: 4 },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: {
        output_tokens: 600, server_tool_use: { web_search_requests: 1 },
      } },
      { type: "message_stop" },
    ]));
    // As pi ends a response that reached its cap.
    expect(message.stopReason).toBe("length");
    expect(records).toHaveLength(1);
    expect(search.searched).toStrictEqual({ billed: 1 });

    const kept = ANSWER_CONTENT.slice(0, 4);
    expect(blockTypes(kept))
        .toStrictEqual(["thinking", "server_tool_use", "web_search_tool_result", "thinking"]);
    expect(message).toHaveProperty("providerContent", JSON.stringify(kept));
    respond(CLAUDE_DONE);
    await search.stream(handle.model, {
      messages: [system, QUESTION, message, user("Go on.")],
    }).result();
    expect(JSON.stringify(assistantContents(bodies[1]))).toBe(JSON.stringify([kept]));
    expectSendable(bodies[1]);
  });

  it("fails a response whose answered search has an input that is not JSON", async () => {
    const [, searched, result] = ANSWER_CONTENT;
    const { message } = await answered(claudeStream(
      { type: "content_block_start", index: 0, content_block: { ...searched, input: {} } },
      { type: "content_block_delta", index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query": "Wrang' } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: result },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {
        output_tokens: 9, server_tool_use: { web_search_requests: 1 },
      } },
    ));
    expect(message.stopReason).toBe("error");
    expect(message).not.toHaveProperty("providerContent");
  });

  it("fails a response it cannot keep as it was, and a request that would lose kept content",
      async () => {
    const delta = (type: string | object) => `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta", index: 0, delta: { type, mystery: "?" },
    })}\n\n`;
    const unknown = delta("mystery_delta");
    const before = "event: message_delta";
    const lossy = await answered(ANSWER.replace(before, unknown + before));
    expect(lossy.message.stopReason).toBe("error");
    expect(lossy.message.errorMessage).toContain("mystery_delta");
    // The error reaches the logs: it names a type, and holds nothing else the provider sent.
    const odd = await answered(ANSWER.replace(before, delta({ held: "provider text" }) + before));
    expect(odd.message.stopReason).toBe("error");
    expect(odd.message.errorMessage).not.toContain("provider text");
    // A response that needs no keeping is pi's alone to read.
    const plain = await answered(UNANSWERED.replace(before, unknown + before));
    expect(plain.message.stopReason).toBe("toolUse");

    const { handle, bodies, search, message } = await answered(ANSWER);
    const dropped = await search.stream(handle.model, {
      messages: [system, QUESTION, message, user("Thanks.")],
    }, { onPayload: payload => ({ ...Object(payload), messages: [] }) }).result();
    expect(dropped.stopReason).toBe("error");
    expect(dropped.errorMessage).toContain("0 of the 1 messages");
    expect(bodies).toHaveLength(1);
  });
});

// The OverseerImpl members these tests drive; the class itself is private to overseer.ts.
interface OverseerInternals extends AgentHooks {
  env: object;
  storage: {
    gadgets: { put(record: GadgetRecord): void };
    gatekeepers: { put(record: GatekeeperRecord): void };
    chatContext: { put(context: AiChatAgentContext): void };
    chatMeta: { put(meta: AiChatMetadata): void; get(id: number): AiChatMetadata | undefined };
    chats: { put(message: AiChatMessage): void; list(): Iterable<AiChatMessage> };
    actions: { list(): Iterable<ActionRecord> };
    containsRestrictedData: { put(value: boolean): void };
  };
  nextChatSequence(chatId: number): number;
  getGatekeeperFacet(id: number): Promise<object>;
}

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const CHAT_ID = 1;
const WEB_SEARCH_ID = 200;
let doCounter = 0;

// A workspace with one gadget and an empty chat that holds the Web Search gatekeeper's binding,
// as a chat must to search in the model.
async function withChat(fn: (impl: OverseerInternals) => Promise<void>): Promise<void> {
  const stub = env.TEST_OVERSEER.getByName(`built-in-search-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // OverseerImpl is private to overseer.ts, so the object's `impl` field has no public type.
    const { impl } = instance as unknown as { impl: OverseerInternals };
    impl.storage.gadgets.put({
      type: "gadget", id: 100, title: "App", created: new Date(0), bindingName: "APP",
      bindings: {},
    });
    impl.env = { ...impl.env, GATEKEEPER_WEBSEARCH: {} };
    impl.storage.gatekeepers.put({
      id: WEB_SEARCH_ID, resourceTitle: "Web Search",
      // The facet below stands in for the class, which is never loaded.
      class: {} as unknown as GatekeeperRecord["class"],
      creationSpec: { type: "ambient", vendorId: WEB_SEARCH_VENDOR_ID, accountId: "account" },
    });
    impl.getGatekeeperFacet = async () => ({ getAgentCatalog: async () => null });
    impl.storage.chatContext.put({
      chatId: CHAT_ID, bindings: { WEB_SEARCH: WEB_SEARCH_ID },
      alwaysAvailableCapsuleIds: [WEB_SEARCH_ID],
    });
    impl.storage.chatMeta.put(
        { id: CHAT_ID, title: "Chat", started: new Date(0), lastActive: new Date(0) });
    await fn(impl);
  });
}

// The chat's timestamps are unique, so each seeded record is stamped with its sequence.
function ask(impl: OverseerInternals, text: string): void {
  const sequence = impl.nextChatSequence(CHAT_ID);
  impl.storage.chats.put({
    chatId: CHAT_ID, sequence, timestamp: new Date(sequence), author: OWNER, type: "message",
    message: text,
  });
}

// A user's message that holds the workspace's Web Search resource, pasted where it says "[0]".
function pasteWebSearch(impl: OverseerInternals, text: string): void {
  const sequence = impl.nextChatSequence(CHAT_ID);
  impl.storage.chats.put({
    chatId: CHAT_ID, sequence, timestamp: new Date(sequence), author: OWNER, type: "message",
    message: text,
    capsules: [{
      position: text.indexOf("[0]"), length: "[0]".length, gatekeeperId: WEB_SEARCH_ID,
      description: { url: "websearch://web", title: "Web Search", snippet: "Search the public web." },
      bindingName: "PASTED_SEARCH",
    }],
  });
}

const chatLog = (impl: OverseerInternals) =>
    [...impl.storage.chats.list()].filter(message => message.chatId === CHAT_ID);

describe("an agent's turn on a GPT model with web search on", () => {
  const agent: AiChatAuthorInfo = { type: "agent", id: "gpt-6-luna", name: "GPT" };
  const turn = (impl: OverseerInternals, handle: ModelHandle,
                config: AiModelConfig = GPT) =>
      runAgent(impl, handle, CHAT_ID, agent, new AbortController().signal, OWNER, config);

  it("lists what the tool did in Activity and after the step's message, and adds the search fee",
      () => withChat(async impl => {
    const { handle, bodies, respond } = gateway(GPT);
    ask(impl, "What is the latest stable release of Wrangler?");
    respond(OPENAI_SEARCH);
    // A turn whose last response measured the chat leaves that request to keep cached. This
    // one's usage is the sum over the provider's steps, so it leaves none.
    expect(await turn(impl, handle)).toBeUndefined();

    expect(toolTypes(bodies[0])).toContain("web_search");
    const actions = [...impl.storage.actions.list()];
    expect(actions.map(action => [action.type, action.state, action.resourceUrl])).toStrictEqual([
      ["observation", "approved", undefined],
      ["observation", "approved", "https://github.com/cloudflare/workers-sdk/releases"],
    ]);
    const [, answer, ...rows] = chatLog(impl);
    expect(answer).toMatchObject({ type: "message", author: agent });
    expect(rows).toMatchObject(actions.map(action => ({ type: "action", actionId: action.id })));

    // No gateway log answers here, so the tokens cost what pi's catalog prices them at.
    const tokens = impl.getChatModelData(CHAT_ID, answer?.sequence ?? -1)?.usage.cost.total ?? 0;
    expect(tokens).toBeGreaterThan(0);
    expect(impl.storage.chatMeta.get(CHAT_ID)?.totalCost).toBeCloseTo(tokens + WEB_SEARCH_FEE, 10);
  }));

  // The response's usage counts its prompt once for each step the provider ran: 15,276 tokens
  // for a chat of a few hundred. With a budget that the count would pass and the chat does not,
  // neither the step's own check nor the next turn's may take the count for the chat's size.
  it("does not take the usage of a response that searched for the size of the chat",
      () => withChat(async impl => {
    const small: AiModelConfig = { ...GPT, compactionInputBudget: 16_000 };
    const { handle, bodies, respond } = gateway(small);
    const events: AiChatStreamEvent[] = [];
    impl.emitChatStreamEvent = (_chatId, event) => events.push(event);
    ask(impl, "What is the latest stable release of Wrangler?");
    respond(OPENAI_SEARCH);
    // A measured turn leaves its last request to keep cached; an unmeasured one does not.
    expect(await turn(impl, handle, small)).toBeUndefined();
    expect(impl.storage.chatMeta.get(CHAT_ID)?.totalTokens).toBeUndefined();

    ask(impl, "Thanks.");
    respond(OPENAI_DONE);
    await turn(impl, handle, small);
    expect(bodies).toHaveLength(2);
    expect(events.filter(event => event.type === "compacting")).toStrictEqual([]);
    // The response that ran no search measures the chat again.
    expect(impl.storage.chatMeta.get(CHAT_ID)?.totalTokens).toBe(101);
  }));

  // A gadget-spawned chat holds the bindings its spawner gave it, and what a user pastes into it.
  it("offers the tool to a spawned chat only once it holds Web Search, here as a pasted resource",
      () => withChat(async impl => {
    impl.storage.chatContext.put({
      chatId: CHAT_ID, bindings: {}, alwaysAvailableCapsuleIds: [WEB_SEARCH_ID],
      spawnerConfig: { displayName: "Spawner", modelId: GPT.model, env: {} },
    });
    const { handle, bodies, respond } = gateway(GPT);
    ask(impl, "Search the web.");
    respond(OPENAI_DONE);
    await turn(impl, handle);
    expect(toolTypes(bodies[0])).not.toContain("web_search");

    pasteWebSearch(impl, "Search with [0].");
    respond(OPENAI_DONE);
    await turn(impl, handle);
    expect(bodies).toHaveLength(2);
    expect(toolTypes(bodies[1])).toContain("web_search");
  }));

  // The replay keeps the first target of a name, so executeCode cannot reach the pasted record.
  it("does not offer the tool for a pasted Web Search whose name the chat gave another target",
      () => withChat(async impl => {
    impl.storage.chatContext.put({
      chatId: CHAT_ID, bindings: { PASTED_SEARCH: 100 }, alwaysAvailableCapsuleIds: [WEB_SEARCH_ID],
      spawnerConfig: { displayName: "Spawner", modelId: GPT.model, env: { PASTED_SEARCH: 100 } },
    });
    const { handle, bodies, respond } = gateway(GPT);
    pasteWebSearch(impl, "Search with [0].");
    respond(OPENAI_DONE);
    await turn(impl, handle);
    expect(bodies).toHaveLength(1);
    expect(toolTypes(bodies[0])).not.toContain("web_search");
  }));

  it("still offers the tool after a compaction drops the message that pasted Web Search",
      () => withChat(async impl => {
    impl.storage.chatContext.put({
      chatId: CHAT_ID, bindings: {}, alwaysAvailableCapsuleIds: [WEB_SEARCH_ID],
      spawnerConfig: { displayName: "Spawner", modelId: GPT.model, env: {} },
    });
    const { handle, bodies, respond } = gateway(GPT);
    pasteWebSearch(impl, "Search with [0].");
    respond(openAiText("Searched."));
    await turn(impl, handle);

    const compact = impl.nextChatSequence(CHAT_ID);
    impl.storage.chats.put({
      chatId: CHAT_ID, sequence: compact, timestamp: new Date(compact), author: OWNER,
      type: "slashCommand", request: { id: { builtin: true, commandId: "compact" }, args: "" },
    });
    respond(openAiText("The user asked for a search, and the agent ran it."));
    await turn(impl, handle);
    expect(impl.storage.chatMeta.get(CHAT_ID)?.compactedTo).toBeDefined();

    ask(impl, "Search again.");
    respond(OPENAI_DONE);
    await turn(impl, handle);
    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies[2])).not.toContain("Search with");
    expect(toolTypes(bodies[2])).toContain("web_search");
  }));

  it("searches beside a tool call, and stops offering the tool once the workspace is restricted",
      () => withChat(async impl => {
    const { handle, bodies, respond } = gateway(GPT);
    ask(impl, "Search for Wrangler's latest release, then list the blueprints.");
    respond(OPENAI_SEARCH_TOOL_CALL, OPENAI_DONE);
    // The tool call's result is what restricts the workspace, in the middle of the pass.
    impl.listAvailableBlueprints = async () => {
      impl.storage.containsRestrictedData.put(true);
      return "No blueprints.";
    };
    await turn(impl, handle);

    expect(bodies).toHaveLength(2);
    expect(toolTypes(bodies[0])).toContain("web_search");
    expect(toolTypes(bodies[1])).not.toContain("web_search");
    expect(bodies[1]?.max_tool_calls).toBeUndefined();
    expect([...impl.storage.actions.list()]).toHaveLength(1);
    expect(chatLog(impl).map(message => message.type))
        .toStrictEqual(["message", "message", "action", "message"]);
  }));
});

describe("an agent's turn on a Claude model with web search on", () => {
  const agent: AiChatAuthorInfo = { type: "agent", id: "claude-haiku-5-5", name: "Claude" };
  const turn = (impl: OverseerInternals, handle: ModelHandle, signal = new AbortController().signal) =>
      runAgent(impl, handle, CHAT_ID, agent, signal, OWNER, CLAUDE);

  // Without the kept content, the second request holds the first response as pi writes it,
  // which Anthropic refuses: the chat would be stuck on every message after a search.
  it("answers the message after a response that thought, searched and answered",
      () => withChat(async impl => {
    const { handle, bodies, respond } = gateway(CLAUDE);
    ask(impl, "What is the latest stable release of Wrangler?");
    respond(ANSWER);
    await turn(impl, handle);
    ask(impl, "Thanks.");
    respond(acceptsUnmodified(ANSWER_CONTENT));
    await turn(impl, handle);

    expect(bodies).toHaveLength(2);
    expectSendable(bodies[1]);
    const [, answer, row, , reply] = chatLog(impl);
    expect(reply).toMatchObject({ type: "message", author: agent, message: "OK." });
    expect(row).toMatchObject({ type: "action" });
    expect([...impl.storage.actions.list()]).toHaveLength(1);

    // The chat lists the cited page after the answer. The model is sent its own text, from the
    // snapshot.
    const text = ANSWER_CONTENT.flatMap(block => block.type === "text" ? [block.text] : []).join("");
    expect(answer).toMatchObject({ type: "message", message:
        `${text}\n\nSources: [npmjs.com](https://www.npmjs.com/package/wrangler)` });
    const snapshot = impl.getChatModelData(CHAT_ID, answer?.sequence ?? -1);
    expect(JSON.stringify(snapshot?.content)).not.toContain("npmjs.com");
    // A client tool call's input is stored once, with the step's message.
    expect(snapshot?.providerContent).toBe(JSON.stringify(ANSWER_CONTENT));
    const tokens = snapshot?.usage.cost.total ?? 0;
    const second = impl.getChatModelData(CHAT_ID, reply?.sequence ?? -1)?.usage.cost.total ?? 0;
    expect(impl.storage.chatMeta.get(CHAT_ID)?.totalCost)
        .toBeCloseTo(tokens + WEB_SEARCH_FEE + second, 10);
  }));

  // After a response that searched and called a tool, whatever comes between the tool's result
  // and the next request must leave a request Anthropic takes, with the search sent back whole.
  describe("after a search beside a tool call", () => {
    const expectTaken = (body: Body | undefined) => {
      expectSendable(body);
      expect(JSON.stringify(assistantContents(body))).toBe(JSON.stringify([TOOL_CALL_CONTENT]));
    };
    const start = (impl: OverseerInternals) => {
      const model = gateway(CLAUDE);
      impl.listAvailableBlueprints = async () => "No blueprints.";
      ask(impl, "Search for Wrangler's latest release, and list the blueprints.");
      model.respond(TOOL_CALL, CLAUDE_DONE);
      return model;
    };

    it("a steer follows the tool's result", () => withChat(async impl => {
      const { handle, bodies } = start(impl);
      const steers = [{ text: "Check Bun too." }];
      impl.takeSteers = () => bodies.length === 1 ? steers.splice(0) : [];
      await turn(impl, handle);
      expect(bodies).toHaveLength(2);
      expect(JSON.stringify(bodies[1])).toContain("Check Bun too.");
      expectTaken(bodies[1]);
    }));

    it("the turn waits for a decision, then resumes", () => withChat(async impl => {
      const { handle, bodies } = start(impl);
      const consume = impl.consumeCapturedActions.bind(impl);
      impl.consumeCapturedActions = chatId => {
        const captured = consume(chatId) ?? { actions: [], accessedGadget: false };
        return { ...captured, awaitDecision: bodies.length === 1 };
      };
      await turn(impl, handle);
      expect(bodies).toHaveLength(1);
      await turn(impl, handle);
      expect(bodies).toHaveLength(2);
      expectTaken(bodies[1]);
    }));

    it("the user stops the turn while the tool runs", () => withChat(async impl => {
      const { handle, bodies } = start(impl);
      const stop = new AbortController();
      impl.listAvailableBlueprints = async () => {
        stop.abort(new Error("Stopped."));
        return "No blueprints.";
      };
      await expect(turn(impl, handle, stop.signal)).rejects.toThrow("Stopped.");
      expect(bodies).toHaveLength(1);
      ask(impl, "Go on.");
      await turn(impl, handle);
      expect(bodies).toHaveLength(2);
      expectTaken(bodies[1]);
    }));
  });

  // What Anthropic sent is for the model it sent it to. Any other is sent what pi writes for a
  // message that is not its own, and its prompt is not weighed as if it held the search.
  it("gives another model the chat without the search's blocks", () => withChat(async impl => {
    const claude = gateway(CLAUDE);
    ask(impl, "What is the latest stable release of Wrangler?");
    claude.respond(ANSWER);
    await turn(impl, claude.handle);

    // GPT mid-chat, with a budget the kept content alone would pass.
    const small: AiModelConfig = { ...GPT, compactionInputBudget: 16_000 };
    const gpt = gateway(small);
    ask(impl, "And the one before it?");
    gpt.respond(OPENAI_DONE);
    await runAgent(impl, gpt.handle, CHAT_ID, { type: "agent", id: "gpt-6-luna", name: "GPT" },
        new AbortController().signal, OWNER, small);
    expect(gpt.bodies).toHaveLength(1);
    expect(JSON.stringify(gpt.bodies[0])).not.toContain("web_search_tool_result");
    expect(JSON.stringify(gpt.bodies[0])).not.toContain("kept-content");
    expect(JSON.stringify(gpt.bodies[0])).toContain("4.167.0");

    // Another Claude.
    const sonnet = gateway({ ...CLAUDE, model: "claude-sonnet-5-5" });
    ask(impl, "Sure?");
    sonnet.respond(CLAUDE_DONE);
    await runAgent(impl, sonnet.handle, CHAT_ID,
        { type: "agent", id: "claude-sonnet-5-5", name: "Sonnet" },
        new AbortController().signal, OWNER, { ...CLAUDE, model: "claude-sonnet-5-5" });
    expect(assistantContents(sonnet.bodies[0]).map(blockTypes)[0])
        .toStrictEqual(["text", "text", "text"]);
    expectSendable(sonnet.bodies[0]);

    // The model that searched, again.
    ask(impl, "Thanks.");
    claude.respond(CLAUDE_DONE);
    await turn(impl, claude.handle);
    expect(JSON.stringify(assistantContents(claude.bodies[1])[0])).toBe(JSON.stringify(ANSWER_CONTENT));
    expectSendable(claude.bodies[1]);
  }));

  // GPT's response measured a prompt without the search content that only Claude is sent back,
  // so Claude's next pass cannot take that size for its own. Here the content alone passes the
  // budget, so the chat asks for a compaction before the turn's request. The provider here
  // writes no summary, and the turn runs without one.
  it("does not take a size another model measured for a prompt that holds kept content",
      () => withChat(async impl => {
    const small: AiModelConfig = { ...CLAUDE, compactionInputBudget: 16_000 };
    const claude = gateway(small);
    const claudeTurn = () => runAgent(
        impl, claude.handle, CHAT_ID, agent, new AbortController().signal, OWNER, small);
    ask(impl, "What is the latest stable release of Wrangler?");
    claude.respond(ANSWER);
    await claudeTurn();

    const gpt = gateway(GPT);
    ask(impl, "And the one before it?");
    gpt.respond(OPENAI_DONE);
    await runAgent(impl, gpt.handle, CHAT_ID, { type: "agent", id: "gpt-6-luna", name: "GPT" },
        new AbortController().signal, OWNER, GPT);
    expect(impl.storage.chatMeta.get(CHAT_ID)?.totalTokens).toBe(101);

    ask(impl, "Thanks.");
    claude.respond(CLAUDE_DONE, CLAUDE_DONE);
    await claudeTurn();
    expect(claude.bodies.map(body => body.compaction !== undefined))
        .toStrictEqual([false, true, false]);
  }));

  // Claude's own follow-up measured the prompt with its kept content, so that size is the
  // chat's. The estimate of the kept content alone would pass this budget.
  it("takes the size its own model measured for a prompt that holds kept content",
      () => withChat(async impl => {
    const small: AiModelConfig = { ...CLAUDE, compactionInputBudget: 16_000 };
    const claude = gateway(small);
    ask(impl, "What is the latest stable release of Wrangler?");
    claude.respond(ANSWER);
    await turn(impl, claude.handle);
    ask(impl, "Thanks.");
    claude.respond(CLAUDE_DONE);
    await turn(impl, claude.handle);
    expect(impl.storage.chatMeta.get(CHAT_ID)?.totalTokens).toBe(102);

    ask(impl, "And the one before it?");
    claude.respond(CLAUDE_DONE);
    await runAgent(impl, claude.handle, CHAT_ID, agent, new AbortController().signal, OWNER, small);
    expect(claude.bodies.map(body => body.compaction !== undefined))
        .toStrictEqual([false, false, false]);
  }));

  // The other direction. Claude's follow-up measured a prompt with the search content that only
  // Claude is sent back, so a pass on GPT cannot take that size either. Here GPT's budget is
  // between its own prompt and Claude's count, and the chat has room left.
  it("does not take for another model a size measured with kept content that model is not sent",
      () => withChat(async impl => {
    const claude = gateway(CLAUDE);
    ask(impl, "What is the latest stable release of Wrangler?");
    claude.respond(ANSWER);
    await turn(impl, claude.handle);
    ask(impl, "Thanks.");
    claude.respond(CLAUDE_DONE.replace('"input_tokens":100', '"input_tokens":20000'));
    await turn(impl, claude.handle);
    expect(impl.storage.chatMeta.get(CHAT_ID)?.totalTokens).toBe(20_002);

    const small: AiModelConfig = { ...GPT, compactionInputBudget: 16_000 };
    const gpt = gateway(small);
    const events: AiChatStreamEvent[] = [];
    impl.emitChatStreamEvent = (_chatId, event) => events.push(event);
    ask(impl, "And the one before it?");
    gpt.respond(OPENAI_DONE);
    await runAgent(impl, gpt.handle, CHAT_ID, { type: "agent", id: "gpt-6-luna", name: "GPT" },
        new AbortController().signal, OWNER, small);
    expect(events.filter(event => event.type === "compacting")).toStrictEqual([]);
    expect(gpt.bodies).toHaveLength(1);
    expect(JSON.stringify(gpt.bodies[0])).not.toContain("web_search_tool_result");
  }));

  // A cited passage can end inside a code block or a table row, where a link would not be one.
  it("links the pages an answer cites on one line after it", () => withChat(async impl => {
    const { handle, respond } = gateway(CLAUDE);
    const cite = (index: number, url: string): Event => ({
      type: "content_block_delta", index, delta: { type: "citations_delta", citation: {
        type: "web_search_result_location", url, title: "T", cited_text: "...",
        encrypted_index: "E",
      } },
    });
    ask(impl, "How do I install Wrangler?");
    respond(claudeStream(
      // This block starts with no list of citations, which Anthropic's SDK takes for none.
      { type: "content_block_start", index: 0,
        content_block: { type: "text", text: "Run:\n```sh\nnpm i wrangler" } },
      cite(0, "https://www.example.com/a"),
      cite(0, "https://en.wikipedia.org/wiki/Wrangler_(software)"),
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1,
        content_block: { citations: [], type: "text", text: "\n```\nThen deploy." } },
      cite(1, "javascript:alert(1)"),
      cite(1, "https://www.example.com/a"),
      cite(1, "https://docs.example.org/deploy"),
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
    ));
    await turn(impl, handle);

    // One link for each page, in the order first cited: its host without a www, parentheses
    // encoded, nothing but the web.
    expect(chatLog(impl)[1]).toMatchObject({ type: "message", message:
        "Run:\n```sh\nnpm i wrangler\n```\nThen deploy.\n\nSources: " +
        "[example.com](https://www.example.com/a), " +
        "[en.wikipedia.org](https://en.wikipedia.org/wiki/Wrangler_%28software%29), " +
        "[docs.example.org](https://docs.example.org/deploy)" });
  }));

  // pi makes nothing of a response that holds a search and no text, thinking or tool call, so
  // its message is empty. Made from the search of anthropic-search-answer, not captured.
  it("sends back a response that did nothing but search", () => withChat(async impl => {
    const [, searched, result] = ANSWER_CONTENT;
    const { handle, bodies, respond } = gateway(CLAUDE);
    ask(impl, "What is the latest stable release of Wrangler?");
    respond(claudeStream(
      ...called(0, Object(searched)),
      { type: "content_block_start", index: 1, content_block: result },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {
        output_tokens: 9, server_tool_use: { web_search_requests: 1 },
      } },
    ));
    await turn(impl, handle);
    ask(impl, "Well?");
    respond(CLAUDE_DONE);
    await turn(impl, handle);

    expect(JSON.stringify(assistantContents(bodies[1]))).toBe(JSON.stringify([[searched, result]]));
    expectSendable(bodies[1]);
  }));
});
