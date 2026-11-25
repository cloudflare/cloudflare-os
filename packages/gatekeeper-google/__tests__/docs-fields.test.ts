import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCUMENT_FIELDS, GoogleDocsApi, type GoogleDocsTab } from "../src/docs-api";
import {
  DOCS_API_FIELD_NAMES, docsGetResponse, InvalidFieldMask, parseFieldMask, poisonOutsideMask,
  rawDocsDocument, requestedFieldMask, selectFields, type FieldSelection,
} from "./docs-fields";

/** A selection as nested objects, `null` for a field asked whole. */
function shape(selection: FieldSelection): Record<string, unknown> {
  return Object.fromEntries(
    [...selection].map(([name, inside]) => [name, inside && shape(inside)]));
}

/** `answer` under `mask`. */
function masked(answer: unknown, mask: string): unknown {
  return selectFields(answer, parseFieldMask(mask));
}

/** A `documents.get` answer of one tab whose body holds `content`. */
function answerOf(content: unknown[]) {
  return {
    documentId: "doc-1",
    title: "Plan",
    tabs: [{
      tabProperties: { tabId: "t.0", title: "Tab", index: 0 },
      documentTab: { body: { content }, lists: {}, namedRanges: {} },
    }],
    revisionId: "revision-1",
  };
}

/** A paragraph of one text run, as Google sends a body element. */
function paragraph(text: string, startIndex: number) {
  return {
    startIndex,
    endIndex: startIndex + text.length,
    paragraph: {
      elements: [{
        startIndex, endIndex: startIndex + text.length, textRun: { content: text, textStyle: {} },
      }],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT", direction: "LEFT_TO_RIGHT" },
    },
  };
}

const SECTION_BREAK = { endIndex: 1, sectionBreak: { sectionStyle: {} } };

/** The address of a `documents.get` of `doc-1` with `query`. */
function url(query: string): URL {
  return new URL(`https://docs.googleapis.com/v1/documents/doc-1${query}`);
}

