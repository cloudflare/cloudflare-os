import { describe, expect, it } from "vitest";
import type { GoogleDocsTab, OptionalColor, TableCellBorder, TableCellStyle } from "../src/docs-api";
import { DEFAULT_CELL, readLook, renderLook } from "../src/docs-table-look";
import type { TableLook } from "../src/docs-table-look";
import {
  applyTableChange, readTableLook, replaceTableText, resolveTable, tableIdentity, tableLines,
  tableShape, tableTextRequests,
} from "../src/docs-tables";
import type { TableChange } from "../src/docs-tables";
import { docTabToMarkdown } from "../src/markdown-converter";
import type { EditableMarkdown } from "../src/markdown-converter";
import { buildTab } from "./doc-fixture";
import { applyDocsRequests } from "./docs-body-model";

type BlockSpec = Parameters<typeof buildTab>[0][number];
type TableSpec = Extract<BlockSpec, { table: unknown }>;
type CellSpec = TableSpec["table"][number][number];

const TAB = "tab-1";
const para = (text: string): BlockSpec => ({ runs: [`${text}\n`] });
const cell = (text: string, tableCellStyle: TableCellStyle): CellSpec =>
  ({ paragraphs: [{ runs: [`${text}\n`] }], tableCellStyle });
const pt = (magnitude: number) => ({ magnitude, unit: "PT" });
const rgb = (red: number, green: number, blue: number): OptionalColor =>
  ({ color: { rgbColor: { red, green, blue } } });
const SHADE = rgb(1, 0.8, 0);
const border = (width: number, dashStyle = "SOLID", color: OptionalColor = rgb(1, 0, 0)): TableCellBorder =>
  ({ width: pt(width), dashStyle, color });

/** Every default an inserted table has, set explicitly, as a table made in the editor may. */
const EXPLICIT_DEFAULTS: TableCellStyle = {
  rowSpan: 1, columnSpan: 1, backgroundColor: {}, contentAlignment: "TOP",
  paddingTop: pt(5), paddingRight: pt(5), paddingBottom: pt(5), paddingLeft: pt(5),
  borderTop: border(1, "SOLID", { color: { rgbColor: {} } }),
  borderRight: border(1, "SOLID", { color: { rgbColor: {} } }),
  borderBottom: border(1, "SOLID", { color: { rgbColor: {} } }),
  borderLeft: border(1, "SOLID", { color: { rgbColor: {} } }),
};

function render(table: TableSpec): string {
  let markdown = docTabToMarkdown(buildTab([para("Before"), table, para("After")])).markdown;
  return markdown.slice("Before\n\n".length, markdown.length - "\n\nAfter\n".length);
}

function read(tab: GoogleDocsTab): EditableMarkdown {
  let snapshot = docTabToMarkdown(tab);
  return {
    markdown: snapshot.markdown,
    protectedRanges: snapshot.sourceMap.protectedRanges,
    tables: snapshot.sourceMap.tables,
  };
}

const htmlOf = (content: EditableMarkdown, table: number) =>
  content.markdown.slice(content.tables[table].mdStart, content.tables[table].mdEnd);

function lookOf(content: EditableMarkdown, table = 0): TableLook {
  return readTableLook(tableLines(content.markdown, content.tables[table]), "test");
}

function message(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Expected a refusal");
}

