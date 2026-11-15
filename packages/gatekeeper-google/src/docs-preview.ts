// A Google Doc preview (Gatekeeper.previewResource()): the document as its pending edits leave it,
// with the Markdown it carries per tab bounded.

import type { DocumentEdit, ResourcePreview } from "@gadgets/workshop-shared/gatekeeper";
import {
  applyGoogleDocActionToContent, findUniqueMarkdown, googleDocActionCommitted, googleDocActionTab,
  googleDocSimulatedContent, newGoogleDocTab, type GoogleDocEditAction, type GoogleDocPendingAction,
  type GoogleDocSimulation, type GoogleDocSnapshot,
} from "./doc-actions";
import { insertDocTab } from "./docs-tabs";
import { canonicalizeMarkdownForWrite, canonicalizeMarkdownReplacement } from "./markdown-converter";

/** A range of a tab's Markdown, in UTF-16 code units, that a preview must keep. */
export type MarkdownSpan = { start: number; end: number };

/**
 * The most Markdown of one tab a preview carries. A tab within it is returned whole; a longer one
 * is cut down to the parts around its edits.
 */
export const MAX_PREVIEW_TAB_MARKDOWN = 256 * 1024;

/** How much Markdown a cut-down tab keeps on each side of an edit, before snapping to a block. */
export const PREVIEW_EDIT_CONTEXT = 4 * 1024;

/** The paragraph that stands in for Markdown left out of a cut-down tab. */
export function previewTrimPlaceholder(omitted: number): string {
  return `*[${omitted.toLocaleString("en-US")} characters of this tab are not shown in this preview.]*`;
}

/**
 * `markdown`, cut down to at most about MAX_PREVIEW_TAB_MARKDOWN if longer.
 *
 * Keeps PREVIEW_EDIT_CONTEXT around each span in `keep`, widened to the nearest paragraph break
 * (or, failing that, line break) within another PREVIEW_EDIT_CONTEXT, and replaces each run left
 * out with one placeholder paragraph (previewTrimPlaceholder). Spans are kept in document order
 * until the budget is spent: the first is always kept whole, so one edit larger than the budget
 * still shows, and the rest of an over-budget tab is left out. With nothing to keep, the tab's
 * beginning is.
 *
 * Cuts follow Markdown's lines, not its structure, so a cut inside a table or code block leaves
 * the placeholder inside it. Cuts are always at least PREVIEW_EDIT_CONTEXT from a kept span.
 */
export function trimDocumentPreviewMarkdown(markdown: string, keep: MarkdownSpan[]): string {
  if (markdown.length <= MAX_PREVIEW_TAB_MARKDOWN) return markdown;

  let windows = keep.length === 0
    ? [{ start: 0, end: blockEnd(markdown, MAX_PREVIEW_TAB_MARKDOWN) }]
    : keep
      .map(({ start, end }) => ({
        start: blockStart(markdown, start - PREVIEW_EDIT_CONTEXT),
        end: blockEnd(markdown, end + PREVIEW_EDIT_CONTEXT),
      }))
      .toSorted((a, b) => a.start - b.start);

  let kept: MarkdownSpan[] = [];
  let length = 0;
  for (let window of windows) {
    let last = kept.at(-1);
    if (last && window.start <= last.end) {
      if (window.end <= last.end) continue;
      if (length + window.end - last.end > MAX_PREVIEW_TAB_MARKDOWN) break;
      length += window.end - last.end;
      last.end = window.end;
      continue;
    }
    if (last && length + window.end - window.start > MAX_PREVIEW_TAB_MARKDOWN) break;
    length += window.end - window.start;
    kept.push({ ...window });
  }

  let parts: string[] = [];
  let cursor = 0;
  for (let { start, end } of kept) {
    if (start > cursor) parts.push(placeholderBlock(start - cursor));
    parts.push(markdown.slice(start, end));
    cursor = end;
  }
  if (cursor < markdown.length) parts.push(placeholderBlock(markdown.length - cursor));
  return parts.join("");
}

