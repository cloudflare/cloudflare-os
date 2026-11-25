// Built-in web search: an agent's turn on a model that has web search on (see
// AiModelConfig.webSearch), in a chat that may search in the model (see
// AgentHooks.chatMaySearchInModel), declares the provider's own search tool, and the provider runs
// each search inside the model request. pi knows nothing of tools a provider runs and drops what
// they add to a response, so this module reads the provider's stream itself: it asks for the tool
// on each request of the turn (withWebSearchTool in ai-models.ts declares it), records everything
// the tool did as observations, and says what that means for the step that holds the response.
//
// OpenAI Responses reports each thing its tool did as a `web_search_call` output item: a search,
// which holds the queries and no results, or a page the model opened or searched within, from
// OpenAI's index. A later request is accepted without the items, so nothing is kept: what the
// tool found ends with the response that ran it.
//
// Anthropic Messages puts a search in the response's content, as a `server_tool_use` block and
// the `web_search_tool_result` block that answers it, and cites the results from the text blocks
// after them. A later request must send that content back as it was: sent in pi's form, which has
// neither block, a response that thought before it searched is refused ("`thinking` ... blocks in
// the latest assistant message cannot be modified"), and any other makes the model search again.
// So the content of a response that searched is kept whole, on the response's message and in the
// step's snapshot (see StoredAssistantMessage.providerContent), and every later request to the
// model that produced it (see keptForModel) carries it in place of what pi wrote for that
// message, whatever the setting and the workspace are by then. A search the response left
// unanswered, which it can beside a client tool call or when Anthropic pauses a long turn, is
// not kept: sent back, it is refused unless tool results and nothing else follow it, and nothing
// was charged for it.

import {
  buildDescription, codeSpan, type ActionDescriptionBuilder,
} from "@gadgets/gatekeeper-kit/action-description";
import type { Api, AssistantMessage, Context, Model, TextContent } from "@earendil-works/pi-ai";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { z } from "zod";
import type { ModelHandle } from "./ai-models.js";
import type { StoredAssistantMessage } from "./storage-schema/overseer-storage.js";

/**
 * What a provider charges for one search, in dollars, on top of the response's tokens: $10 per
 * 1,000 searches at Anthropic
 * (platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) and at OpenAI
 * (developers.openai.com/api/docs/pricing), both read 2026-11-24. AI Gateway's logged cost leaves
 * it out.
 */
export const WEB_SEARCH_FEE = 0.01;

type Stream = ModelHandle["stream"];

// A finished `web_search_call` item, whatever its status, and the fields of the actions OpenAI
// documents. An action of another shape is recorded as one, not left out.
const OpenAiSearchCall = z.object({
  type: z.literal("response.output_item.done"),
  item: z.object({
    type: z.literal("web_search_call"),
    status: z.string(),
    action: z.looseObject({
      type: z.string(),
      queries: z.array(z.string()).optional(),
      query: z.string().optional(),
      url: z.string().nullish(),
      pattern: z.string().nullish(),
    }).catch({ type: "unknown" }),
  }),
});
type OpenAiSearchCall = z.infer<typeof OpenAiSearchCall>["item"];

// How many searches OpenAI charges a response for, in the event that ends it. A completed call
// does not say whether OpenAI charged for it.
const OpenAiSearchCount = z.object({
  type: z.enum(["response.completed", "response.incomplete"]),
  response: z.looseObject({
    tool_usage: z.looseObject({ web_search: z.looseObject({ num_requests: z.number() }) }),
  }),
});

// A content block or a delta as Anthropic sent it: the keys are copied in their order.
const Block = z.record(z.string(), z.unknown());
type Block = z.infer<typeof Block>;
const Blocks = z.array(Block);
// The events that carry a response's content, and the one that ends it. A field of another
// shape reads as absent, so that the event is still seen.
const AnthropicEvent = z.object({
  type: z.string(),
  index: z.number().optional().catch(undefined),
  content_block: Block.optional().catch(undefined),
  delta: Block.optional().catch(undefined),
  usage: z.looseObject({
    server_tool_use: z.looseObject({ web_search_requests: z.number().optional() }).nullish(),
  }).optional().catch(undefined),
});
const AnthropicSearchResults =
    z.array(z.looseObject({ title: z.string().nullish(), url: z.string() }));
const AnthropicSearchError = z.looseObject({ error_code: z.string() });
const AnthropicCitations = z.looseObject({
  type: z.literal("text"),
  citations: z.array(z.looseObject({ url: z.string().optional() })),
});
// pi's Anthropic request, and one of its assistant messages.
const AnthropicPayload = z.looseObject({ messages: z.array(z.unknown()) });
const AnthropicAssistant = z.looseObject({ role: z.literal("assistant"), content: Blocks });

