// Placing a new tab in a Google Doc's flattened tab tree, as `addDocumentTab` places it.

import type { DocTabSnapshot } from "./markdown-converter";

/** The deepest `nestingLevel` a tab may have: Google keeps a tab tree to three levels. */
const MAX_DOC_TAB_NESTING_LEVEL = 2;

/** The longest tab title Google takes, in UTF-16 code units. */
const MAX_DOC_TAB_TITLE_LENGTH = 50;

/** Where a new tab goes: under `parentTabId`, at `index` among its children, last when absent. */
export type DocTabPlacement = { parentTabId?: string; index?: number };

/**
 * Refuses a title Google would not keep as given: it names an empty one "Tab <n>", turns a line
 * break into a space, and refuses one longer than 50 code units.
 */
export function checkDocTabTitle(title: string): void {
  if (title.trim() === "") throw new Error("addTab: title must not be empty.");
  if (/[\r\n\v]/.test(title)) throw new Error("addTab: title must be one line.");
  if (title.length > MAX_DOC_TAB_TITLE_LENGTH) {
    throw new Error(`addTab: title must be at most ${MAX_DOC_TAB_TITLE_LENGTH} characters.`);
  }
}

/**
 * `tabs`, flattened depth-first with parents before children, with `tab` added where `placement`
 * puts it: its parent, index and depth set to match, and its later siblings' indexes shifted.
 * Refuses a parent that is not in `tabs`, one already as deep as Google nests, and an index that
 * is not an integer from 0 to the parent's child count, as Google does.
 */
export function insertDocTab<T extends DocTabSnapshot>(
  tabs: T[], tab: T, { parentTabId, index }: DocTabPlacement,
): T[] {
  let parentAt = parentTabId === undefined ? -1 : tabs.findIndex(t => t.tabId === parentTabId);
  let parent = tabs[parentAt];
  if (parentTabId !== undefined && !parent) {
    throw new Error(
      `addTab: no tab with ID "${parentTabId}" exists in this document. ` +
      "Call listTabs() to refresh the tab list.");
  }
  if (parent && parent.nestingLevel >= MAX_DOC_TAB_NESTING_LEVEL) {
    throw new Error(
      `addTab: Google Docs nests tabs at most three levels deep, so tab "${parentTabId}" ` +
      "cannot hold another tab.");
  }
  let siblings = tabs.filter(t => t.parentTabId === parentTabId);
  let at = index ?? siblings.length;
  if (!Number.isInteger(at) || at < 0 || at > siblings.length) {
    throw new Error(
      `addTab: index must be an integer from 0 to ${siblings.length}, the number of tabs ` +
      (parent ? `under tab "${parentTabId}".` : "at the top level."));
  }

  // Before the sibling it displaces, or else after the parent's last descendant.
  let position = at < siblings.length ? tabs.indexOf(siblings[at]) : tabs.length;
  if (at === siblings.length && parent) {
    position = parentAt + 1;
    while (position < tabs.length && tabs[position].nestingLevel > parent.nestingLevel) position++;
  }
  let { parentTabId: _, ...rest } = tab;
  let placed = {
    ...rest,
    ...parentTabId === undefined ? {} : { parentTabId },
    index: at,
    nestingLevel: parent ? parent.nestingLevel + 1 : 0,
  } as T;
  let shifted = tabs.map(t =>
    t.parentTabId === parentTabId && t.index >= at ? { ...t, index: t.index + 1 } : t);
  return [...shifted.slice(0, position), placed, ...shifted.slice(position)];
}