describe("a table's look in getContent()", () => {
  it("reads as a bare table where every cell has the defaults, stored or left out", () => {
    let bare = render({ table: [["a\n", "b\n"]] });
    expect(bare).toBe("<table>\n  <tr>\n    <td><p>a</p></td>\n    <td><p>b</p></td>\n  </tr>\n</table>");
    expect(render({
      table: [[cell("a", EXPLICIT_DEFAULTS), cell("b", EXPLICIT_DEFAULTS)]],
      columns: [null, null], heights: [0],
    })).toBe(bare);
  });

  it("writes on <table> what most cells share, and on a cell only what differs from it", () => {
    let shaded = { backgroundColor: SHADE };
    expect(render({ table: [[cell("a", shaded), cell("b", shaded)], [cell("c", shaded), "d\n"]] }))
      .toBe(
        '<table style="background-color:#ffcc00">\n' +
        "  <tr>\n    <td><p>a</p></td>\n    <td><p>b</p></td>\n  </tr>\n" +
        '  <tr>\n    <td><p>c</p></td>\n    <td style="background-color:transparent"><p>d</p></td>\n  </tr>\n' +
        "</table>");
  });

  it("gives a tie to the default, and otherwise to the value reached first", () => {
    let tied = render({ table: [[cell("a", { contentAlignment: "MIDDLE" }), "b\n"]] });
    expect(tied).toContain('<table>\n  <tr>\n    <td style="vertical-align:middle"><p>a</p></td>');
    let first = render({ table: [[
      cell("a", { contentAlignment: "BOTTOM" }), cell("b", { contentAlignment: "MIDDLE" }),
    ]] });
    expect(first).toContain(
      '<table style="vertical-align:bottom">\n  <tr>\n    <td><p>a</p></td>\n' +
      '    <td style="vertical-align:middle"><p>b</p></td>');
  });

  it("writes four equal paddings or borders as one shorthand, and each side apart otherwise", () => {
    let even = { paddingTop: pt(8), paddingRight: pt(8), paddingBottom: pt(8), paddingLeft: pt(8) };
    let ringed = {
      borderTop: border(2), borderRight: border(2), borderBottom: border(2), borderLeft: border(2),
    };
    expect(render({ table: [[cell("a", { ...even, ...ringed })]] }))
      .toContain('<table style="padding:8pt;border:2pt solid #ff0000">');
    expect(render({ table: [[cell("a", { paddingTop: pt(8), paddingLeft: pt(0.5) }), "b\n"]] }))
      .toContain('<td style="padding-top:8pt;padding-left:0.5pt"><p>a</p></td>');
    expect(render({ table: [[cell("a", {
      borderTop: border(0), borderRight: border(1.5, "DOT", rgb(0, 0, 1)),
      borderBottom: border(2, "DASH"),
    }), "b\n"]] })).toContain(
      '<td style="border-top:none;border-right:1.5pt dotted #0000ff;' +
      'border-bottom:2pt dashed #ff0000"><p>a</p></td>');
  });

  it("writes fixed column widths in a colgroup line and least row heights on <tr>", () => {
    expect(render({ table: [["a\n", "b\n"], ["c\n", "d\n"]], columns: [120, null], heights: [0, 30] }))
      .toBe(
        "<table>\n  <colgroup><col style=\"width:120pt\"><col></colgroup>\n" +
        "  <tr>\n    <td><p>a</p></td>\n    <td><p>b</p></td>\n  </tr>\n" +
        '  <tr style="height:30pt">\n    <td><p>c</p></td>\n    <td><p>d</p></td>\n  </tr>\n' +
        "</table>");
    expect(render({ table: [["a\n"]], columns: [93.3333333], heights: [12.5] }))
      .toContain('<col style="width:93.333pt"></colgroup>\n  <tr style="height:12.5pt">');
  });

  it("shows a merged cell's block, and nothing for the cells it covers", () => {
    let html = render({ table: [
      [cell("head", { rowSpan: 2, columnSpan: 2, backgroundColor: SHADE }),
        cell("", { backgroundColor: SHADE, borderRight: border(3) }), "x\n"],
      [cell("", { borderBottom: border(4) }), cell("", { borderRight: border(3) }), "y\n"],
    ] });
    expect(html).toContain(
      '    <td rowspan="2" colspan="2" style="background-color:#ffcc00;border-right:3pt solid ' +
      '#ff0000;border-bottom:4pt solid #ff0000"><p>head</p></td>\n    <td><p></p></td>\n');
    expect(html).toContain("  <tr>\n    <td><p></p></td>\n    <td><p></p></td>\n    <td><p>y</p></td>");
  });

  it("shows the look of a table inside a cell, and still finds that table", () => {
    let content = read(buildTab([para("Before"), { table: [[{
      paragraphs: [{ runs: ["x\n"] }, { table: [[cell("in", { backgroundColor: SHADE })]] }, { runs: ["y\n"] }],
    }]] }, para("After")]));
    expect(htmlOf(content, 0)).toContain('      <table style="background-color:#ffcc00">\n');
    expect(tableLines(content.markdown, content.tables[0]).rows[0].cells[0].nested).toBe(true);
  });
});

describe("reading a look back", () => {
  const STYLED: TableSpec = {
    table: [
      [cell("a", { backgroundColor: SHADE, borderRight: border(2) }), cell("b", { borderLeft: border(2) })],
      [cell("c", { contentAlignment: "BOTTOM", paddingTop: pt(9) }), "d\n"],
    ],
    columns: [null, 80], heights: [24, 0],
  };

  it("reads back the look the tags write, and the same tags again", () => {
    let content = read(buildTab([para("Before"), STYLED, para("After")]));
    let look = lookOf(content);
    expect(look.columns).toEqual([null, 80]);
    expect(look.rows).toEqual([24, 0]);
    expect(look.cells[0][0]).toEqual({
      ...DEFAULT_CELL, "background-color": "#ffcc00", "border-right": "2pt solid #ff0000",
    });
    let rendered = renderLook(look);
    expect(rendered.cells[1][0]).toBe(' style="vertical-align:bottom;padding-top:9pt"');
  });

  it("refuses tags that are not exactly as the renderer writes them", () => {
    let covered = [[false]];
    let attributes = (style: string, table = "") => ({ table, rows: [""], cells: [[style]] });
    expect(readLook(attributes(""), covered)).toBeDefined();
    for (let style of [
      "color:red", "background-color:#FFCC00", "padding-top:5pt", "vertical-align:top",
      "border-top:1pt solid #000000", "padding-top:8pt;background-color:#ffcc00",
      "padding-top:8pt;padding-right:8pt;padding-bottom:8pt;padding-left:8pt", "padding-top:8.0001pt",
    ]) {
      expect(readLook(attributes(style), covered), style).toBeUndefined();
    }
    expect(readLook(attributes("", "background-color:transparent"), covered)).toBeUndefined();
    expect(readLook({ table: "", rows: [""], cells: [["", "background-color:#ffcc00"]] },
      [[false, true]])).toBeUndefined();
  });
});

