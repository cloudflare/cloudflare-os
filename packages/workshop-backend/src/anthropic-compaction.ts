// Anthropic on-demand compaction: the model writes the chat's compaction summary itself, from the
// conversation as it saw it, earlier thinking included, and returns it as a signed `compaction`
// block. Turns after the checkpoint send that block in place of the summary message, which keeps
// the thinking in the retained messages valid on models that check it against the conversation
// that produced it. See platform.claude.com/docs/en/build-with-claude/compaction-on-demand.
//
// Which messages to summarize stays the agent's decision (see findCompactionBoundary); this module
// only changes who writes the summary and how a turn sends it.
//
// The thinking stays valid only under the conditions in compaction-thinking-blocks. When the
// boundary falls between two messages of the same role, or the checkpoint changes the system
// prompt (its gadget list or always-available resources), the API drops it, as pi's `drop_block`
// asks, and the turn runs as it would after a summary the agent wrote.

import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { z } from "zod";
import { AgentTurnError, httpStatusFromError } from "./ai-invoke.js";
import type { ModelHandle, ModelStreamOptions } from "./ai-models.js";

const COMPACTION_BETA = "compact-2026-09-04";

const COMPACTION_MODELS: Record<string, true> = {
  "claude-fable-5-1": true,
  "claude-mythos-5-1": true,
  "claude-fable-5": true,
  "claude-mythos-5": true,
  "claude-mythos-preview": true,
  "claude-opus-5-5": true,
  "claude-opus-5": true,
  "claude-opus-4-8": true,
  "claude-opus-4-7": true,
  "claude-opus-4-6": true,
  "claude-sonnet-5-5": true,
  "claude-sonnet-5": true,
  "claude-sonnet-4-6": true,
  "claude-haiku-5-5": true,
};

type Stream = ModelHandle["stream"];

// The parts of pi's Anthropic request and of the response events that compaction reads.
const Payload = z.looseObject({
  messages: z.array(z.unknown()),
  betas: z.array(z.string()).optional(),
});
const RoleMessage = z.looseObject({ role: z.string(), content: z.unknown() });
// pi sends a message's text as a string, or as one text block when it marks the message for caching.
const UserText = z.object({
  role: z.literal("user"),
  content: z.union([
    z.string(),
    z.tuple([z.looseObject({ type: z.literal("text"), text: z.string() })]),
  ]),
});
const CompactionBlockStart = z.object({
  type: z.literal("content_block_start"),
  content_block: z.looseObject({ type: z.literal("compaction"), content: z.string() }),
});
const CompactionIterations = z.object({
  type: z.literal("message_delta"),
  usage: z.object({
    iterations: z.array(z.object({
      type: z.string(),
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    })),
  }),
});

/** Whether Anthropic can write `model`'s compaction summaries. */
export function supportsAnthropicCompaction(model: Model<Api>): boolean {
  return model.api === "anthropic-messages" && model.provider === "anthropic" &&
      Object.hasOwn(COMPACTION_MODELS, model.id);
}

/** A summary Anthropic wrote: its text, and the block that carries it, as JSON. */
export type AnthropicCompaction = { summary: string; block: string };

/**
 * Have Anthropic summarize the messages of `context`, which must be the request a turn would send
 * if they were the whole chat: the same system prompt, tools and options, since the thinking in
 * the retained messages stays valid only if those match. `stream` is `handle`'s, possibly wrapped.
 * Throws AgentTurnError, as completeText does, when the request fails, and an Error when the model
 * ends without a summary (for example by calling a tool); the chat can compact later.
 */
