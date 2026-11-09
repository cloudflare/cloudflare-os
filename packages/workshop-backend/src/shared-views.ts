// The owner's view of a shared gadget -- a copy of the gadget that holds its storage and none of
// its bindings -- and how often the copy is refreshed. See docs/sharing.md, "Shared views".

/**
 * The least time between refreshes of one gadget's view. A refresh clones the gadget's facet over
 * the view's, which drops the connections of everyone looking at it (the Workshop client
 * reconnects to the new copy), so an owner's reconnecting UI must not restart it on every
 * reconnect.
 */
export const VIEW_REFRESH_INTERVAL_MS = 60 * 1000;

/**
 * Most UTF-16 code units a view's requirement keys may total, the bound an observation's
 * subresources have, so the records keeping them stay well inside Durable Object storage's value
 * limit. A view whose audit could not be kept whole is not published.
 */
export const MAX_VIEW_REQUIREMENT_CHARS = 500_000;