describe("the fake of Google's field masks", () => {
  it("parses names, parentheses, slashes and dots to the same selection", () => {
    let selection = { documentId: null, tabs: { documentTab: { body: { content: null } } } };
    for (let mask of [
      "documentId,tabs(documentTab(body(content)))",
      "documentId,tabs/documentTab/body/content",
      "documentId,tabs.documentTab.body.content",
      "documentId,tabs(documentTab/body(content))",
      "documentId,tabs(documentTab.body/content)",
    ]) {
      expect(shape(parseFieldMask(mask)), mask).toEqual(selection);
    }
    // A slash ends at the next comma, and a field named twice selects what both name.
    expect(shape(parseFieldMask("tabs/tabProperties/tabId,title,tabs(tabProperties(title),childTabs)")))
      .toEqual({ tabs: { tabProperties: { tabId: null, title: null }, childTabs: null }, title: null });
    // A field asked whole and also in part is whole, whichever comes first.
    expect(shape(parseFieldMask("tabs,tabs(childTabs),body(content),body")))
      .toEqual({ tabs: null, body: null });
  });

  it("refuses a mask that is not well formed", () => {
    for (let mask of [
      "", "title,", ",title", "tabs(title),", "tabs(", "tabs)", "tabs(,)", "tabs()", "tabs(title",
      "tabs title", "tabs/",
    ]) {
      expect(() => parseFieldMask(mask), JSON.stringify(mask)).toThrow(InvalidFieldMask);
    }
  });

  it("refuses a field name the Docs API does not have", () => {
    for (let mask of [
      "documentId,noSuchField",
      "tabs(documentTab(body(content(startIndex,noSuchField))))",
    ]) {
      expect(() => parseFieldMask(mask), mask).toThrow(InvalidFieldMask);
    }
  });

  // Google refuses both masks, for a name the type at that place does not have: the fake checks
  // that a name is one of the Docs API's, not where it stands.
  it("takes a known name wherever it stands", () => {
    let answer = answerOf([SECTION_BREAK, paragraph("One\n", 1), paragraph("Two\n", 5)]);
    expect(masked(answer, "tabs(title)")).toEqual({ tabs: [{}] });
    expect(masked(answer, "tabs(documentTab(body(content(paragraph(paragraphStyle(bold))))))"))
      .toEqual({ tabs: [{ documentTab: { body: { content: [
        {}, { paragraph: { paragraphStyle: {} } }, { paragraph: { paragraphStyle: {} } },
      ] } } }] });
  });

  it("refuses a wildcard and a selection inside the lists or the named ranges of a tab", () => {
    for (let mask of [
      "tabs(documentTab(lists(*(listProperties))))",
      "tabs(documentTab(namedRanges(*(namedRanges))))",
      "tabs(documentTab(lists/*/listProperties))",
      "tabs(documentTab(lists(listProperties)))",
      "tabs(documentTab/namedRanges/name)",
      "*",
      "tabs(*)",
    ]) {
      expect(() => parseFieldMask(mask), mask).toThrow(InvalidFieldMask);
    }
    // The two maps whole, and the list of ranges that a collection of the map holds.
    expect(shape(parseFieldMask("tabs(documentTab(lists,namedRanges)),namedRanges(name)"))).toEqual({
      tabs: { documentTab: { lists: null, namedRanges: null } }, namedRanges: { name: null },
    });
  });

  it("keeps every item of a list and selects inside each", () => {
    let answer = answerOf([SECTION_BREAK, paragraph("One\n", 1), paragraph("Two\n", 5)]);
    expect(masked(answer, "tabs(documentTab(body(content(startIndex,paragraph(elements(textRun(content)))))))"))
      .toEqual({ tabs: [{ documentTab: { body: { content: [
        {},
        { startIndex: 1, paragraph: { elements: [{ textRun: { content: "One\n" } }] } },
        { startIndex: 5, paragraph: { elements: [{ textRun: { content: "Two\n" } }] } },
      ] } } }] });
    expect(masked([{ tabId: "a", title: "A" }, { title: "B" }, { tabId: "c" }], "tabId"))
      .toEqual([{ tabId: "a" }, {}, { tabId: "c" }]);
    // A value that is no object has nothing to select inside, and is returned as it is.
    expect(masked({ title: null, tabs: [null, 3, "text"] }, "title(name),tabs(tabId)"))
      .toEqual({ title: null, tabs: [null, 3, "text"] });
  });

  it("keeps an object none of whose selected fields is set, as {}", () => {
    let presence = "tabs(documentTab(body(content(sectionBreak(suggestedInsertionIds)))))";
    let content = (answer: unknown) =>
      (masked(answer, presence) as ReturnType<typeof answerOf>).tabs[0].documentTab.body.content;
    expect(content(answerOf([SECTION_BREAK, paragraph("One\n", 1)]))).toEqual([{ sectionBreak: {} }, {}]);
    let suggested = {
      endIndex: 1, sectionBreak: { suggestedInsertionIds: ["suggest.1"], sectionStyle: {} },
    };
    expect(content(answerOf([suggested]))).toEqual([
      { sectionBreak: { suggestedInsertionIds: ["suggest.1"] } },
    ]);

    // The sample of Google's guide to field masks.
    let first = paragraph("One\n", 1);
    expect(masked(answerOf([SECTION_BREAK, first]), "title,tabs(documentTab(body.content(paragraph))),revisionId"))
      .toEqual({
        title: "Plan",
        tabs: [{ documentTab: { body: { content: [{}, { paragraph: first.paragraph }] } } }],
        revisionId: "revision-1",
      });
  });

  it("leaves out a field the answer does not hold, and keeps the answer's own key order", () => {
    let selected = masked(answerOf([SECTION_BREAK]), "revisionId,suggestedInsertionIds,title,documentId");
    expect(JSON.stringify(selected))
      .toBe('{"documentId":"doc-1","title":"Plan","revisionId":"revision-1"}');
    expect(JSON.stringify(masked({ title: "Plan" }, "revisionId"))).toBe("{}");
  });

  it("shares what is asked for whole", () => {
    let first = paragraph("One\n", 1);
    let answer = answerOf([SECTION_BREAK, first]);
    let before = JSON.stringify(answer);
    let selected = masked(answer, "tabs(tabProperties,documentTab(body(content(paragraph)),lists))") as typeof answer;
    expect(selected.tabs[0].tabProperties).toBe(answer.tabs[0].tabProperties);
    expect(selected.tabs[0].documentTab.lists).toBe(answer.tabs[0].documentTab.lists);
    expect((selected.tabs[0].documentTab.body.content[1] as typeof first).paragraph).toBe(first.paragraph);
    // What is selected in part is built anew, and the answer is as it was.
    expect(selected.tabs[0]).not.toBe(answer.tabs[0]);
    expect(JSON.stringify(answer)).toBe(before);
  });

  it("reads the mask from the header, else from the query", () => {
    let plain = url("?includeTabsContent=true");
    let queried = url("?fields=documentId,title");
    let header = new Headers({ "X-Goog-FieldMask": "revisionId" });
    expect(requestedFieldMask(plain, new Headers())).toBeUndefined();
    expect(requestedFieldMask(queried, new Headers())).toBe("documentId,title");
    expect(requestedFieldMask(plain, header)).toBe("revisionId");
    expect(requestedFieldMask(queried, header)).toBe("revisionId");
  });

  it("answers a read without a mask whole, a masked one in part, and a refused mask with a 400", async () => {
    let answer = answerOf([SECTION_BREAK, paragraph("Confidential\n", 1)]);

    let whole = docsGetResponse(url("?includeTabsContent=true"), new Headers(), answer);
    expect(whole.status).toBe(200);
    expect(await whole.json()).toEqual(answer);

    let queried = docsGetResponse(url("?fields=documentId,title,revisionId"), new Headers(), answer);
    expect(queried.status).toBe(200);
    expect(await queried.text()).toBe('{"documentId":"doc-1","title":"Plan","revisionId":"revision-1"}');

    let byHeader = docsGetResponse(
      url("?includeTabsContent=true"), new Headers({ "X-Goog-FieldMask": "revisionId" }), answer);
    expect(await byHeader.text()).toBe('{"revisionId":"revision-1"}');

    // A document that cannot be edited has no revision: the probe's answer is empty.
    let readOnly = { documentId: "doc-1", title: "Plan", tabs: answer.tabs };
    expect(await docsGetResponse(url("?fields=revisionId"), new Headers(), readOnly).text()).toBe("{}");

    for (let refused of [
      docsGetResponse(url("?fields=documentId,noSuchField"), new Headers(), answer),
      docsGetResponse(url(""), new Headers({ "X-Goog-FieldMask": "tabs(documentTab(lists(*)))" }), answer),
      docsGetResponse(url("?fields="), new Headers(), answer),
    ]) {
      expect(refused.status).toBe(400);
      let text = await refused.text();
      expect(JSON.parse(text)).toEqual({
        error: { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument." },
      });
      for (let held of ["doc-1", "Plan", "Confidential", "revision-1"]) expect(text).not.toContain(held);
    }
  });

  it("lists the field names in order and once each", () => {
    expect(DOCS_API_FIELD_NAMES.size).toBe(84);
    expect([...DOCS_API_FIELD_NAMES]).toEqual([...DOCS_API_FIELD_NAMES].toSorted());
    // The set drops a name written twice, so the names are read as the source writes them.
    let source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "docs-fields.ts"), "utf8");
    let literal = /DOCS_API_FIELD_NAMES: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(source);
    let written = Array.from(literal?.[1].matchAll(/"([^"]*)"/g) ?? [], match => match[1]);
    expect(written).toEqual([...DOCS_API_FIELD_NAMES]);
  });
});

