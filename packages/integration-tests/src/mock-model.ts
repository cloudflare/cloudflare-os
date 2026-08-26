import { z } from "zod";
import type { Handler } from "./network-interceptor.js";

const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
const USAGE = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const QUICK_TITLE_MARKER = "Generate a brief, descriptive title";
const TITLE_REQUEST = z.object({
  messages: z.tuple([z.object({ role: z.literal("user"), content: z.string() })]),
});

function isQuickTitleRequest(body: unknown): boolean {
  const parsed = TITLE_REQUEST.safeParse(body);
  return parsed.success && parsed.data.messages[0].content.startsWith(QUICK_TITLE_MARKER);
}

type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ChatCompletionStep = { text: string } | { toolCall: ToolCall };

export type ScriptedChatCompletions = {
  handler: Handler;
  requests: unknown[];
  titleRequests: unknown[];
  remainingSteps(): number;
};

function event(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function stream(step: ChatCompletionStep, index: number): Response {
  const base = {
    id: `mock-completion-${index}`,
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
  };
  const delta = "text" in step
    ? { role: "assistant", content: step.text }
    : {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: step.toolCall.id,
          type: "function",
          function: {
            name: step.toolCall.name,
            arguments: JSON.stringify(step.toolCall.arguments),
          },
        }],
      };
  const finishReason = "text" in step ? "stop" : "tool_calls";
  const body = event({
    ...base,
    choices: [{ index: 0, delta, finish_reason: null }],
  }) + event({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: USAGE,
  }) + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Answer matching model requests with scripted text or tool-call responses, in order. */
export function scriptedChatCompletions(script: readonly ChatCompletionStep[])
    : ScriptedChatCompletions {
  const requests: unknown[] = [];
  const titleRequests: unknown[] = [];
  const steps = [...script];
  let responseIndex = 0;
  return {
    requests,
    titleRequests,
    remainingSteps: () => steps.length,
    handler: async (url, method, _headers, request) => {
      if (method !== "POST" || !url.pathname.endsWith(CHAT_COMPLETIONS_SUFFIX)) return null;
      const body: unknown = await request.json();
      if (isQuickTitleRequest(body)) {
        titleRequests.push(body);
        return stream({ text: "Test chat" }, responseIndex++);
      }
      requests.push(body);
      const step = steps.shift();
      if (step === undefined) throw new Error("The fake model received more requests than scripted");
      return stream(step, responseIndex++);
    },
  };
}

/** Answer an OpenAI-compatible streaming chat request with one fixed text response. */
export function mockChatCompletion(text: string): Handler {
  return (url, method) => method === "POST" && url.pathname.endsWith(CHAT_COMPLETIONS_SUFFIX)
    ? stream({ text }, 0) : null;
}