/**
 * One thing a provider's search tool did, as AgentHooks.recordProviderObservation() takes it: the
 * record's title and URL, and its description.
 */
export type BuiltInSearchRecord =
    [resourceTitle: string, resourceUrl: string | undefined, description: ObservationDescription];

/** What the use a response made of the provider's search tool means for the step that holds it. */
export type SearchedResponse = {
  /** How many searches the provider charges WEB_SEARCH_FEE for. */
  billed: number;
};

/** An agent turn's stream with built-in search (see withBuiltInSearch). */
export type BuiltInSearchStream = {
  stream: Stream;

  /**
   * Set when the latest response ran a search. Its `usage` is then what the response cost and not
   * how large the chat is: Anthropic sums it over the response's internal steps, each of which
   * reads the prompt again, and OpenAI's counts the results it read, which the chat does not keep.
   */
  searched?: SearchedResponse;

  /**
   * Set when the latest response cited web pages: the Markdown that ends the answer the chat
   * shows, a line that links each page. For display only: the model is sent its own text.
   */
  sources?: string;
};

/**
 * Wrap an agent turn's `stream` so that each request asks for the provider's web search tool
 * while `offered()` says so, `observe` records each thing the tool did, before the response
 * continues, and a message that holds what Anthropic sent for a search is sent back to its model
 * as that.
 */
export function withBuiltInSearch(
    stream: Stream, offered: () => boolean,
    observe: (...record: BuiltInSearchRecord) => void): BuiltInSearchStream {
  const search: BuiltInSearchStream = {
    stream: (model, context, options = {}) => {
      search.searched = undefined;
      search.sources = undefined;
      if (model.api !== "anthropic-messages") {
        return stream(model, context, {
          ...options,
          webSearch: offered(),
          onProviderStreamEvent: async (event, eventModel) => {
            await options.onProviderStreamEvent?.(event, eventModel);
            const count = OpenAiSearchCount.safeParse(event);
            if (count.success) {
              if (search.searched) {
                search.searched.billed = count.data.response.tool_usage.web_search.num_requests;
              }
              return;
            }
            const done = OpenAiSearchCall.safeParse(event);
            if (!done.success) return;
            const call = done.data.item;
            // Counted here for a response whose last event holds no count.
            const searched = search.searched ??= { billed: 0 };
            if (call.status === "completed" && call.action.type === "search") ++searched.billed;
            observe(...describeOpenAiCall(call));
          },
        });
      }
      const sent = markKeptContent(context);
      const reply = readAnthropicReply(search, observe);
      const response = stream(model, sent.context, {
        ...options,
        webSearch: offered(),
        onPayload: async (payload, payloadModel) =>
            sent.restore(await options.onPayload?.(payload, payloadModel) ?? payload),
        onProviderStreamEvent: async (event, eventModel) => {
          await options.onProviderStreamEvent?.(event, eventModel);
          reply.read(event);
        },
      });
      // Registered before the agent's loop asks for the result, so the loop's message holds it.
      void response.result().then(message => {
        const providerContent = reply.kept();
        if (providerContent !== undefined) Object.assign(message, { providerContent });
      });
      return response;
    },
  };
  return search;
}

/**
 * `stored` as a request to `model` may hold it: with what Anthropic sent for a search only if
 * `model` is the one that produced it, which is pi's own rule for what a model is sent back as it
 * wrote it. For any other model the step is pi's alone to write.
 */
export function keptForModel(stored: StoredAssistantMessage, model: Model<Api>)
    : StoredAssistantMessage {
  if (stored.providerContent === undefined || (stored.provider === model.provider &&
      stored.api === model.api && stored.model === model.id)) {
    return stored;
  }
  const { providerContent: _, ...written } = stored;
  return written;
}

/**
 * `message` without its thinking, in what Anthropic sent for a search too. A prompt that was
 * rewritten since makes a reply's thinking invalid (see runAgentPass). Its search results stay
 * valid: Anthropic takes the content back without its thinking.
 */
export function withoutThinking(message: AssistantMessage): AssistantMessage {
  const bare = { ...message, content: message.content.filter(block => block.type !== "thinking") };
  if (!("providerContent" in message) || typeof message.providerContent !== "string") return bare;
  const kept = Blocks.parse(JSON.parse(message.providerContent)).filter(block =>
      block.type !== "thinking" && block.type !== "redacted_thinking");
  return Object.assign(bare, { providerContent: JSON.stringify(kept) });
}