/**
 * A tab of one paragraph, placed in the tab tree by `place`, that holds nothing the gatekeeper
 * does not ask Google for.
 */
function tabOf(
  tabId: string, place: Pick<GoogleDocsTab, "parentTabId" | "index" | "nestingLevel">,
): GoogleDocsTab {
  let endIndex = tabId.length + 2;
  return {
    tabId,
    title: `Tab ${tabId}`,
    ...place,
    body: {
      content: [{ startIndex: 0, endIndex: 1, sectionBreak: {} }, {
        startIndex: 1,
        endIndex,
        paragraph: {
          elements: [{ startIndex: 1, endIndex, textRun: { content: `${tabId}\n`, textStyle: {} } }],
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        },
      }],
    },
    lists: {},
    namedRanges: {},
  };
}

describe("the documents the fake answers with", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("nests the tabs of a document as Google does", async () => {
    let tabs = [
      tabOf("t.parent", { index: 0, nestingLevel: 0 }),
      tabOf("t.first", { parentTabId: "t.parent", index: 0, nestingLevel: 1 }),
      tabOf("t.grandchild", { parentTabId: "t.first", index: 0, nestingLevel: 2 }),
      tabOf("t.second", { parentTabId: "t.parent", index: 1, nestingLevel: 1 }),
    ];
    let document = { documentId: "doc-1", title: "Plan", revisionId: "revision-1", tabs };
    let raw = rawDocsDocument(document);
    let content = ({ body, lists, namedRanges }: GoogleDocsTab) => ({ body, lists, namedRanges });
    let properties = ({ tabId, title }: GoogleDocsTab) => ({ tabId, title });
    expect(raw).toStrictEqual({
      documentId: "doc-1",
      title: "Plan",
      revisionId: "revision-1",
      tabs: [{
        tabProperties: properties(tabs[0]),
        documentTab: content(tabs[0]),
        childTabs: [
          {
            tabProperties: properties(tabs[1]),
            documentTab: content(tabs[1]),
            childTabs: [{ tabProperties: properties(tabs[2]), documentTab: content(tabs[2]) }],
          },
          { tabProperties: properties(tabs[3]), documentTab: content(tabs[3]) },
        ],
      }],
    });
    // A document Google withholds the revision of, and a tab whose parent the document lacks.
    let { revisionId: _, ...withheld } = document;
    expect(rawDocsDocument({ ...withheld, tabs: [tabs[3]] })).toStrictEqual({
      documentId: "doc-1",
      title: "Plan",
      tabs: [{ tabProperties: properties(tabs[3]), documentTab: content(tabs[3]) }],
    });

    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) =>
      docsGetResponse(new URL(input), new Headers(init?.headers), raw));
    expect(await new GoogleDocsApi(async () => "token").getDocument("doc-1"))
      .toStrictEqual(document);
  });

  it("poisons what a mask does not ask for, and nothing it asks for", () => {
    let first = paragraph("One\n", 1);
    let answer = answerOf([SECTION_BREAK, first]);
    let before = JSON.stringify(answer);
    let mask = "documentId,tabs(tabProperties(tabId),documentTab(body(content(paragraph)),lists))";
    let poisoned = poisonOutsideMask(answer, mask) as Record<string, any>;
    let [tab] = poisoned.tabs;

    // A primitive, a list and an object the mask does not name, at each depth it selects inside.
    expect(poisoned.title).toStrictEqual({ unasked: true });
    expect(poisoned.revisionId).toStrictEqual({ unasked: true });
    expect(tab.tabProperties).toStrictEqual({
      tabId: "t.0", title: { unasked: true }, index: { unasked: true }, unasked: "unasked",
    });
    expect(tab.documentTab.namedRanges).toBe("unasked");
    expect(tab.documentTab.body.content[0]).toStrictEqual({
      endIndex: { unasked: true }, sectionBreak: "unasked", unasked: "unasked",
    });
    expect(poisonOutsideMask({ tabs: [{ childTabs: [{}] }] }, "tabs(tabProperties)"))
      .toStrictEqual({ tabs: [{ childTabs: "unasked", unasked: "unasked" }], unasked: "unasked" });
    // Every object the mask selects inside gained the field, and no other did.
    for (let selected of [
      poisoned, tab, tab.tabProperties, tab.documentTab, tab.documentTab.body,
      ...tab.documentTab.body.content,
    ]) {
      expect(selected.unasked).toBe("unasked");
    }
    // What is asked whole is the answer's, in a copy of its own.
    expect(poisoned.documentId).toBe("doc-1");
    expect(tab.documentTab.lists).toStrictEqual(answer.tabs[0].documentTab.lists);
    expect(tab.documentTab.lists).not.toBe(answer.tabs[0].documentTab.lists);
    expect(tab.documentTab.body.content[1].paragraph).toStrictEqual(first.paragraph);
    expect(tab.documentTab.body.content[1].paragraph).not.toBe(first.paragraph);
    expect(JSON.stringify(answer)).toBe(before);
    expect(masked(poisoned, mask)).toStrictEqual(masked(answer, mask));
  });

  it("poisons nothing the fields asked of a document select", () => {
    // A tab with fields the gatekeeper does not ask for, at every depth the mask selects inside.
    let unread = paragraph("One\n", 1);
    Object.assign(unread.paragraph.elements[0].textRun.textStyle, {
      bold: true, weightedFontFamily: { fontFamily: "Arial", weight: 400 },
    });
    let table = {
      startIndex: 5,
      endIndex: 12,
      table: {
        rows: 1,
        columns: 1,
        tableRows: [{
          startIndex: 6,
          endIndex: 11,
          tableCells: [{
            startIndex: 7, endIndex: 11, content: [paragraph("Two\n", 8)],
            tableCellStyle: { rowSpan: 1, columnSpan: 1, zzUnread: true },
          }],
          tableRowStyle: { minRowHeight: { magnitude: 12, unit: "PT" }, preventOverflow: false },
        }],
      },
    };
    let whole = rawDocsDocument({
      documentId: "doc-1",
      title: "Plan",
      revisionId: "revision-1",
      tabs: [{
        ...tabOf("t.0", { index: 0, nestingLevel: 0 }),
        body: { content: [SECTION_BREAK, unread, table] },
        namedRanges: { mark: { namedRanges: [{ namedRangeId: "range.1", name: "mark" }] } },
        documentStyle: { pageSize: {} },
      } as GoogleDocsTab],
    });
    let poisoned = poisonOutsideMask(whole, DOCUMENT_FIELDS) as Record<string, any>;
    expect(masked(poisoned, DOCUMENT_FIELDS)).toStrictEqual(masked(whole, DOCUMENT_FIELDS));

    let { documentTab } = poisoned.tabs[0];
    let [sectionBreak, text, grid] = documentTab.body.content;
    expect(documentTab.documentStyle).toBe("unasked");
    expect(text.paragraph.paragraphStyle.direction).toStrictEqual({ unasked: true });
    expect(text.paragraph.elements[0].textRun.textStyle.weightedFontFamily).toBe("unasked");
    expect(grid.table.rows).toStrictEqual({ unasked: true });
    expect(grid.table.tableRows[0].tableRowStyle.preventOverflow).toStrictEqual({ unasked: true });
    // A section break, a cell's style and the named ranges are asked for whole.
    expect(sectionBreak.sectionBreak)
      .toStrictEqual((whole.tabs as any[])[0].documentTab.body.content[0].sectionBreak);
    expect(grid.table.tableRows[0].tableCells[0].tableCellStyle)
      .toStrictEqual({ rowSpan: 1, columnSpan: 1, zzUnread: true });
    expect(documentTab.namedRanges).toStrictEqual((whole.tabs as any[])[0].documentTab.namedRanges);
  });
});
