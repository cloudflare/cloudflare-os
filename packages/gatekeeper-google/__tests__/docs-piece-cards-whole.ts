// THE CARDS FROM A TAB IN HAND: what a preparation answers, made from one rendering of the
// whole tab and the two whole Markdown strings, before and after the edit. A reference that
// no source calls, kept because the cards from stored runs (the piece around the edit, the
// runs' summaries, the stored Markdown of the runs in which the tab reads otherwise) are held
// to the cards from the whole tab.
//
// WHAT IT HOLDS AND WHAT IT DOES NOT. `wholeTextReplacement` and `wholeAppend` are the two
// text preparations written over a tab in hand with exported functions alone, so a text
// edit's card from stored runs is held to them field by field. `wholeTableChange` is
// `tableChangeFrom`, the one function a table change is prepared by, over the whole tab's
// reading: it holds that a table change's card from stored runs (the piece, the summaries,
// the line before the table, the strings of the runs that differ with their span and their
// tables) is the card from the whole tab (one rendering, the two whole strings and their
// span), THROUGH THE SAME CARD WRITERS. It does not hold what those writers write: that
// rests on the cards pinned byte for byte in `docs-table-actions.test.ts` (every kind of
// table change's card, whole, among them) and in the workerd suites.

import {
  changedSpan, findUniqueMarkdown, isBlankDocTab, makeDocEdit, renderTab,
} from "../src/docs-replay";
import type { GoogleDocsTab } from "../src/docs-api";
import { tableChangeFrom } from "../src/docs-table-actions";
import type {
  PreparedTableChange, PreparedTextReplacement, TableCall,
} from "../src/docs-table-actions";
import { replacementPath, resolveTable, wholeTabReading } from "../src/docs-tables";
import type { TableChange } from "../src/docs-tables";
import type { DocTableBorder, DocTableCellStyle } from "../src/docs-types";
import type { DocTabSnapshot } from "../src/markdown-converter";

/** What `prepareTextReplacement` answers of a replacement in `tab`, or throws what it throws. */
export function wholeTextReplacement(
  tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string, label: string,
): PreparedTextReplacement {
  let before = renderTab(tab);
  let { markdown } = before;
  let matchStart = findUniqueMarkdown(markdown, oldMarkdown, tab.tabId);
  let matchEnd = matchStart + oldMarkdown.length;
  let inTable =
    replacementPath(before, { matchStart, oldMarkdown, newMarkdown }).kind === "cells";
  let after = renderTab(makeDocEdit(tab, {
    type: "replaceText", oldMarkdown, newMarkdown, ...(inTable ? { inTable: true } : {}),
  }, before).after).markdown;
  let span = changedSpan(markdown, after, { start: matchStart, end: matchEnd });
  return {
    inTable,
    prose: inTable
      ? `Replace text in a table of tab ${label}. The values below are the table's HTML: ` +
        "Markdown syntax in them is written to the cells as typed."
      : `Replace text in tab ${label}.`,
    syntax: inTable ? "html" : "markdown",
    shown: {
      old: markdown.slice(span.start, span.beforeEnd),
      requested: markdown.slice(span.start, matchStart) + newMarkdown +
        markdown.slice(matchEnd, span.beforeEnd),
      rendered: after.slice(span.start, span.afterEnd),
    },
  };
}

/** What `prepareAppend` answers of an append to `tab`, or throws what it throws. */
export function wholeAppend(tab: GoogleDocsTab, markdown: string): string {
  let before = renderTab(tab);
  let after = renderTab(makeDocEdit(tab, { type: "appendText", markdown }, before).after).markdown;
  let added = after;
  if (!isBlankDocTab(before)) {
    let end = before.markdown.length;
    let span = changedSpan(before.markdown, after, { start: end, end });
    added = after.slice(span.start, span.afterEnd).replace(/^\n/, "");
  }
  return added.replace(/\n$/, "");
}

