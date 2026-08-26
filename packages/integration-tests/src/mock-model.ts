import type { Handler } from "./network-interceptor.js";

const CHAT_COMPLETIONS_SUFFIX = "/workers-ai/v1/chat/completions";

function event(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Answer an OpenAI-compatible streaming chat request with one fixed text response. */
export function mockChatCompletion(text: string): Handler {
  return (url, method) => {
    if (method !== "POST" || !url.pathname.endsWith(CHAT_COMPLETIONS_SUFFIX)) return null;
    const base = {
      id: "mock-completion",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
    };
    const body = event({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    }) + event({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }) + "data: [DONE]\n\n";
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
}
