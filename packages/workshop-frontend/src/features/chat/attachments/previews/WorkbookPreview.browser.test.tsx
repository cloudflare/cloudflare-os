/* eslint-disable react/react-in-jsx-scope */
// A workbook drawn as a sheet, in Chromium: the grid measures text on a canvas, sticks its headers
// and frozen panes, and draws only the rows near the viewport, none of which jsdom lays out.
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { buildStyledXlsx, type StyledXlsxFixture } from "@gadgets/office-content/test-fixtures";
import { ThemeProvider } from "../../../../ThemeContext";
import { WorkbookPreview } from "./WorkbookPreview";
import "../../../../styles.css";

let host: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

const mount = async (fixture: StyledXlsxFixture) => {
  const bytes = await buildStyledXlsx(fixture);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <ThemeProvider>
      <div className="h-[400px] w-[600px]">
        <Suspense fallback={null}>
          <WorkbookPreview bytes={bytes} name="book.xlsx" mimeType="application/octet-stream" />
        </Suspense>
      </div>
    </ThemeProvider>,
  ));
};

const text = (reference: string, value: string, style = 0) =>
  `<c r="${reference}" s="${style}" t="inlineStr"><is><t>${value}</t></is></c>`;
const number = (reference: string, value: number, style = 0) => `<c r="${reference}" s="${style}"><v>${value}</v></c>`;

const cell = (name: string) => page.getByRole("cell", { name, exact: true });
const scroller = () => host!.querySelector<HTMLElement>(".overflow-auto")!;

const decoration = (name: string) => getComputedStyle(cell(name).element().firstElementChild!).textDecorationLine;

const FONTS = '<fonts><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FFFF0000"/><name val="Calibri"/></font></fonts>';
const FILLS = '<fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFEB9C"/></patternFill></fill></fills>';

it("draws cells with the file's formatting, sizes and default alignment", async () => {
  await mount({
    styles:
      '<numFmts><numFmt numFmtId="164" formatCode="$#,##0.00"/></numFmts>' + FONTS + FILLS +
      '<borders><border/><border><bottom style="medium"><color rgb="FF0000FF"/></bottom></border></borders>' +
      '<cellXfs><xf/><xf numFmtId="164"/><xf fontId="1" fillId="2" borderId="1"><alignment horizontal="center"/></xf></cellXfs>',
    sheets: [{
      name: "Budget",
      before: '<cols><col min="1" max="1" width="21.42578125" customWidth="1"/><col min="3" max="3" width="9" hidden="1"/></cols>',
      rows:
        `<row r="1" ht="30" customHeight="1">${text("A1", "Item", 2)}${text("B1", "Q1")}${text("C1", "Secret")}</row>` +
        `<row r="2">${text("A2", "Rent")}${number("B2", 1200, 1)}<c r="D2" t="b"><v>1</v></c></row>` +
        `<row r="3" hidden="1">${text("A3", "Unseen")}</row>`,
    }],
  });

  const heading = cell("Item").element();
  await expect.element(cell("$1,200.00")).toBeVisible();
  expect(heading.getBoundingClientRect().width).toBe(150);
  expect(heading.getBoundingClientRect().height).toBe(40);
  expect(getComputedStyle(heading).backgroundColor).toBe("rgb(255, 235, 156)");
  expect(getComputedStyle(heading).borderBottom).toBe("2px solid rgb(0, 0, 255)");
  const headingText = getComputedStyle(heading.firstElementChild!);
  expect([headingText.color, headingText.fontWeight, headingText.textAlign]).toEqual(["rgb(255, 0, 0)", "700", "center"]);
  // Paper, whatever the app's theme: a cell with no fill is white, its text black.
  expect(getComputedStyle(heading.closest("table")!).backgroundColor).toBe("rgb(255, 255, 255)");

  const aligned = (name: string) => getComputedStyle(cell(name).element().firstElementChild!).textAlign;
  expect([aligned("Rent"), aligned("$1,200.00"), aligned("TRUE")]).toEqual(["left", "right", "center"]);

  // Hidden rows and columns are left out, and the headers keep the sheet's own letters and numbers.
  expect(page.getByText("Secret").query()).toBeNull();
  expect(page.getByText("Unseen").query()).toBeNull();
  await expect.element(page.getByRole("columnheader", { name: "D", exact: true })).toBeVisible();
  expect(page.getByRole("columnheader", { name: "C", exact: true }).query()).toBeNull();
  expect(page.getByRole("rowheader", { name: "3", exact: true }).query()).toBeNull();
});

it("joins merged cells and runs long text over its empty neighbours", async () => {
  await mount({
    sheets: [{
      name: "Layout",
      rows:
        `<row r="1">${text("A1", "Title")}</row>`,
      after: '<mergeCells count="1"><mergeCell ref="A1:C2"/></mergeCells>',
    }, {
      name: "Spill",
      rows:
        `<row r="2">${text("A2", "A long label that needs more than one column")}${text("E2", "stop")}</row>` +
        `<row r="3">${text("A3", "A long label that is cut by its neighbour")}${number("B3", 7)}</row>`,
    }],
  });
  const title = cell("Title").element() as HTMLTableCellElement;
  expect([title.colSpan, title.rowSpan, title.getBoundingClientRect().width]).toEqual([3, 2, 192]);

  await page.getByRole("tab", { name: "Spill" }).click();
  const spilled = cell("A long label that needs more than one column").element();
  const cut = cell("A long label that is cut by its neighbour").element();
  expect(spilled.firstElementChild!.getBoundingClientRect().width).toBeGreaterThan(64);
  expect(spilled.firstElementChild!.getBoundingClientRect().right).toBeLessThanOrEqual(cell("stop").element().getBoundingClientRect().left);
  // Its own column, less the gridline.
  expect(cut.firstElementChild!.getBoundingClientRect().width).toBe(63);
});

