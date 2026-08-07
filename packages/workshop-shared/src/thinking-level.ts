// Thinking-level clamping shared between the Workshop client and server. This is the single
// source of truth for "given a requested level and what a model actually supports, what level
// should be used" -- the backend calls it before sending a request (see resolveThinkingLevel() in
// workshop-backend/src/ai-models.ts, which wraps this with a real Model's supported-levels list),
// and the chat composer calls it with the same list (fetched via Overseer.listThinkingLevels()) so
// the picker's displayed selection and what actually gets sent can never diverge.
import type { ThinkingLevel } from "./api.js";

// Ascending order of thinking levels, off through max. Mirrors pi-ai's own internal ordering.
export const THINKING_LEVEL_ORDER: ThinkingLevel[] =
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Clamps a requested thinking level to one of `supportedLevels`, falling back to the highest
 * supported level at or below the request, or "off" if nothing at or below it is supported
 * either. `supportedLevels` need not be sorted or deduplicated.
 */
export function resolveThinkingLevel(
    supportedLevels: ThinkingLevel[], requested: ThinkingLevel): ThinkingLevel {
  const supported = new Set(supportedLevels);
  if (supported.has(requested)) return requested;
  for (let i = THINKING_LEVEL_ORDER.indexOf(requested) - 1; i >= 0; i--) {
    const candidate = THINKING_LEVEL_ORDER[i];
    if (supported.has(candidate)) return candidate;
  }
  return "off";
}
