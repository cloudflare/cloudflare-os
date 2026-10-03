import { contentText, getInitialSystemMessage } from "@earendil-works/pi-ai";
import type { Api, Context, Model } from "@earendil-works/pi-ai";

// The leading system prompt as a static and a dynamic block, for prompt caching.
//
// The agent's leading system message carries the text every chat of its kind shares as its
// `content`, and the chat's project-specific text as its `sections` (see runAgentPass). pi renders
// both as one system block, so a change to the project-specific text would miss the cache from
// the start of the prompt. The onPayload hook that ai-models.ts installs on every model handle
// splits that block at the end of the content and marks a cache breakpoint there. The two blocks
// concatenate to exactly the text pi rendered.
//
// - anthropic-messages: pi's breakpoint on the system block moves to the static block, so the
//   request keeps the same number of breakpoints (Anthropic allows 4).
// - openai-responses, GPT-5.6 and later: the leading developer message becomes two input_text
//   parts, with an explicit prompt_cache_breakpoint on the first. These models look up cached
//   prefixes only at message ends; older ones cache at fixed intervals and don't support the field.
// - Other APIs: unchanged.
//
// Drop this if pi sends a system message's content and sections as separate blocks with a
// breakpoint after the content: https://github.com/earendil-works/pi/issues/10370

/**
 * Split the leading system prompt of a provider request payload into a static and a dynamic
 * block, with a cache breakpoint after the static one. For requests with prompt caching on;
 * `context` is the transcript pi built the payload from. Returns the rewritten payload, or
 * undefined when there is nothing to split (matching pi's onPayload contract, where undefined
 * keeps the payload unchanged).
 */
export function splitSystemPrompt(
    model: Model<Api>, context: Context, payload: unknown): unknown | undefined {
  const leading = getInitialSystemMessage(context.messages);
  const staticText = leading ? contentText(leading.content) : "";
  if (staticText === "" || typeof payload !== "object" || payload === null) return undefined;
  switch (model.api) {
    case "anthropic-messages": return splitAnthropicSystem(payload, staticText);
    case "openai-responses":
      return supportsExplicitBreakpoints(model)
          ? splitOpenAiResponsesInstructions(payload, staticText)
          : undefined;
    default: return undefined;
  }
}

// Whether pi rendered `text` as the static text followed by more (the sections). Anything else --
// no sections, or text pi sanitized differently -- is left unsplit.
const continuesPast = (text: unknown, staticText: string): text is string =>
    typeof text === "string" && text.length > staticText.length && text.startsWith(staticText);

// Per pi's catalog, only GPT-5.6 and later accept prompt cache options.
function supportsExplicitBreakpoints(model: Model<Api>): boolean {
  const compat = model.compat;
  return compat !== undefined && "supportsExplicitPromptCacheMode" in compat &&
      compat.supportsExplicitPromptCacheMode === true;
}

function splitAnthropicSystem(payload: object, staticText: string): object | undefined {
  if (!("system" in payload) || !Array.isArray(payload.system)) return undefined;
  const system: unknown[] = payload.system;
  // The prompt is the last block (OAuth requests put an identity block before it), and carries
  // the breakpoint pi placed on it.
  const prompt = system.at(-1);
  if (typeof prompt !== "object" || prompt === null || !("cache_control" in prompt) ||
      !("text" in prompt) || !continuesPast(prompt.text, staticText)) {
    return undefined;
  }
  const { cache_control, ...block } = prompt;
  return {
    ...payload,
    system: [
      ...system.slice(0, -1),
      { ...block, text: staticText, cache_control },
      { ...block, text: prompt.text.slice(staticText.length) },
    ],
  };
}

function splitOpenAiResponsesInstructions(payload: object, staticText: string): object | undefined {
  if (!("input" in payload) || !Array.isArray(payload.input)) return undefined;
  const [instructions, ...rest]: unknown[] = payload.input;
  if (typeof instructions !== "object" || instructions === null || !("role" in instructions) ||
      (instructions.role !== "developer" && instructions.role !== "system") ||
      !("content" in instructions) || !continuesPast(instructions.content, staticText)) {
    return undefined;
  }
  return {
    ...payload,
    input: [
      {
        ...instructions,
        content: [
          { type: "input_text", text: staticText, prompt_cache_breakpoint: { mode: "explicit" } },
          { type: "input_text", text: instructions.content.slice(staticText.length) },
        ],
      },
      ...rest,
    ],
  };
}