it("draws only the rows near the viewport and keeps headers and frozen rows in view", async () => {
  await mount({
    sheets: [{
      name: "Tall",
      before: '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews>',
      rows: `<row r="1">${text("A1", "Heading")}</row>` +
        Array.from({ length: 599 }, (_, index) => `<row r="${index + 2}">${text(`A${index + 2}`, `Row ${index + 2}`)}</row>`).join(""),
    }],
  });
  await expect.element(cell("Row 2")).toBeVisible();
  expect(page.getByText("Row 600").query()).toBeNull();

  const view = scroller();
  await act(async () => {
    view.scrollTop = view.scrollHeight;
    view.dispatchEvent(new Event("scroll"));
  });
  await expect.element(cell("Row 600")).toBeVisible();
  expect(page.getByText("Row 2", { exact: true }).query()).toBeNull();
  // The whole sheet's height is scrollable though few of its rows are in the page.
  expect(view.scrollHeight).toBeGreaterThan(600 * 20);
  expect(view.querySelectorAll("tbody tr").length).toBeLessThan(120);

  const top = view.getBoundingClientRect().top;
  const header = page.getByRole("columnheader", { name: "A", exact: true }).element().getBoundingClientRect();
  const frozen = cell("Heading").element().getBoundingClientRect();
  expect([header.top - top, frozen.top - top]).toEqual([0, 20]);
});

it("keeps a frozen column's letter over its cells as the sheet scrolls sideways", async () => {
  await mount({
    sheets: [{
      name: "Wide",
      before: '<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" topLeftCell="B1" state="frozen"/></sheetView></sheetViews>',
      rows: `<row r="1">${text("A1", "Key")}${Array.from({ length: 40 }, (_, index) => number(`${String.fromCharCode(66 + (index % 25))}${index < 25 ? "" : "A"}1`, index)).join("")}</row>`,
    }],
  });
  await expect.element(cell("Key")).toBeVisible();
  const view = scroller();
  await act(async () => {
    view.scrollLeft = 280;
    view.dispatchEvent(new Event("scroll"));
  });
  const header = page.getByRole("columnheader", { name: "A", exact: true }).element().getBoundingClientRect();
  const frozen = cell("Key").element().getBoundingClientRect();
  expect(header.left).toBe(frozen.left);
});

it("opens only web and mail links, and says what it does not draw", async () => {
  await mount({
    styles: FONTS + '<cellXfs><xf/></cellXfs>',
    sheets: [{
      name: "Links",
      rows: `<row r="1">${text("A1", "site")}${text("B1", "script")}${text("C1", "place")}</row>`,
      after:
        '<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>TRUE</formula></cfRule></conditionalFormatting>' +
        '<hyperlinks><hyperlink ref="A1" r:id="rIdSite"/><hyperlink ref="B1" r:id="rIdScript"/><hyperlink ref="C1" location="Other!A1"/></hyperlinks>' +
        '<drawing r:id="rIdDrawing"/>',
      relationships: [
        { id: "rIdSite", type: "hyperlink", target: "https://example.com/", external: true },
        { id: "rIdScript", type: "hyperlink", target: "javascript:alert(1)", external: true },
        { id: "rIdDrawing", type: "drawing", target: "../drawings/drawing1.xml" },
      ],
    }],
    parts: {
      "xl/drawings/drawing1.xml": '<wsDr xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>',
      "xl/drawings/_rels/drawing1.xml.rels":
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" ' +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>',
    },
  });
  await expect.element(page.getByRole("link", { name: "site" })).toHaveAttribute("href", "https://example.com/");
  expect(host!.querySelectorAll("a")).toHaveLength(1);
  // Every linked cell looks like a link, whether or not it can be followed.
  expect([decoration("script"), decoration("place")]).toEqual(["underline", "underline"]);
  await expect.element(page.getByText("Charts and conditional formatting aren’t shown.")).toBeVisible();
});

it("fills the viewer with empty cells around a small sheet, with nothing to scroll", async () => {
  await mount({ sheets: [{ name: "Small", rows: `<row r="1">${text("A1", "name")}${text("B1", "owner")}</row>` }] });
  await expect.element(cell("name")).toBeVisible();

  // Padded to the viewer's size: more rows and columns than the sheet has, none past its edges.
  await expect.poll(() => host!.querySelectorAll("tbody tr:not([aria-hidden])").length).toBeGreaterThan(10);
  expect(host!.querySelectorAll("thead th").length).toBeGreaterThan(5);
  expect(scroller().scrollHeight).toBe(scroller().clientHeight);
  expect(scroller().scrollWidth).toBe(scroller().clientWidth);
});