/** What `prepareTableChange` answers of `call` on `tab`, or throws what it throws. */
export function wholeTableChange(tab: GoogleDocsTab, call: TableCall, label: string): PreparedTableChange {
  let rendering = renderTab(tab);
  return tableChangeFrom(wholeTabReading(rendering), call, label, change => {
    let made = makeDocEdit(tab, change, rendering);
    return () => {
      let after = renderTab(made.after);
      return {
        before: rendering.markdown, after: after.markdown,
        span: changedSpan(rendering.markdown, after.markdown),
        tables: after.sourceMap.tables,
      };
    };
  });
}

/** A length a look stores (`"12pt"`), as a call gives it: its number of points. */
const pointsOf = (length: string): number => Number(length.slice(0, -2));

/** A border a look stores, as a call gives it. */
function borderOf(border: string): DocTableBorder | null {
  if (border === "none") return null;
  let [width, dash, color] = border.split(" ");
  return { width: pointsOf(width), dash: dash as DocTableBorder["dash"], color };
}

/** The style a call gives for the style a change stores: what the call's check turns into it. */
function styleOf(
  style: Extract<TableChange, { type: "setTableCellStyle" }>["style"],
): DocTableCellStyle {
  let call: DocTableCellStyle = {};
  if (style.background !== undefined) {
    call.background = style.background === "transparent" ? null : style.background;
  }
  if (style.verticalAlign !== undefined) {
    call.verticalAlign = style.verticalAlign as DocTableCellStyle["verticalAlign"];
  }
  if (style.padding) {
    call.padding = Object.fromEntries(
      Object.entries(style.padding).map(([side, length]) => [side, pointsOf(length)]));
  }
  if (style.border !== undefined) call.border = borderOf(style.border);
  if (style.borders) {
    call.borders = Object.fromEntries(
      Object.entries(style.borders).map(([edge, border]) => [edge, borderOf(border)]));
  }
  return call;
}

/**
 * The call that makes `change`, a table change as a replay stores it (by how its table
 * reads), in the tab `whole` renders: the table's number is where the change's table stands
 * among the tab's (`resolveTable`), and every other member is the change's own, a stored
 * style turned back into the style a call gives. THE MAPPING IS TO BE HELD by its caller:
 * the change `tableCallChange` answers for the call on the whole tab's reading is the
 * change handed here, or the call says less than the change.
 */
export function stepTableCall(change: TableChange, whole: DocTabSnapshot): TableCall {
  if (change.type === "insertTable") {
    let { rows, columns, cells, after } = change;
    return {
      method: "insertTable",
      table: { rows, columns, cells, ...(after === undefined ? {} : { after }) },
    };
  }
  let table = resolveTable(whole, change, change.type);
  switch (change.type) {
    case "insertTableRows":
      return { method: change.type, lines: { table, at: change.at, cells: change.cells } };
    case "insertTableColumns":
      return {
        method: change.type,
        lines: { table, at: change.at, count: change.cells[0].length, cells: change.cells },
      };
    case "deleteTableRows":
    case "deleteTableColumns":
      return { method: change.type, lines: { table, at: change.at, count: change.count } };
    case "deleteTable":
      return { method: change.type, table };
    case "setTableColumnWidths":
      return {
        method: change.type,
        columns: { table, at: change.at, count: change.count, width: change.width },
      };
    case "setTableRowHeights":
      return {
        method: change.type,
        rows: { table, at: change.at, count: change.count, height: change.height },
      };
    case "mergeTableCells": {
      let { row, column, rows, columns } = change;
      return { method: change.type, cells: { table, row, column, rows, columns } };
    }
    case "unmergeTableCells":
      return { method: change.type, cell: { table, row: change.row, column: change.column } };
    case "setTableCellStyle": {
      let { row, column, rows, columns, style } = change;
      return {
        method: change.type,
        cells: { table, row, column, rows, columns, style: styleOf(style) },
      };
    }
  }
}
