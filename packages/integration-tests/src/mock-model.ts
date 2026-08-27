import { z } from "zod";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";
import type { Handler } from "./network-interceptor.js";

const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
const USAGE = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const AUXILIARY_REQUEST = z.object({
  messages: z.tuple([z.object({ role: z.literal("user"), content: z.string() })]),
});

type AuxiliaryRequestKind = "thread-title" | "gadget-title" | "binding-name";
type AuxiliaryCompletion = {
  kind: AuxiliaryRequestKind;
  promptPrefix: string;
  response: string;
};

// Quick-model calls share the agent endpoint but are not agent steps, so they have their own queue.
const AUXILIARY_COMPLETIONS: AuxiliaryCompletion[] = [
  {
    kind: "thread-title",
    promptPrefix: "Generate a brief, descriptive title",
    response: "Test chat",
  },
  {
    kind: "gadget-title",
    promptPrefix: "Below is the log of a chat session that led to a coding agent writing code",
    response: "Test Gadget",
  },
  {
    kind: "binding-name",
    promptPrefix: "Choose a short, meaningful JavaScript identifier in ALL_CAPS_WITH_UNDERSCORES",
    response: "TEST_BINDING",
  },
];

function auxiliaryCompletion(body: unknown): AuxiliaryCompletion | undefined {
  const parsed = AUXILIARY_REQUEST.safeParse(body);
  if (!parsed.success) return undefined;
  return AUXILIARY_COMPLETIONS.find(
      completion => parsed.data.messages[0].content.startsWith(completion.promptPrefix));
}

export const SCRIPTED_MODEL_ID = "@cf/zai-org/glm-5.2";
export const SCRIPTED_MODEL_PROFILE: AiChatAuthorInfo = {
  type: "agent",
  id: SCRIPTED_MODEL_ID,
  name: "Scripted model",
};
export const SCRIPTED_MODEL_CONFIG: AiModelConfig = {
  provider: "cloudflare",
  model: SCRIPTED_MODEL_ID,
  accountId: "test-account",
  apiToken: "test-token",
};

type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type StreamedCompletionStep = { text: string } | { toolCall: ToolCall };
export type ChatCompletionStep = StreamedCompletionStep |
  { error: { status: number; message: string } } |
  { pending: true };

export type ScriptedChatCompletions = {
  handler: Handler;
  requests: unknown[];
  auxiliaryRequests: { kind: AuxiliaryRequestKind; body: unknown }[];
  remainingSteps(): number;
};

function event(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function stream(step: StreamedCompletionStep, index: number): Response {
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
  const auxiliaryRequests: { kind: AuxiliaryRequestKind; body: unknown }[] = [];
  const steps = [...script];
  let responseIndex = 0;
  return {
    requests,
    auxiliaryRequests,
    remainingSteps: () => steps.length,
    handler: async (url, method, _headers, request) => {
      if (method !== "POST" || !url.pathname.endsWith(CHAT_COMPLETIONS_SUFFIX)) return null;
      const body: unknown = await request.json();
      const auxiliary = auxiliaryCompletion(body);
      if (auxiliary !== undefined) {
        auxiliaryRequests.push({ kind: auxiliary.kind, body });
        return stream({ text: auxiliary.response }, responseIndex++);
      }
      requests.push(body);
      const step = steps.shift();
      if (step === undefined) throw new Error("The fake model received more requests than scripted");
      if ("pending" in step) {
        const response = Promise.withResolvers<Response>();
        const onAbort = () => {
          const reason = request.signal.reason;
          response.reject(reason instanceof Error ? reason : new Error("Model request aborted"));
        };
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
        return response.promise.finally(() =>
          request.signal.removeEventListener("abort", onAbort));
      }
      if ("error" in step) {
        return new Response(step.error.message, { status: step.error.status });
      }
      return stream(step, responseIndex++);
    },
  };
}

/** Answer an OpenAI-compatible streaming chat request with one fixed text response. */
export function mockChatCompletion(text: string): Handler {
  return (url, method) => method === "POST" && url.pathname.endsWith(CHAT_COMPLETIONS_SUFFIX)
    ? stream({ text }, 0) : null;
}
