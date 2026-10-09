/**
 * Who a connected browser is to the people sharing a gadget with it: an id, a display name and
 * a colour. Both sides use the shape -- the client introduces itself with it when subscribing and
 * draws other people's cursors in their colour; the server bounds what it is told before repeating
 * it to everyone else.
 */

/** Longest collaborator name kept; a longer one is cut, never rejected. */
export const MAX_NAME_LENGTH = 40;

/** Longest client id kept. Ids are minted far shorter; this only bounds abuse. */
export const MAX_CLIENT_ID_LENGTH = 100;

/** How a client is introduced to the others: its id and how to draw it. */
export interface Collaborator {
  /** The id the client's events carry, so that everyone can tell its events from their own. */
  clientId: string;
  /** Shown on its cursor and in the roster. */
  name: string;
  /** A CSS colour its cursor and selection are drawn in. */
  color: string;
}

/**
 * A colour a client may ask to be drawn in. Anything else falls back to {@link DEFAULT_COLOR}. The
 * separators are one character class rather than `\s*,?\s*`, whose two adjacent runs split a long
 * run of spaces every possible way when the match then fails; tested only on strings within
 * {@link MAX_COLOR_LENGTH}, since what arrives over RPC is whatever the client sent.
 */
const SAFE_COLOR = /^(?:#[0-9a-f]{3,8}|hsl\([\s,]*\d{1,3}(?:deg)?[\s,]*\d{1,3}%[\s,]*\d{1,3}%\s*\))$/i;

/** Longest colour considered; the longest {@link SAFE_COLOR} accepts is well under this. */
const MAX_COLOR_LENGTH = 40;

/** The colour of a collaborator whose own choice was unusable. */
export const DEFAULT_COLOR = "#e1632e";

/** The name of a collaborator who gave none. */
export const DEFAULT_NAME = "Guest";

/**
 * A self-declared guest identity for a browser tab: a name and a colour derived from its id, so
 * that two tabs with different ids look different and the same id always looks the same.
 */
export function collaboratorFor(clientId: string): Collaborator {
  const hue = parseInt(clientId.slice(0, 6), 36) % 360;
  return { clientId, name: `${DEFAULT_NAME} ${clientId.slice(0, 4).toUpperCase()}`, color: `hsl(${hue} 62% 48%)` };
}

/**
 * A collaborator's self-description as the server repeats it: every field a string, the id and
 * name bounded, a blank name defaulted and an unusable colour replaced. Accepts anything, since
 * what arrives over RPC is whatever the client sent.
 */
export function normalizeCollaborator(input: Partial<Collaborator> | null | undefined): Collaborator {
  return {
    clientId: String(input?.clientId ?? "").slice(0, MAX_CLIENT_ID_LENGTH),
    name: String(input?.name ?? "").trim().slice(0, MAX_NAME_LENGTH) || DEFAULT_NAME,
    color: safeColor(String(input?.color ?? "")),
  };
}

function safeColor(color: string): string {
  return color.length <= MAX_COLOR_LENGTH && SAFE_COLOR.test(color) ? color : DEFAULT_COLOR;
}