// `context` with a marker leading each message that holds kept content, and the rewrite of the
// request pi builds from it that puts the kept content in each marked message's place. pi writes
// a message's blocks in order, so the marker is the first block of its message.
function markKeptContent(context: Context)
    : { context: Context; restore(payload: unknown): unknown } {
  const kept: string[] = [];
  // Random, so that no text a model or a user wrote can be taken for a marker.
  const marker = `kept-content:${crypto.randomUUID()}:`;
  const messages = context.messages.map(message => {
    if (message.role !== "assistant" || !("providerContent" in message) ||
        typeof message.providerContent !== "string") {
      return message;
    }
    const content = message.providerContent;
    const marked: TextContent = { type: "text", text: `${marker}${kept.push(content) - 1}` };
    return { ...message, content: [marked, ...message.content] };
  });
  if (kept.length === 0) return { context, restore: payload => payload };
  return {
    context: { ...context, messages },
    restore: payload => {
      const request = AnthropicPayload.safeParse(payload);
      let restored = 0;
      const sent = request.success ? request.data.messages.map(message => {
        const assistant = AnthropicAssistant.safeParse(message);
        const [first, ...written] = assistant.success ? assistant.data.content : [];
        if (first?.type !== "text" || typeof first.text !== "string" ||
            !first.text.startsWith(marker)) {
          return message;
        }
        ++restored;
        const content = kept[Number(first.text.slice(marker.length))];
        return { ...assistant.data, content: withToolInputs(content, written) };
      }) : [];
      // A marker must never reach the provider, nor a message go without its content.
      if (!request.success || restored !== kept.length) {
        throw new Error(`The request holds ${restored} of the ${kept.length} messages whose ` +
            "web search content must be sent back to Anthropic as it was.");
      }
      return { ...request.data, messages: sent };
    },
  };
}

// Kept content with each client tool call's input, which it leaves out, taken from the block pi
// wrote for that call.
function withToolInputs(kept: string | undefined, written: Block[]): Block[] {
  if (kept === undefined) throw new Error("A request names web search content it does not hold.");
  return Blocks.parse(JSON.parse(kept)).map(block => {
    if (block.type !== "tool_use") return block;
    const call = written.find(({ type, id }) => type === "tool_use" && id === block.id);
    if (call === undefined) {
      throw new Error("A tool call of a response that searched the web is missing from the " +
          "request, so the response cannot be sent back to Anthropic as it was.");
    }
    return { ...block, input: call.input };
  });
}

// Reads one Anthropic response's events: rebuilds its content, each block as Anthropic started
// it with its deltas applied, records each search as its result arrives, and when the response
// ends reports to `search` what it did. `kept()` is then the content to keep, if the response
// holds a finished search.
function readAnthropicReply(
    search: BuiltInSearchStream, observe: (...record: BuiltInSearchRecord) => void) {
  const content: Block[] = [];
  const toolInputs = new Map<number, string>();
  // What the stream held that `content` does not reproduce, if anything.
  let lost: string | undefined;
  let kept: string | undefined;
  // The searches Anthropic has charged the response for, as its latest count says.
  let billed = 0;

  const append = (block: Block, key: string, text: unknown) => {
    const before = block[key];
    if (typeof before !== "string" || typeof text !== "string") return false;
    block[key] = before + text;
    return true;
  };
  const applyDelta = (index: number, block: Block, delta: Block): boolean => {
    switch (delta.type) {
      case "text_delta": return append(block, "text", delta.text);
      case "thinking_delta": return append(block, "thinking", delta.thinking);
      case "signature_delta": return append(block, "signature", delta.signature);
      case "citations_delta": {
        const cited = block.citations ?? [];
        if (!Array.isArray(cited)) return false;
        block.citations = [...cited, delta.citation];
        return true;
      }
      case "input_json_delta":
        if (typeof delta.partial_json !== "string") return false;
        toolInputs.set(index, (toolInputs.get(index) ?? "") + delta.partial_json);
        return true;
      default: return false;
    }
  };

  return {
    kept: () => kept,
    read(event: unknown): void {
      const parsed = AnthropicEvent.safeParse(event);
      if (!parsed.success) return;
      const { type, index, content_block, delta, usage } = parsed.data;
      const block = index === undefined ? undefined : content[index];
      switch (type) {
        case "content_block_start":
          if (content_block === undefined || index !== content.length) {
            lost ??= "a content block out of order";
            break;
          }
          content.push(content_block);
          if (content_block.type === "web_search_tool_result") {
            observe("Web search", undefined, describeAnthropicSearch(content, content_block));
          }
          break;
        case "content_block_delta":
          if (index === undefined || block === undefined || delta === undefined ||
              !applyDelta(index, block, delta)) {
            // The error reaches the logs, which take none of a provider's content: so it names
            // the delta's type only when that is shaped like one of Anthropic's type names.
            const kind = delta?.type;
            lost ??= typeof kind === "string" && /^[a-z_]{1,40}$/.test(kind)
                ? `a "${kind}" delta` : "a delta of an unknown type";
          }
          break;
        case "content_block_stop": {
          // A client tool call's input is pi's to parse, and is not kept.
          const input = index === undefined ? undefined : toolInputs.get(index);
          if (block?.type !== "server_tool_use" || !input) break;
          try {
            block.input = JSON.parse(input);
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            lost ??= "a search whose input is not JSON";
          }
          break;
        }
        case "message_delta": {
          // A response may end with more than one of these, and not each carries the count.
          billed = usage?.server_tool_use?.web_search_requests ?? billed;
          const answered = new Set(content.flatMap(each =>
              each.type === "web_search_tool_result" ? [each.tool_use_id] : []));
          search.sources = citedSources(content);
          if (answered.size === 0) break;
          search.searched = { billed };
          if (lost !== undefined) {
            // Sending back anything but what Anthropic sent fails the chat's next request, or
            // makes the model search again. Failing here says why, where an operator looks.
            throw new Error(`Anthropic's response searched the web and its stream held ${lost}, ` +
                "which this version cannot send back as it was.");
          }
          kept = JSON.stringify(content.flatMap(each =>
              each.type === "server_tool_use" && !answered.has(each.id) ? []
              : each.type === "tool_use" ? [{ ...each, input: null }] : [each]));
          break;
        }
      }
    },
  };
}