describe("a table's identity", () => {
  const plain = (): TableSpec => ({ table: [["a\n", "b\n"], ["c\n", "d\n"]] });
  const restyled = (): TableSpec => ({
    table: [[cell("a", { backgroundColor: SHADE }), "b\n"], ["c\n", cell("d", { paddingLeft: pt(1) })]],
    columns: [100, null], heights: [0, 40],
  });

  it("leaves out the look of a table and of the tables in its cells", () => {
    let html = htmlOf(read(buildTab([para("Before"), restyled(), para("After")])), 0);
    let bare = htmlOf(read(buildTab([para("Before"), plain(), para("After")])), 0);
    expect(html).not.toBe(bare);
    expect(tableIdentity(html)).toBe(bare);
    expect(tableShape(html)).toBe(bare);
    expect(tableIdentity('<td rowspan="2" colspan="3" style="padding:0pt">'))
      .toBe('<td rowspan="2" colspan="3">');
    // A list's style in a cell is part of what the cell reads.
    expect(tableIdentity('<ol style="list-style-type: lower-alpha">')).toBe('<ol style="list-style-type: lower-alpha">');
  });

  it("keeps a queued row change to its table after a collaborator restyles and resizes it", () => {
    let before = read(buildTab([para("Before"), plain(), para("After")]));
    let change: TableChange =
      { type: "insertTableRows", at: 2, cells: [["e", "f"]], expected: tableIdentity(htmlOf(before, 0)) };
    let after = read(buildTab([para("Before"), restyled(), para("After")]));
    expect(resolveTable(after, change, "insertTableRows")).toBe(0);
    expect(htmlOf(applyTableChange(after, change), 0)).toContain("<p>e</p>");
  });

  it("refuses a change while another table differs from its own only in look", () => {
    let tab = buildTab([para("Before"), plain(), para("Mid"), restyled(), para("After")]);
    let content = read(tab);
    let change: TableChange =
      { type: "deleteTable", expected: tableIdentity(htmlOf(content, 1)) };
    expect(message(() => applyTableChange(content, change))).toContain(
      "another table of the tab now reads the same as the table this change was queued for");
  });
});

describe("replacing text in a styled table", () => {
  const TABLE: TableSpec = {
    table: [[cell("Name", { backgroundColor: SHADE, contentAlignment: "MIDDLE" }), "Total\n"]],
    columns: [90, null], heights: [20],
  };

  it("edits text beside styled tags as Google does", () => {
    let tab = buildTab([para("Before"), TABLE, para("After")]);
    let before = docTabToMarkdown(tab);
    let old = "<p>Name</p>";
    let matchStart = before.markdown.indexOf(old);
    let replayed = replaceTableText(read(tab), matchStart, old, "<p>Full name</p>", TAB);
    let requests = tableTextRequests(before, matchStart, old, "<p>Full name</p>");
    expect(replayed && requests).toBeTruthy();
    expect(replayed!.content.markdown).toBe(docTabToMarkdown(applyDocsRequests(tab, requests!)).markdown);
    expect(replayed!.content.markdown).toContain(
      '<td style="background-color:#ffcc00;vertical-align:middle"><p>Full name</p></td>');
  });

  it("refuses a change to a style attribute or the colgroup line", () => {
    let content = read(buildTab([para("Before"), TABLE, para("After")]));
    let refused = (old: string, replacement: string) => message(() =>
      replaceTableText(content, content.markdown.indexOf(old), old, replacement, TAB));
    let look = "replaceText: a table's look, which its tags' style attributes and the <colgroup> " +
      "line write, cannot be changed with replaceText(). Quote the text of cells, not their tags.";
    expect(refused("vertical-align:middle", "vertical-align:bottom")).toBe(look);
    expect(refused('<td><p>Total</p></td>', '<td style="padding:0pt"><p>Total</p></td>')).toBe(look);
    expect(refused('<col style="width:90pt">', '<col style="width:9pt">')).toBe(look);
    expect(refused('<tr style="height:20pt">', "<tr>")).toBe(look);
  });
});