function placeholderBlock(omitted: number): string {
  return `\n\n${previewTrimPlaceholder(omitted)}\n\n`;
}

/** Where a kept window starting near `index` begins: just after a break at or before it. */
function blockStart(markdown: string, index: number): number {
  if (index <= 0) return 0;
  let floor = index - PREVIEW_EDIT_CONTEXT;
  let paragraph = markdown.lastIndexOf("\n\n", index);
  if (paragraph !== -1 && paragraph >= floor) return paragraph + 2;
  let line = markdown.lastIndexOf("\n", index);
  if (line !== -1 && line >= floor) return line + 1;
  return avoidSplitSurrogate(markdown, index);
}

/** Where a kept window ending near `index` ends: just after a break at or after it. */
function blockEnd(markdown: string, index: number): number {
  if (index >= markdown.length) return markdown.length;
  let ceiling = index + PREVIEW_EDIT_CONTEXT;
  let paragraph = markdown.indexOf("\n\n", index);
  if (paragraph !== -1 && paragraph <= ceiling) return paragraph + 1;
  let line = markdown.indexOf("\n", index);
  if (line !== -1 && line <= ceiling) return line + 1;
  return avoidSplitSurrogate(markdown, index);
}

/** `index`, moved back one if it would split a surrogate pair. */
function avoidSplitSurrogate(markdown: string, index: number): number {
  let unit = markdown.charCodeAt(index);
  return unit >= 0xdc00 && unit <= 0xdfff ? index - 1 : index;
}

/**
 * What one pending edit puts in place of what, as the replay applies it: `after` is the rendered
 * form the approval shows as "New" or "Resulting", which is what the simulated tab holds.
 */
function googleDocActionEdit(action: GoogleDocEditAction): { before: string; after: string } {
  switch (action.type) {
    case "replaceText":
      return {
        before: action.oldMarkdown,
        after: canonicalizeMarkdownReplacement(action.oldMarkdown, action.newMarkdown),
      };
    case "appendText":
      return { before: "", after: canonicalizeMarkdownForWrite(action.markdown) };
    default:
      action satisfies never;
      throw new Error("unknown Google Doc action type");
  }
}

/** How much of the text around an edit DocumentEdit.context carries, at most, on each side. */
const DOC_EDIT_CONTEXT = 48;

/**
 * The text on either side of where each pending edit landed, as the tab stood just after it
 * applied (see DocumentEdit.context), by action id. Replays the queue from the snapshot itself,
 * tabs it adds included, so an edit it cannot locate is simply left out.
 */
function googleDocEditContexts(
  snapshot: GoogleDocSnapshot,
  pending: GoogleDocPendingAction[],
): Map<number, { before: string; after: string }> {
  let contexts = new Map<number, { before: string; after: string }>();
  let tabs = snapshot.tabs;
  let contentByTabId = new Map(tabs.map(tab => [tab.tabId, googleDocSimulatedContent(tab)]));
  for (let { id, action } of pending) {
    if (action.invalidatedReason) continue;
    try {
      if (action.type === "addTab") {
        let tab = newGoogleDocTab(action);
        tabs = insertDocTab(tabs, tab, { parentTabId: action.parentTabId, index: action.index });
        contentByTabId.set(tab.tabId, googleDocSimulatedContent(tab));
        continue;
      }
      // The snapshot already holds it, so its text is not where the replay would put it.
      if (googleDocActionCommitted(snapshot, action)) continue;
      let { tabId } = googleDocActionTab({ ...snapshot, tabs }, action);
      let content = contentByTabId.get(tabId)!;
      let { after } = googleDocActionEdit(action);
      let start = action.type === "replaceText"
        ? findUniqueMarkdown(content.markdown, action.oldMarkdown, "previewResource", tabId)
        : undefined;
      let next = applyGoogleDocActionToContent(content, action, tabId);
      contentByTabId.set(tabId, next);
      let at = start ?? (after === "" ? next.markdown.length : next.markdown.lastIndexOf(after));
      if (at < 0 || next.markdown.slice(at, at + after.length) !== after) continue;
      contexts.set(id, {
        before: next.markdown.slice(Math.max(0, at - DOC_EDIT_CONTEXT), at),
        after: next.markdown.slice(at + after.length, at + after.length + DOC_EDIT_CONTEXT),
      });
    } catch {
      // Not locatable here; the preview draws the edit without its context.
    }
  }
  return contexts;
}

