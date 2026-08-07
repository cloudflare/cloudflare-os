// Thinking-level clamping shared between the Workshop client and server. The backend clamps a
// requested level with pi-ai's own `clampThinkingLevel(model, level)` directly (see
// workshop-backend/src/agent.ts) -- pi-ai is backend-only (it bundles the provider streaming
// SDKs), so the browser can't import it. `clampThinkingLevel` itself needs a `Model<Api>` only to
// derive its supported-levels list; the actual clamp is a pure function of that list plus the
// request. `clampThinkingLevel` below reimplements exactly that pure part (verified against
// pi-ai's real behavior for cataloged models in workshop-backend's ai-models.test.ts), so the chat
// composer's picker -- which only ever has a supported-levels list, from
// Overseer.listThinkingLevels() -- clamps identically to the backend without needing the model
// itself.
import type { ThinkingLevel } from "./api.js";

// Ascending order of thinking levels, off through max. Mirrors pi-ai's own internal ordering.
export const THINKING_LEVEL_ORDER: ThinkingLevel[] =
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Clamps a requested thinking level to one of `supportedLevels`. Mirrors pi-ai's
 * `clampThinkingLevel`: an unsupported request first walks *upward* toward "max" for the nearest
 * supported level, and only falls back downward if nothing at or above qualifies. This is why a
 * model that cannot have thinking disabled (its `thinkingLevelMap` excludes "off", e.g. Fable 5)
 * clamps a requested "off" *up* to its lowest supported level rather than failing or forcing a
 * fake "off" that doesn't exist for that model. `supportedLevels` need not be sorted or
 * deduplicated.
 */
export function clampThinkingLevel(
    supportedLevels: ThinkingLevel[], requested: ThinkingLevel): ThinkingLevel {
  const supported = new Set(supportedLevels);
  if (supported.has(requested)) return requested;
  const requestedIndex = THINKING_LEVEL_ORDER.indexOf(requested);
  for (let i = requestedIndex; i < THINKING_LEVEL_ORDER.length; i++) {
    const candidate = THINKING_LEVEL_ORDER[i];
    if (supported.has(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = THINKING_LEVEL_ORDER[i];
    if (supported.has(candidate)) return candidate;
  }
  return supportedLevels[0] ?? "off";
}