export async function requestAnthropicCompaction(
    handle: ModelHandle, stream: Stream, context: Context, instructions: string,
    options: ModelStreamOptions): Promise<AnthropicCompaction> {
  let block: z.infer<typeof CompactionBlockStart>["content_block"] | undefined;
  const response = stream(handle.model, context, {
    ...options,
    onPayload: async (payload, payloadModel) => {
      const replaced = await options.onPayload?.(payload, payloadModel) ?? payload;
      const request = Payload.safeParse(replaced);
      if (!request.success) return replaced;
      return {
        ...request.data,
        messages: withoutTrailingEffort(request.data.messages),
        betas: withCompactionBeta(request.data.betas),
        // The request carries the turn's tools, and the model may call one instead of summarizing.
        compaction: { type: "summarize", instructions: `${instructions}\n\nDo not call tools.` },
      };
    },
    onProviderStreamEvent: async (event, eventModel) => {
      await options.onProviderStreamEvent?.(event, eventModel);
      // The block arrives whole in its start event.
      const start = CompactionBlockStart.safeParse(event);
      if (start.success) block = start.data.content_block;
      reportCompactionAsTurn(event);
    },
  });
  const result = await response.result();
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    const message = result.errorMessage ?? "The compaction request failed.";
    throw new AgentTurnError(message, httpStatusFromError(message, handle.lastResponse));
  }
  if (block === undefined || block.content.trim() === "") {
    throw new Error(`Compaction produced no summary (stop reason ${result.rawStopReason}).`);
  }
  return { summary: block.content, block: JSON.stringify(block) };
}

/**
 * Wrap `stream` so every request sends `block`, unchanged, where the transcript starts with the
 * summary message `summaryText`. Anthropic rejects an altered block.
 */
export function withAnthropicCompactionBlock(
    stream: Stream, block: string, summaryText: string): Stream {
  // Parsed once: every request carries the same object.
  const parsed: unknown = JSON.parse(block);
  return (model, context, options = {}) => stream(model, context, {
    ...options,
    onPayload: async (payload, payloadModel) => {
      const replaced = await options.onPayload?.(payload, payloadModel) ?? payload;
      const request = Payload.safeParse(replaced);
      if (!request.success) return replaced;
      const [summary, ...kept] = request.data.messages;
      const first = UserText.safeParse(summary);
      const text = !first.success ? undefined
        : typeof first.data.content === "string" ? first.data.content : first.data.content[0].text;
      if (text !== summaryText) {
        throw new Error("The request does not start with the compaction summary.");
      }
      // The retained messages follow the block directly. pi restates each assistant message's
      // effort in a system message before it, but in the request that produced the message that
      // level ended the summarized messages, so it is part of what the block replaced.
      if (isEffortOnly(kept[0])) kept.shift();
      return {
        ...request.data,
        messages: [{ role: "assistant", content: [parsed] }, ...kept],
        betas: withCompactionBeta(request.data.betas),
      };
    },
  });
}

// The system message pi appends to every request to set its effort. The summarized messages must
// end as they did in the request that produced the first retained one: a retained `user` message
// followed the last summarized one directly, so there the level is not part of the conversation.
// An `assistant` message was produced by a request that ended in it, so there it stays.
function withoutTrailingEffort(messages: unknown[]): unknown[] {
  const previous = RoleMessage.safeParse(messages.at(-2));
  return isEffortOnly(messages.at(-1)) && previous.success && previous.data.role === "assistant"
    ? messages.slice(0, -1) : messages;
}

function isEffortOnly(message: unknown): boolean {
  const parsed = RoleMessage.safeParse(message);
  return parsed.success && parsed.data.role === "system" &&
      Array.isArray(parsed.data.content) && parsed.data.content.length === 0;
}

function withCompactionBeta(betas: string[] = []): string[] {
  return betas.includes(COMPACTION_BETA) ? betas : [...betas, COMPACTION_BETA];
}

// A summary ends the response with stop reason "compaction", which pi does not know and fails the
// request on, and reports its tokens only in `usage.iterations`, leaving the top-level counts zero.
// Present it as the turn it was, so the request succeeds and its trace carries what it used. pi
// reads the event after this hook returns, so the rewrite is made on the event itself.
function reportCompactionAsTurn(event: unknown): void {
  if (typeof event !== "object" || event === null || !("delta" in event) ||
      typeof event.delta !== "object" || event.delta === null) {
    return;
  }
  if ("stop_reason" in event.delta && event.delta.stop_reason === "compaction") {
    event.delta.stop_reason = "end_turn";
  }
  const iterations = CompactionIterations.safeParse(event);
  const compaction = iterations.success
    ? iterations.data.usage.iterations.find(iteration => iteration.type === "compaction")
    : undefined;
  if (compaction === undefined || !("usage" in event) || typeof event.usage !== "object" ||
      event.usage === null) {
    return;
  }
  const { type: _, ...tokens } = compaction;
  Object.assign(event.usage, tokens);
}