/**
 * The document as it will be once its pending edits apply (see Gatekeeper.previewResource()):
 * `simulation`, the replay of `pending` over `snapshot`, with each text edit marked in its tab.
 *
 * `pending` is the queue as the replay left it, so an edit it invalidated is omitted with its
 * reason. An edit whose write already committed is drawn too: the snapshot already shows it. A
 * tab an edit adds is drawn among the others, with no edit of its own.
 *
 * A tab longer than MAX_PREVIEW_TAB_MARKDOWN is cut down around where its edits' `after` text
 * lands (see trimDocumentPreviewMarkdown); a deletion leaves no text to find, so only the other
 * edits anchor what is kept.
 */
export function googleDocPreview(
  snapshot: GoogleDocSnapshot,
  simulation: GoogleDocSimulation,
  pending: GoogleDocPendingAction[],
  url: string | undefined,
): ResourcePreview {
  let actions: number[] = [];
  let omitted: { action: number; reason: string }[] = [];
  let editsByTabId = new Map<string, (DocumentEdit & { append: boolean })[]>();
  let contexts = googleDocEditContexts(snapshot, pending);
  for (let { id, action } of pending) {
    if (action.invalidatedReason) {
      omitted.push({ action: id, reason: action.invalidatedReason });
      continue;
    }
    if (action.type === "addTab") {
      actions.push(id);
      continue;
    }
    let tabId;
    try {
      tabId = googleDocActionTab({ ...snapshot, tabs: simulation.tabs }, action).tabId;
    } catch (error) {
      // Only a committed edit skipped the replay that would have invalidated it.
      omitted.push({ action: id, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    let edits = editsByTabId.get(tabId) ?? [];
    let context = contexts.get(id);
    edits.push({
      change: actions.length, ...googleDocActionEdit(action), append: action.type === "appendText",
      ...context ? { context } : {},
    });
    editsByTabId.set(tabId, edits);
    actions.push(id);
  }

  return {
    title: snapshot.title,
    ...url === undefined ? {} : { url },
    actions,
    ...omitted.length === 0 ? {} : { omitted },
    content: {
      type: "document",
      tabs: simulation.tabs.map(tab => {
        let { markdown } = simulation.contentByTabId.get(tab.tabId) ?? googleDocSimulatedContent(tab);
        let edits = editsByTabId.get(tab.tabId) ?? [];
        let keep = edits.flatMap(({ after, append, context }): MarkdownSpan[] => {
          if (context) {
            let around = context.before + after + context.after;
            let start = markdown.indexOf(around);
            if (start !== -1) return [{ start, end: start + around.length }];
          }
          if (after === "") return [];
          // An append lands at the end; a replacement's text may also occur earlier.
          let start = append ? markdown.lastIndexOf(after) : markdown.indexOf(after);
          return start === -1 ? [] : [{ start, end: start + after.length }];
        });
        return {
          id: tab.tabId,
          title: tab.title,
          markdown: trimDocumentPreviewMarkdown(markdown, keep),
          edits: edits.map(({ change, before, after, context }) =>
            ({ change, before, after, ...context ? { context } : {} })),
          ...tab.page ? { page: tab.page } : {},
        };
      }),
    },
  };
}