// What ends the displayed answer of a response that cites web pages: a link to each page, in the
// order the answer first cites them. Undefined if it cites none. The links follow the whole
// answer, because one put where its passage ends can land inside a code block or a table row. A
// link's text is the page's host, the form GPT writes by itself.
function citedSources(content: Block[]): string | undefined {
  const links = new Map<string, string>();
  for (const block of content) {
    const cited = AnthropicCitations.safeParse(block);
    for (const { url } of cited.success ? cited.data.citations : []) {
      const page = url === undefined ? null : URL.parse(url);
      if (page === null || (page.protocol !== "https:" && page.protocol !== "http:")) continue;
      // A parenthesis would end the link's destination early.
      const href = page.href.replaceAll("(", "%28").replaceAll(")", "%29");
      links.set(href, `[${page.hostname.replace(/^www\./, "")}](${href})`);
    }
  }
  return links.size === 0 ? undefined : `\n\nSources: ${[...links.values()].join(", ")}`;
}

// Descriptions are built as the Web Search connector builds its own (see gatekeeper-websearch),
// with what the provider and the model chose as literal fields, so none of it is read as Markdown.
// The chat shows a record's title after "Read", so no title starts with that word.
const searchDescription = (provider: string, queries: string[]) => buildDescription(
    `Searched the public web with ${provider}'s search tool, inside the model request.`)
  .list("Queries", queries);

function describeOpenAiCall({ status, action }: OpenAiSearchCall): BuiltInSearchRecord {
  let title = "Search the web";
  let resource: [resourceTitle: string, resourceUrl: string | undefined] =
      ["Web search", undefined];
  let builder: ActionDescriptionBuilder;
  switch (action.type) {
    case "search":
      builder = searchDescription(
          "OpenAI", action.queries ?? (action.query === undefined ? [] : [action.query]));
      break;
    case "open_page":
    case "find_in_page": {
      title = "Open a web page";
      builder = buildDescription(
          "Opened a web page with OpenAI's search tool, inside the model request.");
      if (action.url != null) builder.inline("URL", action.url);
      if (action.pattern != null) builder.inline("Searched the page for", action.pattern);
      // Only a web URL is recorded as the page's, since Activity links to it.
      const page = action.url == null ? null : URL.parse(action.url);
      resource = page !== null && (page.protocol === "https:" || page.protocol === "http:")
          ? [`Web page: ${page.host}`, page.href] : ["Web page", undefined];
      break;
    }
    default:
      title = "Use the web search tool";
      builder = buildDescription(
          "OpenAI's search tool ran an action the Workshop does not know, inside the model " +
          `request: ${codeSpan(action.type)}.`);
  }
  // What a call that failed or was cut short asked for may still have left.
  if (status !== "completed") builder.inline("Status", status);
  const { description, fields } = builder.finish();
  return [...resource, { title, description, fields }];
}

// The record of the search `result` answers: the query of the `server_tool_use` block it names,
// and the results' titles and URLs or the error's code.
function describeAnthropicSearch(content: Block[], result: Block): ObservationDescription {
  const call = content.find(
      ({ type, id }) => type === "server_tool_use" && id === result.tool_use_id);
  const input = Block.safeParse(call?.input);
  const results = AnthropicSearchResults.safeParse(result.content);
  const error = AnthropicSearchError.safeParse(result.content);
  const builder = searchDescription(
      "Anthropic", input.success && typeof input.data.query === "string" ? [input.data.query] : []);
  if (results.success) {
    builder.list("Results", results.data.map(({ title, url }) => title ? `${title}: ${url}` : url));
  }
  if (error.success) builder.inline("Error", error.data.error_code);
  const { description, fields } = builder.finish();
  return { title: "Search the web", description, fields };
}
