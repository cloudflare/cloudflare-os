import type { Message, ProviderHeaders, Usage } from "@earendil-works/pi-ai";
import type { ModelHandle } from "./ai-models.js";

/**
 * An all-zeros pi Usage record, for synthesizing assistant messages that were never actually
 * produced by a live model call (chat-history replay, compaction prompts).
 */
export function zeroUsage(): Usage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * A failed model request, thrown by completeText() and the agent turn loop. pi never throws for
 * provider failures -- it reports them as a final assistant message with stopReason "error" --
 * so this converts that shape back into an exception for callers that expect one (the overseer's
 * turn error triage and the one-shot completion helpers).
 */
export class AgentTurnError extends Error {
  /** HTTP status of the failing request, when the handle observed a response for it. */
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Best-effort HTTP status extraction for a failed request. pi reports provider failures as
 * error text only, and its onResponse callback never fires for a request the SDK failed (so
 * the request's `response` metadata is unset then) -- but the error text conventionally opens
 * with the status code: bare in the provider SDKs' own messages (e.g. "400 {...}"), and in
 * parentheses behind the prefix pi's OpenAI adapter adds ("OpenAI API error (400): ..."). Either
 * is enough for the overseer's triage (report 5xx/unknown, skip expected 4xx). Only the opening
 * of the text is read, so digits a provider puts elsewhere in it are never taken for a status.
 */
export function httpStatusFromError(errorMessage: string, response: ModelHandle["lastResponse"])
    : number | undefined {
  const match = /^(?:(\d{3})\b|OpenAI API error \((\d{3})\))/.exec(errorMessage.trim());
  if (match) return Number(match[1] ?? match[2]);
  return response?.status;
}

/**
 * Run a single non-streaming-style completion against a ModelHandle and return the response
 * text. Used for one-shot calls: title generation, binding naming, compaction summaries, and
 * LanguageModelBinding.run. Requests thinking off unless asked (one-shots should be quick, and
 * none of them benefit from extended thinking; pre-pi, these calls never configured thinking
 * either), and prompt caching off unless asked. Throws AgentTurnError on provider failure, or the
 * abort reason when `signal` fired.
 */
export async function completeText(handle: ModelHandle, args: {
  systemPrompt?: string;
  /** Convenience: wraps into a single user message. Exactly one of `prompt`/`messages` required. */
  prompt?: string;
  messages?: Message[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** Headers for this request alone, beside the handle's own (see ModelHandle.stream). */
  headers?: ProviderHeaders;
  /**
   * When true, the request asks for what an agent's turn on the handle would: its reasoning
   * level, or its model's built-in request (see ModelStreamOptions.thinking). Default: false.
   */
  thinking?: boolean;
  /**
   * When true, the provider may cache the prompt, for a caller that sends the same prompt prefix
   * again. Default: false, because caching a prompt that is sent once only adds the cost of the
   * cache write.
   */
  cache?: boolean;
}): Promise<string> {
  const messages: Message[] = args.messages ??
      [{ role: "user", content: args.prompt ?? "", timestamp: Date.now() }];
  const stream = await handle.stream(handle.model, {
    systemPrompt: args.systemPrompt,
    messages,
  }, {
    maxTokens: args.maxTokens,
    signal: args.signal,
    headers: args.headers,
    thinking: args.thinking ?? false,
    ...(args.cache ? {} : { cacheRetention: "none" }),
  });
  const message = await stream.result();
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    // Surface a cancellation as the abort reason, like a directly-aborted request would.
    args.signal?.throwIfAborted();
    const errorMessage = message.errorMessage ?? "The model request failed.";
    throw new AgentTurnError(errorMessage, httpStatusFromError(errorMessage, handle.lastResponse));
  }
  return message.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");
}
