// The replay of queued Google Doc edits: requests built, refusals kept, keys, the fold over
// stored versions, and the span a card shows.

import {
  createSimulationStore, type EntityFold,
} from "@gadgets/gatekeeper-kit/simulation-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  blankDocTabToKeep, googleDocDisplayLimit, logModelRefusal, type GoogleDocAddTabAction,
} from "../src/doc-actions";
import { blankDocsTab } from "../src/docs-api";
import type { GoogleDocsRequest, GoogleDocsTab } from "../src/docs-api";
import * as model from "../src/docs-model";
import {
  applyDocsRequests, hasModelFootnotes, hasModelIndexes, NotModelledError, replayCost,
  unindexedTabRefusal,
} from "../src/docs-model";
import {
  applyDocEdit, applyDocRequests, changedSpan, docEditKey, docEditRequests, DocEditRefusedError,
  docEditResult, docEditTab, DocModelError, DocPieceOverreachError, docRefusal, docTabReducer,
  isBlankDocTab, makeDocEdit,
  materializeDocEdit, renderTab, replayableDocEdits,
} from "../src/docs-replay";
import type {
  DocEdit, DocEditResult, DocRefusal, QueuedDocEdit, QueuedDocRecord,
} from "../src/docs-replay";
import { storedDocCopy } from "../src/docs-copy";
import { DocReadingFault, storedTabReading } from "../src/docs-reading";
import { DOC_COPY_UNREADABLE, pruneTab } from "../src/docs-replica";
import { cutRuns, RUN_SIZES } from "../src/docs-runs";
import {
  DOC_ROW_BYTES, DocPieceError, DocRowTooLargeError, DocStore, docStoreCost,
} from "../src/docs-store";
import type { DocStoreCost, DocVersion } from "../src/docs-store";
import { prepareTextReplacement } from "../src/docs-table-actions";
import {
  closesTableGate, tableChangeRequests, tableGateRefusal, tableIdentity, textReplacementRequests,
} from "../src/docs-tables";
import {
  docTabToMarkdown, markdownToDocRequests, MARKDOWN_RENDERING_VERSION,
} from "../src/markdown-converter";
import type { DocTabSnapshot } from "../src/markdown-converter";
import { buildTab, diceOf, grid, para, tableAt, thrownMessage } from "./doc-fixture";
import { fakeDocStorage, fakeDocStore, type FakeDocStorage } from "./doc-store-fake";
import { CUTS } from "./docs-fetched-corpus";
import { fuzzedTabs, recordedTabs, throughJson, type NamedTab } from "./render-run-tabs";

const TAB = "tab-1";
const OTHER = "tab-2";

/** A tab of the fixture under another id. */
const tabAs = (tabId: string, tab: GoogleDocsTab): GoogleDocsTab => ({ ...tab, tabId });

/** The key the tests' document is stored under. */
const DOC = "doc";

/** The identity of the tab's table `index`, as a change to it records it. */
const expectedOf = (tab: GoogleDocsTab, index = 0) =>
  tableIdentity(tableAt(docTabToMarkdown(tab), index));

/** What `run` throws. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a throw");
}

const PROSE = () => buildTab([para("Hello world"), para("End")]);
const TABLED = () => buildTab([para("Before"), grid(["a", "b"], ["c", "d"]), para("After")]);

describe("docEditRequests", () => {
  const CELL = { oldMarkdown: "<p>a</p>", newMarkdown: "<p>A</p>" };
  const ROWS: DocEdit = {
    type: "insertTableRows", at: 1, cells: [["x", "y"]], expected: expectedOf(TABLED()),
  };

  it.each<[string, () => GoogleDocsTab, DocEdit, (render: DocTabSnapshot) => GoogleDocsRequest[]]>([
    ["builds a paragraph replacement at the one place its text stands", PROSE,
      { type: "replaceText", oldMarkdown: "world", newMarkdown: "there" },
      render => textReplacementRequests(
        render, { matchStart: 6, oldMarkdown: "world", newMarkdown: "there" })],
    ["builds a replacement queued for table cells as a change to the cells", TABLED,
      { type: "replaceText", ...CELL, inTable: true },
      render => textReplacementRequests(
        render, { matchStart: render.markdown.indexOf("<p>a</p>"), ...CELL, inTable: true })],
    ["writes the whole text of a blank tab", () => buildTab([para("")]),
      { type: "appendText", markdown: "# Title\n\nText" },
      render => markdownToDocRequests(
        "# Title\n\nText", render.bodyEndIndex - 1, TAB, { resetParagraphs: true })],
    ["writes a paragraph after the last of a tab that is not blank", PROSE,
      { type: "appendText", markdown: "- item" },
      render => markdownToDocRequests("\n- item", render.bodyEndIndex - 1, TAB, {
        resetParagraphs: true, preserveLeadingParagraph: true, tabBlocks: render.sourceMap.blocks,
      })],
    ["builds a table change with the table builder", TABLED, ROWS,
      render => tableChangeRequests(render, ROWS)],
  ])("%s", (_name, tab, edit, built) => {
    let render = docTabToMarkdown(tab());
    let requests = docEditRequests(render, edit);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests).toEqual(built(render));
  });

  it("builds nothing for an edit that changes nothing", () => {
    expect(docEditRequests(
      docTabToMarkdown(PROSE()), { type: "replaceText", oldMarkdown: "world", newMarkdown: "world" },
    )).toEqual([]);
  });

  it("tells a tab with no content from one whose content renders as nothing", () => {
    expect(isBlankDocTab(docTabToMarkdown(buildTab([para("")])))).toBe(true);
    expect(isBlankDocTab({ ...docTabToMarkdown(buildTab([para("")])), markdown: "" })).toBe(true);
    expect(isBlankDocTab(docTabToMarkdown(PROSE()))).toBe(false);

    // A chip with no label renders as nothing, and is protected.
    let chip = docTabToMarkdown(
      buildTab([{ runs: [{ richLink: { title: "", uri: "https://example.com/" } }, "\n"] }]));
    expect(chip.markdown).toBe("\n");
    expect(isBlankDocTab(chip)).toBe(false);
    expect(docEditRequests(chip, { type: "appendText", markdown: "Text" })).toEqual(
      markdownToDocRequests("\nText", chip.bodyEndIndex - 1, TAB, {
        resetParagraphs: true, preserveLeadingParagraph: true, tabBlocks: chip.sourceMap.blocks,
      }));
  });

  it("refuses a replacement whose text is empty, missing or there twice", () => {
    let render = docTabToMarkdown(buildTab([para("same"), para("same")]));
    let replace = (oldMarkdown: string) => thrownMessage(() =>
      docEditRequests(render, { type: "replaceText", oldMarkdown, newMarkdown: "other" }));
    expect(replace("")).toBe("replaceText: oldMarkdown must not be empty.");
    expect(replace("missing")).toBe(
      `replaceText: oldMarkdown was not found in the current simulated tab "${TAB}". ` +
      `Make sure the text exactly matches content returned by getContent("${TAB}").`);
    expect(replace("same")).toBe(
      `replaceText: oldMarkdown matches multiple locations in the current simulated tab ` +
      `"${TAB}". Include more surrounding context to make the match unique.`);
  });

  it("refuses an append to a tab that ends in a table", () => {
    let render = docTabToMarkdown(buildTab([para("Text"), grid(["a"])]));
    expect(thrownMessage(() => docEditRequests(render, { type: "appendText", markdown: "More" }))).toBe(
      "appendText: the selected tab does not end in a paragraph. " +
      "Add a paragraph after its final table or structural element and retry.");
  });

  it("refuses a replacement queued for table cells whose text is no longer in a table", () => {
    let render = docTabToMarkdown(TABLED());
    expect(thrownMessage(() => docEditRequests(
      render, { type: "replaceText", oldMarkdown: "Before", newMarkdown: "Earlier", inTable: true },
    ))).toBe(
      "replaceText: this change was queued for text in a table, and that text is no longer in one.");
  });
});

/** A request of a kind the builders never send, a batch Google refuses, and no request at all. */
const UNMODELLED = [{ replaceAllText: {} }] as unknown as GoogleDocsRequest[];
const lastLineBreak = (tab: GoogleDocsTab): GoogleDocsRequest[] => {
  let end = docTabToMarkdown(tab).bodyEndIndex;
  return [{ deleteContentRange: { range: { startIndex: end - 2, endIndex: end, tabId: TAB } } }];
};
const FAULTY = [undefined] as unknown as GoogleDocsRequest[];

describe("applyDocRequests", () => {
  it("returns the tab it was given when there is nothing to apply", () => {
    let tab = PROSE();
    expect(applyDocRequests(tab, "replaceText", [])).toBe(tab);
  });

  it("applies a batch as the model does, leaving the tab as it was", () => {
    let tab = PROSE();
    let before = structuredClone(tab);
    let after = applyDocRequests(tab, "replaceText", docEditRequests(
      docTabToMarkdown(tab), { type: "replaceText", oldMarkdown: "world", newMarkdown: "there" }));
    expect(docTabToMarkdown(after).markdown).toBe("Hello there\n\nEnd\n");
    expect(tab).toEqual(before);
  });

  it("says that a batch the model has no answer for cannot be shown, naming the shape", () => {
    let error = thrownBy(() => applyDocRequests(PROSE(), "replaceText", UNMODELLED));
    expect(error).toBeInstanceOf(DocModelError);
    let { message, cause, name } = error as DocModelError;
    expect(name).toBe("DocModelError");
    expect(cause).toBeInstanceOf(NotModelledError);
    expect(message).toBe(
      "replaceText: this change cannot be shown as it will read once applied " +
      `(${(cause as NotModelledError).what}), so it cannot be made through this connection. ` +
      "Make it in Google Docs.");
    expect(docRefusal(error)).toStrictEqual({
      reason: message, unmodelled: { what: "the request replaceAllText", invariant: true },
    });
  });

  it("says in Google's words what Google would refuse", () => {
    let tab = PROSE();
    let error = thrownBy(() => applyDocRequests(tab, "deleteTable", lastLineBreak(tab)));
    expect(error).toBeInstanceOf(DocModelError);
    let { message, cause } = error as DocModelError;
    expect(Object.getPrototypeOf(cause)).toBe(Error.prototype);
    expect(message).toBe(
      `deleteTable: Google Docs would refuse this change: ${(cause as Error).message}`);
    let refusal = docRefusal(error);
    expect(refusal.reason).toBe(message);
    expect(refusal.modelError?.name).toBe("Error");
    expect(refusal.unmodelled).toBeUndefined();
  });

  it("says nothing of what the model threw where the model is at fault", () => {
    let tab = PROSE();
    let fault = thrownBy(() => applyDocsRequests(tab, FAULTY));
    expect(fault).toBeInstanceOf(TypeError);
    let error = thrownBy(() => applyDocRequests(tab, "appendText", FAULTY));
    expect(error).toBeInstanceOf(DocModelError);
    let { message, cause } = error as DocModelError;
    expect(cause).toBeInstanceOf(TypeError);
    expect(message).toBe(
      "appendText: this change cannot be shown as it will read once applied, so it cannot be " +
      "made through this connection. Make it in Google Docs.");
    expect(message).not.toContain((cause as Error).message);
    let refusal = docRefusal(error);
    expect(refusal.modelError?.name).toBe("TypeError");
    expect(refusal.unmodelled).toBeUndefined();
    expect(JSON.stringify(refusal)).not.toContain((cause as Error).message);
  });
});

/** What a refusal keeps of `cause`, thrown by the model for a batch. */
const modelErrorOf = (cause: unknown) => docRefusal(new DocModelError("refused", cause)).modelError;
const framesOf = (cause: unknown) => modelErrorOf(cause)?.frames;

describe("docRefusal", () => {
  it("gives the reason alone for any error that is not the model's", () => {
    expect(docRefusal(new Error("a builder said no"))).toStrictEqual({ reason: "a builder said no" });
    expect(docRefusal(new Error("x", { cause: new TypeError("y") }))).toStrictEqual({ reason: "x" });
    expect(docRefusal("not an error")).toStrictEqual({ reason: "not an error" });
  });

  it("names what was thrown that is no error by its type, with no frames", () => {
    expect(modelErrorOf("a string")).toStrictEqual({ name: "string" });
  });

  it("locates a throw by the frames of its stack", () => {
    let frames = framesOf(thrownBy(() => { throw new TypeError("boom"); }));
    expect(frames).toBeTruthy();
    for (let line of frames!.split("\n")) expect(line).toMatch(/^\s+at /);
    expect(frames).toContain("docs-replay.test");
    expect(frames).not.toContain("boom");
  });

  it("keeps out a message that spans lines, one of them written as a frame", () => {
    let frames = framesOf(thrownBy(() => { throw new TypeError("secret one\n    at secret two"); }));
    expect(frames).not.toContain("secret one");
    expect(frames).not.toContain("secret two");
    expect(frames).toContain("docs-replay.test");
  });

  it("keeps out a message that was changed after the throw", () => {
    // Two lines, the second not written as a frame: taking one line off the head would keep it.
    let cause = thrownBy(() => { throw new TypeError("first words\nmore words"); }) as TypeError;
    // The stack is written when it is first read, with the message the error has then.
    expect(cause.stack).toContain("first words\nmore words\n");
    cause.message = "second words";
    expect(cause.stack?.startsWith(String(cause))).toBe(false);
    let frames = framesOf(cause);
    expect(frames).toBeTruthy();
    for (let line of frames!.split("\n")) expect(line).toMatch(/^\s+at /);
    expect(frames).not.toContain("first words");
    expect(frames).not.toContain("more words");
    expect(frames).not.toContain("second words");
    expect(frames).toContain("docs-replay.test");
  });

  it("has no frames for an error without a stack, or whose stack holds none", () => {
    let stackless = new TypeError("x");
    delete stackless.stack;
    expect(modelErrorOf(stackless)).toStrictEqual({ name: "TypeError" });
    let frameless = new TypeError("x");
    frameless.stack = "TypeError: x";
    expect(modelErrorOf(frameless)).toStrictEqual({ name: "TypeError" });
  });

  it("keeps no frames of a shape the model refuses on purpose", () => {
    let refusal = docRefusal(new DocModelError("refused", new NotModelledError("a shape", false)));
    expect(refusal).toStrictEqual({
      reason: "refused", unmodelled: { what: "a shape", invariant: false },
    });
  });
});

/** `edit` with one field changed, for the tests of `docEditKey`: a string longer, a number greater, a flag gone, a list longer. */
function changedEdit(edit: DocEdit, field: string): DocEdit {
  let fields = edit as Record<string, unknown>;
  let value = fields[field];
  let other: unknown =
    typeof value === "string" ? `${value}!`
    : typeof value === "number" ? value + 1
    : value === true ? undefined
    : Array.isArray(value) ? [...value, ["more"]]
    : { ...(value as object), border: "1pt solid #000000" };
  return { ...fields, [field]: other } as DocEdit;
}

describe("docEditKey", () => {
  const expected = "<table><tr><td>a</td></tr></table>";
  /** One edit of each member of `DocEdit`, each with every field its member may carry. */
  const EDITS: readonly DocEdit[] = [
    { type: "replaceText", oldMarkdown: "world", newMarkdown: "there", inTable: true },
    { type: "appendText", markdown: "More.\n" },
    { type: "insertTable", rows: 1, columns: 2, cells: [["a", "b"]], after: "Hello" },
    { type: "insertTableRows", at: 1, cells: [["a", "b"]], expected },
    { type: "insertTableColumns", at: 1, cells: [["a"], ["b"]], expected },
    { type: "deleteTableRows", at: 0, count: 1, expected, unshown: 1 },
    { type: "deleteTableColumns", at: 0, count: 1, expected, unshown: 1 },
    { type: "deleteTable", expected, unshown: 1, suggested: 1 },
    {
      type: "setTableCellStyle", row: 0, column: 0, rows: 1, columns: 1, expected,
      style: { background: "#ff0000", padding: { top: "2pt", left: "1pt" } },
    },
    { type: "setTableColumnWidths", at: 0, count: 1, width: 72, expected },
    { type: "setTableRowHeights", at: 0, count: 1, height: 36, expected },
    { type: "mergeTableCells", row: 0, column: 0, rows: 1, columns: 2, expected },
    { type: "unmergeTableCells", row: 0, column: 0, expected },
  ];

  it("is 64 lowercase hex digits, the same for the same fields", () => {
    for (let edit of EDITS) {
      expect(docEditKey(edit), edit.type).toMatch(/^[0-9a-f]{64}$/);
      expect(docEditKey(structuredClone(edit)), edit.type).toBe(docEditKey(edit));
    }
    expect(new Set(EDITS.map(docEditKey)).size).toBe(EDITS.length);
  });

  it("reads nothing a stored record carries beside its edit", () => {
    for (let edit of EDITS) {
      let stored = {
        submittedAt: 1, baseRevisionId: "revision-1", ...edit, tabId: TAB, writeId: "write-1",
        invalidatedReason: "It no longer applies.", markdownVersion: MARKDOWN_RENDERING_VERSION,
        display: { tab: "Tab 1", title: "An edit", description: "What it does." },
      };
      expect(docEditKey(stored), edit.type).toBe(docEditKey(edit));
    }
  });

  it("is the same in whatever order the fields, and the keys of the objects in them, were written", () => {
    for (let edit of EDITS) {
      let reversed = Object.fromEntries(Object.entries(edit).toReversed()) as DocEdit;
      expect(Object.keys(reversed)).not.toEqual(Object.keys(edit));
      expect(docEditKey(reversed), edit.type).toBe(docEditKey(edit));
    }
    expect(docEditKey({
      type: "setTableCellStyle", row: 0, column: 0, rows: 1, columns: 1, expected,
      style: { padding: { left: "1pt", top: "2pt" }, background: "#ff0000" },
    })).toBe(docEditKey(EDITS[8]));
    // A list is read in its order: the cells of a row are not the cells of another.
    expect(docEditKey({ type: "insertTableRows", at: 1, cells: [["b", "a"]], expected }))
      .not.toBe(docEditKey(EDITS[3]));
  });

  it("is another for any field of the edit that differs", () => {
    for (let edit of EDITS) {
      for (let field of Object.keys(edit)) {
        if (field === "type") continue;
        expect(docEditKey(changedEdit(edit, field)), `${edit.type}.${field}`).not.toBe(docEditKey(edit));
      }
    }
    // The same fields under another type are another edit.
    expect(docEditKey({ type: "deleteTableColumns", at: 0, count: 1, expected, unshown: 1 }))
      .not.toBe(docEditKey({ type: "deleteTableRows", at: 0, count: 1, expected, unshown: 1 }));
  });

  it("tells a replacement in a table from one outside tables", () => {
    let outside: DocEdit = { type: "replaceText", oldMarkdown: "world", newMarkdown: "there" };
    expect(docEditKey({ ...outside, inTable: true })).not.toBe(docEditKey(outside));
    // A field that is there and holds nothing is a field the edit does not carry.
    expect(docEditKey({ ...outside, inTable: undefined })).toBe(docEditKey(outside));
  });
});

const CURRENT = { markdownVersion: MARKDOWN_RENDERING_VERSION };
const EARLIER_FORMAT = "Pending Google Doc edit was queued under an earlier Markdown format and " +
  "may no longer apply as previewed. Reject it and retry.";

describe("materializeDocEdit", () => {
  const replace: DocEdit = { type: "replaceText", oldMarkdown: "world", newMarkdown: "there" };
  const append: DocEdit = { type: "appendText", markdown: "More" };

  it("throws the reason stored with an edit that no longer applies", () => {
    expect(thrownMessage(() => materializeDocEdit(
      [PROSE()], { ...replace, ...CURRENT, tabId: TAB, invalidatedReason: "It was dropped." },
    ))).toBe("It was dropped.");
  });

  it("refuses an edit previewed under a Markdown version that no longer replays", () => {
    let tab = TABLED();
    let rows: DocEdit = { type: "deleteTableRows", at: 0, count: 1, expected: expectedOf(tab) };
    let refused: QueuedDocEdit[] = [
      { ...rows, tabId: TAB, markdownVersion: 6 },
      { ...replace, tabId: TAB, markdownVersion: 6 },
      { ...append, tabId: TAB, markdownVersion: 6 },
      { ...replace, tabId: TAB, markdownVersion: 5 },
      { ...append, tabId: TAB, markdownVersion: 5 },
      { ...replace, tabId: TAB },
      { ...append, tabId: TAB },
      { ...rows, tabId: TAB },
    ];
    for (let action of refused) {
      expect(thrownMessage(() => materializeDocEdit([tab], action))).toBe(EARLIER_FORMAT);
    }
    expect(materializeDocEdit([tab], { ...rows, tabId: TAB, ...CURRENT }).requests.length)
      .toBeGreaterThan(0);
  });

  it("replays a text edit queued under version 7, which read text without suggestions as now", () => {
    let tab = TABLED();
    let rows: DocEdit = { type: "deleteTableRows", at: 0, count: 1, expected: expectedOf(tab) };
    expect(thrownMessage(() => materializeDocEdit([tab], { ...rows, tabId: TAB, markdownVersion: 7 })))
      .toBe(EARLIER_FORMAT);
    for (let edit of [replace, append]) {
      expect(materializeDocEdit([PROSE()], { ...edit, tabId: TAB, markdownVersion: 7 }))
        .toEqual(materializeDocEdit([PROSE()], { ...edit, tabId: TAB, ...CURRENT }));
    }
    // Text that version 7 showed without the marks a suggestion now reads with is found nowhere.
    let suggested = buildTab([{ runs: ["Hello ", { text: "new ", suggested: "insertion" }, "world\n"] }]);
    expect(thrownMessage(() => materializeDocEdit([suggested], {
      type: "replaceText", oldMarkdown: "Hello new world", newMarkdown: "Hi", tabId: TAB,
      markdownVersion: 7,
    }))).toBe(
      `replaceText: oldMarkdown was not found in the current simulated tab "${TAB}". ` +
      `Make sure the text exactly matches content returned by getContent("${TAB}").`);
  });


  it("gives the rendering of the tab the edit targets and the requests for it", () => {
    let first = PROSE();
    let second = tabAs(OTHER, buildTab([para("Another world")]));
    let { tab, requests } = materializeDocEdit([first, second], { ...replace, ...CURRENT, tabId: OTHER });
    expect(tab).toEqual(docTabToMarkdown(second));
    expect(requests).toEqual(docEditRequests(docTabToMarkdown(second), replace));
    expect(requests).not.toEqual(docEditRequests(docTabToMarkdown(first), replace));
  });

  // An approval's fallback builds from the stored tab: the same rendering, requests and refusals
  // as the tab Google sent.
  describe.each(CUTS)("builds the same requests from a tab read back from the store, cut $cut", ({ sizes }) => {
    /** What `action` gives in `tab`: the rendering and the requests, or the refusal's text. */
    function outcome(tab: GoogleDocsTab, action: QueuedDocEdit) {
      try {
        return { built: materializeDocEdit([tab], action) };
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return { refused: error.message };
      }
    }

    it.each<[string, () => NamedTab[], readonly DocEdit["type"][]]>([
      ["every recording's tabs", recordedTabs, ["replaceText", "appendText", "insertTableRows"]],
      // Includes footnotes out of order, which the model cannot follow; single-letter texts.
      ["generated tabs", () => fuzzedTabs(11, 120), ["appendText", "insertTableRows"]],
      ["a tab with a table", () => [{ name: "a table between paragraphs", tab: TABLED() }],
        ["replaceText", "appendText", "insertTableRows"]],
    ])("for %s", (source, tabs, kinds) => {
      let built = new Map<string, number>();
      let unfollowed = 0;
      for (let { name, tab } of tabs()) {
        let store = fakeDocStore(undefined, undefined, sizes);
        let head = store.keep(
          DOC, store.fetched({ documentId: "d", title: "t", tabs: [structuredClone(tab)] }, 0),
          { edits: [], roots: [] });
        let base = storedDocCopy(store, DOC, head).tab(tab.tabId)!;
        if (store.unindexed(base)) unfollowed++;
        let render = docTabToMarkdown(tab);
        // The tab's first word, which it may refuse to replace, and the first it replaces.
        let replacing = (word: string): QueuedDocEdit =>
          ({ type: "replaceText", oldMarkdown: word, newMarkdown: "Replaced", ...CURRENT, tabId: tab.tabId });
        let words = [...new Set(render.markdown.match(/[A-Za-z]+/g) ?? [])].slice(0, 40);
        let replaced = new Set(
          [words[0], words.find(word => "built" in outcome(tab, replacing(word)))].filter(word => word !== undefined));
        let [table] = render.sourceMap.tables;
        let columns = table &&
          (/<tr>[^]*?<\/tr>/.exec(tableAt(render, 0))?.[0].match(/<t[dh][ >]/g)?.length ?? 1);
        let edits: DocEdit[] = [
          ...[...replaced].map(word => replacing(word)),
          { type: "appendText", markdown: "More" },
          ...(table ? [{
            type: "insertTableRows" as const, at: 0,
            cells: [Array.from({ length: columns ?? 1 }, (_, at) => `c${at}`)],
            expected: expectedOf(tab),
          }] : []),
        ];
        for (let edit of edits) {
          let action = { ...edit, ...CURRENT, tabId: tab.tabId };
          let sent = outcome(tab, action);
          expect(outcome(store.tab(base), action), `${name}, ${edit.type}`).toEqual(sent);
          if ("built" in sent) built.set(edit.type, (built.get(edit.type) ?? 0) + 1);
        }
      }
      // Each kind was built from at least one tab, not only refused.
      for (let kind of kinds) expect(built.get(kind) ?? 0, kind).toBeGreaterThan(0);
      if (source === "generated tabs") expect(unfollowed).toBeGreaterThan(0);
    });
  });
});

// A stored edit with no tab predates named tabs: it applies to a one-tab document's tab.
describe("docEditTab", () => {
  const main = PROSE();
  const storedAppend: QueuedDocEdit = { type: "appendText", markdown: "added" };

  it("retargets a record naming no tab when the document still has exactly one", () => {
    expect(docEditTab([main], storedAppend)).toBe(main);
  });

  it("refuses a record naming no tab once the document has gained tabs", () => {
    expect(thrownMessage(() => docEditTab([main, tabAs(OTHER, main)], storedAppend))).toBe(
      "Pending Google Doc edit predates tab support and the document has gained tabs since, " +
      "so the tab it was approved against is unknown. Reject it and retry on a selected tab.");
  });

  it("refuses a vanished tab rather than retargeting to the first", () => {
    expect(thrownMessage(() => docEditTab([main], { ...storedAppend, tabId: "ghost" }))).toBe(
      'appendText: no tab with ID "ghost" exists in this document. ' +
      "Call listTabs() to refresh the tab list.");
  });

  it("resolves a record that names a live tab", () => {
    let second = tabAs(OTHER, main);
    expect(docEditTab([main, second], { ...storedAppend, tabId: OTHER })).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/** A pending record of tab `tabId` (`null`: none) under the current Markdown version. */
function record(
  id: number, edit: DocEdit, tabId: string | null = TAB,
  more: { invalidatedReason?: string; markdownVersion?: number; writeId?: string } = {},
): QueuedDocRecord {
  return { id, action: { ...edit, ...CURRENT, ...(tabId === null ? {} : { tabId }), ...more } };
}

/** A store, and the base version of each tab put in it, by the tab's id. */
type Stored = { store: DocStore; storage: FakeDocStorage; base(tabId?: string): DocVersion };

/** `tabs` stored as base versions of one document, in a store of their own. */
function storedTabs(...tabs: GoogleDocsTab[]): Stored {
  let storage = fakeDocStorage();
  let store = new DocStore(storage);
  let versions = new Map(tabs.map(tab => [tab.tabId, store.putTab(DOC, tab, [])]));
  return { store, storage, base: (tabId = TAB) => versions.get(tabId)! };
}

/** One tab with its records folded over it. */
type TabFold = EntityFold<DocVersion, QueuedDocRecord, DocRefusal>;

/** What a fold with no memory folds `records` to over tab `tabId` of `stored`. */
function foldOf(stored: Stored, records: readonly QueuedDocRecord[], tabId = TAB): TabFold {
  let result = createSimulationStore(docTabReducer(stored.store))
    .fold(tabId, stored.base(tabId), records);
  if (result.stopped || !result.entity) {
    throw new Error("Expected the fold to reach the end of the tab's queue");
  }
  return result;
}

/** What the store spends while `run` runs. */
function spent(
  run: () => unknown,
): Omit<
  DocStoreCost, "ingestPeakBufferedBytes" | "viewWidenings" | "pieceWidenings" | "spanCharsCompared"
> {
  let before = { ...docStoreCost };
  docStoreCost.peakRunBytesInHand = 0;
  docStoreCost.peakMarkdownCharsInHand = 0;
  run();
  return {
    runsDecoded: docStoreCost.runsDecoded - before.runsDecoded,
    runsRendered: docStoreCost.runsRendered - before.runsRendered,
    runsKeyed: docStoreCost.runsKeyed - before.runsKeyed,
    peakRunBytesInHand: docStoreCost.peakRunBytesInHand,
    peakMarkdownCharsInHand: docStoreCost.peakMarkdownCharsInHand,
    rowsWritten: docStoreCost.rowsWritten - before.rowsWritten,
    resultsStored: docStoreCost.resultsStored - before.resultsStored,
    resultsFound: docStoreCost.resultsFound - before.resultsFound,
  };
}

/** `value` with every object, array, map and set in it frozen. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  let parts = value instanceof Map ? [...value.values()]
    : value instanceof Set ? [...value] : Object.values(value);
  for (let part of parts) deepFreeze(part);
  return value;
}

const replaceWorld: DocEdit = { type: "replaceText", oldMarkdown: "world", newMarkdown: "there" };
const NOT_FOUND = (tabId = TAB) =>
  `replaceText: oldMarkdown was not found in the current simulated tab "${tabId}". ` +
  `Make sure the text exactly matches content returned by getContent("${tabId}").`;
const missing: DocEdit = { type: "replaceText", oldMarkdown: "missing", newMarkdown: "other" };

/** Table changes of the table `TABLED` holds, and ones recorded for a table that read otherwise. */
const STALE = tableIdentity(docTabToMarkdown(buildTab([grid(["gone"])])).markdown.trim());
const addRows = (expected = expectedOf(TABLED())): DocEdit =>
  ({ type: "insertTableRows", at: 1, cells: [["x", "y"]], expected });
const deleteRows = (expected = expectedOf(TABLED())): DocEdit =>
  ({ type: "deleteTableRows", at: 0, count: 1, expected });
const shade = (expected: string): DocEdit => ({
  type: "setTableCellStyle", row: 0, column: 0, rows: 1, columns: 1,
  style: { background: "#ffcc00" }, expected,
});
const newTable: DocEdit = { type: "insertTable", rows: 1, columns: 1, cells: [["new"]] };
const unindexed = (type: string) => ({ reason: unindexedTabRefusal(type).message, unindexed: true });

/** A tab the model indexes and the renderer cannot render: its first paragraph has no style. */
function unrenderable(tabId = TAB): GoogleDocsTab {
  let tab = tabAs(tabId, PROSE());
  delete (tab.body.content[1].paragraph as { paragraphStyle?: unknown }).paragraphStyle;
  return tab;
}

/** Makes the model's next call throw `cause`, through the whole-tab entry or the slice one. */
function modelThrows(cause: unknown): void {
  let whole = vi.spyOn(model, "applyDocsRequests");
  let slice = vi.spyOn(model, "applyDocsRequestsToSlice");
  let thrown = (): never => {
    whole.mockRestore();
    slice.mockRestore();
    throw cause;
  };
  whole.mockImplementation(thrown);
  slice.mockImplementation(thrown);
}

describe("docTabReducer", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A fold's refusals by record id. */
  const refusedOf = (fold: TabFold) =>
    new Map(fold.refused.map(({ record: { id }, refusal }) => [id, refusal]));
  /** The refusal of the gate a refused table change closed, for an edit that closes it in turn. */
  const gate = (type: string, closes = true) =>
    ({ reason: tableGateRefusal(type).message, ...(closes ? { closesGate: true } : {}) });
  /** The Markdown of the version a fold answered. */
  const markdownOf = (stored: Stored, fold: TabFold) => stored.store.markdown(fold.entity!);

  it("starts from the tab's base version, with nothing refused", () => {
    let stored = storedTabs(PROSE(), tabAs(OTHER, TABLED()));
    for (let tabId of [TAB, OTHER]) {
      let fold = foldOf(stored, [], tabId);
      expect(fold.entity).toBe(stored.base(tabId));
      expect(fold.refused).toEqual([]);
    }
  });

  it("makes each edit in its tab, one after another, as the model applies them", () => {
    let stored = storedTabs(PROSE(), tabAs(OTHER, buildTab([para("Another world")])));
    let main = foldOf(stored, [
      record(1, replaceWorld),
      record(3, { type: "replaceText", oldMarkdown: "End", newMarkdown: "## Finish" }),
    ]);
    let other = foldOf(stored, [
      record(2, { type: "appendText", markdown: "More" }, OTHER),
      record(4, replaceWorld, OTHER),
    ], OTHER);
    expect(markdownOf(stored, main)).toBe("Hello there\n\n## Finish\n");
    expect(markdownOf(stored, other)).toBe("Another there\n\nMore\n");
    expect(main.refused).toEqual([]);
    expect(other.refused).toEqual([]);
  });

  it("records a refused edit with the builder's own words and goes on", () => {
    let stored = storedTabs(PROSE());
    let fold = foldOf(stored, [record(1, missing), record(2, replaceWorld)]);
    expect(refusedOf(fold)).toStrictEqual(new Map([[1, { reason: NOT_FOUND() }]]));
    expect(fold.entity).toEqual(foldOf(stored, [record(2, replaceWorld)]).entity);
    expect(markdownOf(stored, fold)).toBe("Hello there\n\nEnd\n");
  });

  it("closes a tab behind a table change that failed, for the changes that name a table", () => {
    let stored = storedTabs(TABLED(), tabAs(OTHER, TABLED()));
    let queue = [
      record(1, deleteRows(STALE)),
      record(2, addRows()),
      record(3, newTable),
      record(4, { type: "replaceText", oldMarkdown: "Before", newMarkdown: "Earlier" }),
      record(6, shade(expectedOf(TABLED()))),
    ];
    let fold = foldOf(stored, queue);
    let refused = refusedOf(fold);
    expect([...refused.keys()]).toEqual([1, 2, 6]);
    expect(refused.get(1)?.reason).toMatch(/^deleteTableRows: /);
    expect(refused.get(1)?.reason).not.toBe(tableGateRefusal("deleteTableRows").message);
    expect(refused.get(1)?.closesGate).toBe(true);
    expect(refused.get(2)).toStrictEqual(gate("insertTableRows"));
    // A change to a table's look closes no gate, refused or not.
    expect(refused.get(6)).toStrictEqual(gate("setTableCellStyle", false));
    // The new table and the paragraph are placed by their text.
    expect(markdownOf(stored, fold)).toContain("Earlier\n");
    expect(markdownOf(stored, fold)).toContain("<td><p>new</p></td>");
    expect(markdownOf(stored, fold)).not.toContain("<td><p>x</p></td>");

    // The other tab is its own: a fold of it knows nothing of the first tab's refusals.
    let other = foldOf(stored, [record(5, addRows(), OTHER)], OTHER);
    expect(other.refused).toEqual([]);
    expect(markdownOf(stored, other)).toContain("<td><p>x</p></td>");
    let closed = foldOf(stored, [
      record(5, addRows(), OTHER), record(7, deleteRows(STALE), OTHER), record(8, addRows(), OTHER),
    ], OTHER);
    expect([...refusedOf(closed).keys()]).toEqual([7, 8]);
    expect(refusedOf(closed).get(7)?.reason).toMatch(/^deleteTableRows: /);
    expect(refusedOf(closed).get(8)).toStrictEqual(gate("insertTableRows"));
  });

  it("closes a tab for a failed replacement in table cells, and for no other text edit or look", () => {
    let stored = storedTabs(TABLED());
    let behind = (failed: DocEdit) => foldOf(stored, [record(1, failed), record(2, addRows())]);

    let cells = refusedOf(behind({ ...missing, inTable: true }));
    expect(cells.get(1)).toStrictEqual({ reason: NOT_FOUND(), closesGate: true });
    expect(cells.get(2)).toStrictEqual(gate("insertTableRows"));

    for (let failed of [missing, shade(STALE)]) {
      let open = behind(failed);
      expect([...refusedOf(open).keys()]).toEqual([1]);
      expect(refusedOf(open).get(1)?.closesGate).toBeUndefined();
      expect(markdownOf(stored, open)).toContain("<td><p>x</p></td>");
    }
  });

  it("opens the gate again in a fold that is given the refused records no more", () => {
    let stored = storedTabs(TABLED());
    let base = stored.base();
    let fold = createSimulationStore(docTabReducer(stored.store));
    let first = fold.fold(TAB, base, [record(1, deleteRows(STALE)), record(2, addRows())]);
    expect(first.refused.map(({ record: { id } }) => id)).toEqual([1, 2]);
    expect(first.entity).toBe(base);

    // The replay leaves out what it invalidated: the change queued next finds the table as it is.
    let next = fold.fold(TAB, base, [record(3, addRows())]);
    expect(next.refused).toEqual([]);
    expect(next).toEqual(
      createSimulationStore(docTabReducer(stored.store)).fold(TAB, base, [record(3, addRows())]));
    expect(stored.store.markdown(next.entity!)).toContain("<td><p>x</p></td>");
  });

  it("makes an edit that names no tab in the tab it is folded for, and closes no gate with it", () => {
    let prose = storedTabs(PROSE());
    let made = foldOf(prose, [record(1, replaceWorld, null)]);
    expect(markdownOf(prose, made)).toBe("Hello there\n\nEnd\n");
    expect(made.refused).toEqual([]);

    let tabled = storedTabs(TABLED());
    let fold = foldOf(tabled, [record(1, deleteRows(STALE), null), record(2, addRows())]);
    expect([...refusedOf(fold).keys()]).toEqual([1]);
    expect(refusedOf(fold).get(1)?.closesGate).toBeUndefined();
    expect(markdownOf(tabled, fold)).toContain("<td><p>x</p></td>");
  });

  it("refuses a record whose tab is gone, or whose Markdown version no longer replays", () => {
    let ghost = createSimulationStore(docTabReducer(fakeDocStore()))
      .fold("ghost", undefined, [record(1, replaceWorld, "ghost")]);
    expect(ghost.entity).toBeUndefined();
    expect(refusedOf(ghost)).toStrictEqual(new Map([[1, {
      reason: 'replaceText: no tab with ID "ghost" exists in this document. ' +
        "Call listTabs() to refresh the tab list.",
    }]]));

    let stored = storedTabs(PROSE());
    let fold = foldOf(stored, [
      record(2, replaceWorld, TAB, { markdownVersion: 5 }),
      record(3, replaceWorld, TAB, { markdownVersion: 6 }),
    ]);
    expect(refusedOf(fold)).toStrictEqual(
      new Map([[2, { reason: EARLIER_FORMAT }], [3, { reason: EARLIER_FORMAT }]]));
    expect(markdownOf(stored, fold)).toBe("Hello world\n\nEnd\n");
  });

  it("refuses every edit of a tab the model cannot index for that reason, before the gate, " +
    "reading one small row a step", () => {
    // A text run with no content is one the model cannot index.
    let tab = buildTab([{ runs: ["Before", "", "\n"] }, grid(["a", "b"], ["c", "d"]), para("After")]);
    expect(hasModelIndexes(tab)).toBe(false);
    let stored = storedTabs(tab);
    let fold!: TabFold;
    let cost = spent(() => {
      fold = foldOf(stored, [
        record(1, deleteRows()),
        record(2, addRows()),
        record(3, { type: "replaceText", oldMarkdown: "Before", newMarkdown: "Earlier" }),
      ]);
    });
    // A table change so refused closes its tab as any refused table change does.
    expect(refusedOf(fold)).toStrictEqual(new Map<number, unknown>([
      [1, { ...unindexed("deleteTableRows"), closesGate: true }],
      [2, { ...unindexed("insertTableRows"), closesGate: true }],
      [3, unindexed("replaceText")],
    ]));
    expect(refusedOf(fold).get(2)?.reason).not.toBe(tableGateRefusal("insertTableRows").message);
    expect(fold.entity).toBe(stored.base());
    expect(cost).toMatchObject({ runsDecoded: 0, rowsWritten: 0, resultsStored: 0 });
  });

  it("refuses what the builders and the model refuse", () => {
    // Each is thrown twice, once for the tab in hand, so it is made once: its frames are its own.
    let thrown = [
      new NotModelledError("a shape", true),
      new Error("Index 4 must be less than the end index."),
      new RangeError("fault"),
    ];
    let cases: [DocEdit, (() => void) | undefined][] = [
      [missing, undefined],
      [addRows(), undefined],
      ...thrown.map((cause): [DocEdit, () => void] => [replaceWorld, () => modelThrows(cause)]),
    ];
    for (let [edit, arrange] of cases) {
      // The refusal the same edit gives on the tab in hand.
      arrange?.();
      let inHand = docRefusal(thrownBy(() => makeDocEdit(PROSE(), edit)));
      arrange?.();
      let fold = foldOf(storedTabs(PROSE()), [record(1, edit)]);
      let refusal = refusedOf(fold).get(1)!;
      // A refused table change closes its tab's gate, which the reducer says of it.
      expect(refusal).toEqual(closesTableGate(edit) ? { ...inHand, closesGate: true } : inHand);
      expect(fold.entity).toEqual(foldOf(storedTabs(PROSE()), []).entity);
    }
  });

  it("refuses an edit of a tab the renderer cannot render, and folds on", () => {
    let broken = unrenderable();
    let thrown = thrownBy(() => docTabToMarkdown(broken));
    expect(thrown).toBeInstanceOf(TypeError);
    // The store refuses such a tab, so a sound version's one run is replaced beneath it.
    let stored = storedTabs(PROSE(), tabAs(OTHER, PROSE()));
    let [run] = [...cutRuns(broken.body.content, RUN_SIZES)];
    stored.storage.sql.exec(
      "INSERT INTO doc_run (doc, id, json) VALUES (?, 'broken', ?)", stored.base().doc, run.json).toArray();
    stored.storage.sql.exec("UPDATE doc_seq SET run = 'broken' WHERE version = ?", stored.base().id).toArray();
    let edits = [record(1, replaceWorld), record(2, { type: "appendText", markdown: "More" })];

    let fold = foldOf(stored, edits);
    expect(refusedOf(fold)).toStrictEqual(
      new Map([[1, docRefusal(thrown)], [2, docRefusal(thrown)]]));
    expect(fold.entity).toBe(stored.base());
    let sound = foldOf(stored, [record(3, replaceWorld, OTHER)], OTHER);
    expect(sound.refused).toEqual([]);
    expect(markdownOf(stored, sound)).toBe("Hello there\n\nEnd\n");

    // The refusals are stored: a second fold finds them and decodes nothing.
    let again!: TabFold;
    let cost = spent(() => { again = foldOf(stored, edits); });
    expect(refusedOf(again)).toStrictEqual(refusedOf(fold));
    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 0, resultsStored: 0 });
  });

  it("passes a fault of storage through the fold and refuses no record for it", () => {
    let stored = storedTabs(PROSE());
    let queue = [record(1, replaceWorld), record(2, { type: "appendText", markdown: "More" })];
    let made = foldOf(stored, [queue[0]]);
    // The run of the version the first edit made is gone, and the second edit was never made.
    let run = stored.storage.sql
      .exec<{ run: string }>("SELECT run FROM doc_seq WHERE version = ?", made.entity!.id).one().run;
    stored.storage.sql.exec("DELETE FROM doc_run WHERE id = ?", run).toArray();

    let answered: TabFold | undefined;
    expect(() => { answered = foldOf(stored, queue); }).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(answered).toBeUndefined();
  });

  it("leaves the version itself for an edit that changes nothing", () => {
    let stored = storedTabs(PROSE());
    let base = stored.base();
    let reducer = docTabReducer(stored.store);
    let fold = createSimulationStore(reducer);
    let without = fold.fold(TAB, base, [record(1, replaceWorld)]);
    let unchanged = fold.fold(TAB, base, [
      record(1, replaceWorld),
      record(2, { type: "replaceText", oldMarkdown: "there", newMarkdown: "there" }),
    ]);
    expect(without.entity).toBeDefined();
    expect(unchanged.entity).toEqual(without.entity);
    expect(reducer.reduce(
      without.entity, record(2, { type: "replaceText", oldMarkdown: "End", newMarkdown: "End" }),
      { id: TAB, base, refusals: [] },
    )).toEqual({ kind: "known-no-effect" });
  });

  it("changes neither the stored tab nor the version it is given", () => {
    let stored = storedTabs(TABLED());
    let base = deepFreeze(stored.base());
    let records = [
      record(1, addRows()),
      record(2, deleteRows(STALE)),
      record(3, addRows()),
      record(4, { type: "replaceText", oldMarkdown: "Before", newMarkdown: "Earlier" }),
      record(5, missing),
      record(7, { type: "appendText", markdown: "More" }),
    ];
    let reducer = docTabReducer(stored.store);
    let version = reducer.initial(base);
    let refusals: DocRefusal[] = [];
    let refused: number[] = [];
    let tabBefore = stored.store.tab(base);
    for (let pending of records) {
      let before = stored.store.tab(version);
      let step = reducer.reduce(version, pending, { id: TAB, base, refusals });
      expect(step.kind).not.toBe("unsupported");
      expect(stored.store.tab(version)).toEqual(before);
      if (step.kind === "applied") {
        expect(step.value.id).not.toBe(version.id);
        version = deepFreeze(step.value);
      } else if (step.kind === "refused") {
        refusals = [...refusals, step.refusal];
        refused.push(pending.id);
      }
    }
    expect(stored.store.tab(base)).toEqual(tabBefore);
    expect(refused).toEqual([2, 3, 5]);
    expect(version).toEqual(
      createSimulationStore(docTabReducer(stored.store)).fold(TAB, base, records).entity);
  });
});

describe("makeDocEdit", () => {
  it("makes the requests and the tab they give", () => {
    let tab = PROSE();
    let made = makeDocEdit(tab, replaceWorld);
    expect(made.requests).toEqual(docEditRequests(renderTab(tab), replaceWorld));
    expect(made.after).toEqual(applyDocsRequests(tab, made.requests));
    expect(renderTab(made.after).markdown).toBe("Hello there\n\nEnd\n");
    // With the rendering the caller has in hand, the tab is not rendered again.
    let rendering = renderTab(tab);
    let before = replayCost.renders;
    expect(makeDocEdit(tab, replaceWorld, rendering)).toEqual(made);
    expect(replayCost.renders - before).toBe(0);
  });

  it("makes the edit again when it is asked again", () => {
    let tab = PROSE();
    let made = makeDocEdit(tab, replaceWorld);
    let before = { ...replayCost };
    let again = makeDocEdit(tab, replaceWorld);
    expect(again).not.toBe(made);
    expect(again.after).not.toBe(made.after);
    expect(again).toEqual(made);
    expect(replayCost.tabClones - before.tabClones).toBe(1);
    expect(replayCost.renders - before.renders).toBe(1);
    expect(applyDocEdit(tab, replaceWorld)).toEqual(made.after);
    // A refusal is thrown each time, too.
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(thrownMessage(() => makeDocEdit(tab, missing))).toBe(NOT_FOUND());
    }
  });

  it("answers the tab itself for an edit that changes nothing", () => {
    let tab = PROSE();
    let same: DocEdit = { type: "replaceText", oldMarkdown: "End", newMarkdown: "End" };
    let made = makeDocEdit(tab, same);
    expect(made.requests).toEqual([]);
    expect(made.after).toBe(tab);
  });
});

describe("docEditResult", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A stored action: the edit, and what the queue keeps beside it. */
  type StoredAction = QueuedDocEdit & { submittedAt: number; display: { title: string } };
  const storedAs = (edit: DocEdit): StoredAction => ({
    ...structuredClone(edit), ...CURRENT, tabId: TAB, writeId: "w1", submittedAt: 3,
    display: { title: "Card" },
  });
  /** What `run` throws, which must be a refusal of the edit. */
  const refusalOf = (run: () => unknown): DocEditRefusedError => {
    let thrown = thrownBy(run);
    expect(thrown).toBeInstanceOf(DocEditRefusedError);
    return thrown as DocEditRefusedError;
  };

  it("makes an edit once and finds it stored after", () => {
    let { store, base } = storedTabs(PROSE());
    let made!: DocEditResult;
    // One run, decoded once for the piece and taken as is by the model's slice.
    expect(spent(() => { made = docEditResult(store, base(), replaceWorld); }))
      .toMatchObject({ runsDecoded: 1, resultsStored: 1, resultsFound: 0 });
    let found!: DocEditResult;
    let clones = replayCost.tabClones;
    expect(spent(() => { found = docEditResult(store, base(), replaceWorld); }))
      .toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0, resultsStored: 0, resultsFound: 1 });
    expect(replayCost.tabClones - clones).toBe(0);
    expect(found.requests).toEqual(made.requests);
    expect(found.after).toEqual(made.after);
    expect(made.requests).toEqual(docEditRequests(renderTab(PROSE()), replaceWorld));
  });

  it("finds the result whatever else the record carries", () => {
    let { store, base } = storedTabs(PROSE());
    let made = docEditResult(store, base(), replaceWorld);
    let cost = spent(() => {
      expect(docEditResult(store, base(), storedAs(replaceWorld)).after).toEqual(made.after);
    });
    expect(cost).toMatchObject({ resultsFound: 1, resultsStored: 0, runsDecoded: 0 });
  });

  it("stores the version an edit gives with its rendering", () => {
    let { store, base } = storedTabs(PROSE());
    let { after } = docEditResult(store, base(), replaceWorld);
    expect(after.id).not.toBe(base().id);
    expect(after.exact).toBe(true);
    expect(after).toMatchObject({ tabId: TAB, doc: DOC, writeMarkers: [] });
    let cost = spent(() => {
      expect(store.markdown(after)).toBe("Hello there\n\nEnd\n");
      expect(store.markdown(base())).toBe("Hello world\n\nEnd\n");
    });
    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
    expect(store.tab(after)).toEqual(applyDocEdit(store.tab(base()), replaceWorld));
  });

  it("answers the requests and the version alone, and copies no tab", () => {
    let { store, base } = storedTabs(PROSE());
    let whole = vi.spyOn(model, "applyDocsRequests");
    let clones = replayCost.tabClones;
    let made = docEditResult(store, base(), replaceWorld);
    let { after } = made;
    // No rendering is handed on: the next step makes its own reading of the version.
    expect(Object.keys(made).toSorted()).toEqual(["after", "requests"]);
    // The whole-tab entry is not on an edit's path, and the model copies nothing.
    expect(whole).not.toHaveBeenCalled();
    expect(replayCost.tabClones - clones).toBe(0);
    whole.mockRestore();
    expect(store.tab(after)).toEqual(applyDocEdit(store.tab(base()), replaceWorld));
  });

  it("answers the version itself for an edit that changes nothing", () => {
    let { store, base } = storedTabs(PROSE());
    let same: DocEdit = { type: "replaceText", oldMarkdown: "End", newMarkdown: "End" };
    let made = docEditResult(store, base(), same);
    expect(made.requests).toEqual([]);
    expect(made.after).toBe(base());
    let found = docEditResult(store, base(), same);
    expect(found.after).toBe(base());
  });

  it("stores a refusal and throws it again as it was", () => {
    let fault = new RangeError("Hello world is out of range");
    let cases: [string, DocEdit, (() => void) | undefined, string][] = [
      ["a builder's", missing, undefined, "Error"],
      ["the model's, for a shape it has no answer for", replaceWorld,
        () => modelThrows(new NotModelledError("a shape", false)), "DocModelError"],
      ["a fault of the model", replaceWorld, () => modelThrows(fault), "DocModelError"],
    ];
    for (let [, edit, arrange, name] of cases) {
      let { store, base } = storedTabs(PROSE());
      arrange?.();
      let made = refusalOf(() => docEditResult(store, base(), edit));
      let found!: DocEditRefusedError;
      let cost = spent(() => { found = refusalOf(() => docEditResult(store, base(), edit)); });
      expect(cost).toMatchObject({ runsDecoded: 0, resultsStored: 0, resultsFound: 1 });
      for (let refused of [made, found]) {
        expect(refused.name).toBe(name);
        expect(refused.message).toBe(made.refusal.reason);
        expect(refused.refusal).toEqual(made.refusal);
        expect(docRefusal(refused)).toBe(refused.refusal);
      }
    }
  });

  it("refuses an edit that would give the tab a paragraph past a row, and stores nothing", () => {
    let { store, storage, base } = storedTabs(PROSE());
    // One repeated character: the tab the append gives holds one paragraph past a row.
    let edit: DocEdit = { type: "appendText", markdown: "x".repeat(DOC_ROW_BYTES) };
    expect(store.markdown(base())).toBe("Hello world\n\nEnd\n");
    let rendered = storage.rows();
    let refused = refusalOf(() => docEditResult(store, base(), edit));
    expect(refused.name).toBe("Error");
    expect(refused.message).toMatch(/^appendText: this edit is too large for tab "tab-1" of this Google Doc: /);
    expect(refused.message).toContain(
      "a paragraph or a table of the tab as the edit would leave it, or the change itself, takes ");
    expect(refused.message).toContain(`one stored row holds ${DOC_ROW_BYTES}`);
    expect(refused.message.endsWith(
      " Make a smaller change, or make that paragraph or table smaller in Google Docs first.")).toBe(true);
    expect(refused.message).not.toContain("is too large to keep a copy of");
    expect(refused.message).not.toContain("cannot be read");
    expect(refused.refusal).toEqual({ reason: refused.message });
    // Nothing of it is stored, the refusal included: asked again, the edit is made again.
    expect(storage.rows()).toEqual(rendered);
    expect(rendered.doc_result).toEqual([]);
  });

  it("refuses an edit that leaves a paragraph the store finds too large for a row as it stores it, and stores nothing of it", () => {
    let stored = storedTabs(PROSE());
    let { store, storage, base } = stored;
    let before = storage.rows();
    // What the store throws where a run cut from the slice an edit changed, or the run's
    // Markdown, passes a row.
    let tooLarge = new DocRowTooLargeError(`A paragraph of tab "${TAB}" of this Google Doc`, DOC_ROW_BYTES + 1);
    vi.spyOn(store, "putSlice").mockImplementation(() => { throw tooLarge; });
    let tooLargeFor = (type: string) =>
      `${type}: this edit is too large for tab "${TAB}" of this Google Doc: a paragraph or a ` +
      `table of the tab as the edit would leave it, or the change itself, takes ` +
      `${DOC_ROW_BYTES + 1} bytes as stored, and one stored row holds ${DOC_ROW_BYTES}. Make a ` +
      "smaller change, or make that paragraph or table smaller in Google Docs first.";
    // An edit the tab takes: the reason is the edit's, never that the tab is too large.
    let refused = refusalOf(() => docEditResult(store, base(), replaceWorld));
    expect(refused.name).toBe("Error");
    expect(refused.message).toBe(tooLargeFor("replaceText"));
    expect(refused.message).not.toContain("is too large to keep a copy of");
    expect(refused.refusal).toEqual({ reason: refused.message });
    // Nothing of it is stored, the refusal included.
    expect(storage.rows()).toEqual(before);
    // An edit the builders refuse: their refusal stands, and is stored.
    let builders = refusalOf(() => docEditResult(store, base(), missing));
    expect(builders.refusal).toEqual({ reason: NOT_FOUND() });
    let withRefusal = storage.rows();
    expect(withRefusal).toEqual({ ...before, doc_result: withRefusal.doc_result });
    expect(withRefusal.doc_result).toHaveLength(1);

    // A fold refuses each for its own reason and goes on to the end of the queue.
    let append: DocEdit = { type: "appendText", markdown: "More" };
    let fold = foldOf(stored, [record(1, replaceWorld), record(2, missing), record(3, append)]);
    expect(fold.entity).toEqual(base());
    expect(fold.refused.map(({ record: { id }, refusal }) => [id, refusal.reason])).toEqual([
      [1, tooLargeFor("replaceText")],
      [2, NOT_FOUND()],
      [3, tooLargeFor("appendText")],
    ]);
    expect(storage.rows()).toEqual(withRefusal);

    // With rows that fit, the refused edit is made, and the builders' refusal is found stored.
    vi.restoreAllMocks();
    let cost = spent(() => {
      expect(store.markdown(docEditResult(store, base(), replaceWorld).after))
        .toBe("Hello there\n\nEnd\n");
      refusalOf(() => docEditResult(store, base(), missing));
    });
    expect(cost).toMatchObject({ resultsFound: 1, resultsStored: 1 });
  });

  it("throws a fault of storage as it is, not as a refusal", () => {
    let { store, storage, base } = storedTabs(PROSE());
    storage.refuse(statement => statement.startsWith("INSERT INTO doc_result"));
    let thrown = thrownBy(() => docEditResult(store, base(), replaceWorld));
    expect(thrown).not.toBeInstanceOf(DocEditRefusedError);
    expect((thrown as Error).message).toBe("storage refused the write");
    storage.refuse(undefined);

    // A version that cannot be read back is one too.
    let gone = storedTabs(PROSE());
    gone.storage.sql.exec("DELETE FROM doc_run").toArray();
    expect(thrownBy(() => docEditResult(gone.store, gone.base(), replaceWorld)))
      .toEqual(new Error(DOC_COPY_UNREADABLE));
  });

  it("leaves nothing behind a transaction that rolls back, and makes the edit again", () => {
    let { store, storage, base } = storedTabs(PROSE());
    let before = storage.rows();
    expect(() => store.transaction(() => {
      docEditResult(store, base(), replaceWorld);
      throw new Error("the caller failed");
    })).toThrow("the caller failed");
    // Nothing outside storage remembers the version the edit gave.
    expect(storage.rows()).toEqual(before);
    let made!: DocEditResult;
    // The tab's one run, decoded once: for the piece, which the slice takes.
    expect(spent(() => { made = docEditResult(store, base(), replaceWorld); }))
      .toMatchObject({ runsDecoded: 1, resultsStored: 1, resultsFound: 0 });
    expect(store.markdown(made.after)).toBe("Hello there\n\nEnd\n");
  });

  it("an edit queued in a tab a pending add makes is the whole tab's", () => {
    let add: GoogleDocAddTabAction = {
      type: "addTab", provisionalTabId: "new-tab", title: "New", submittedAt: 1,
    };
    // The blank tab is one the model follows, by construction, in hand and as it is stored.
    for (let blank of [
      blankDocTabToKeep(add), throughJson(pruneTab(blankDocsTab("new-tab", "New"))),
    ]) {
      expect([hasModelIndexes(blank), hasModelFootnotes(blank)]).toEqual([true, true]);
    }
    let append: DocEdit = { type: "appendText", markdown: "Hello" };
    /** What `edits` give through the store, from `blank` stored as the replay stores it. */
    let throughStore = (blank: GoogleDocsTab, edits: readonly DocEdit[]) => {
      let store = fakeDocStore();
      let version = store.putTab(DOC, blank, []);
      return edits.map(edit => {
        let made = docEditResult(store, version, edit);
        version = made.after;
        return {
          requests: made.requests, tab: store.tab(made.after),
          markdown: store.markdown(made.after), exact: made.after.exact,
        };
      });
    };
    /** What the same edits give on the tab in hand. */
    let inHand = (blank: GoogleDocsTab, edits: readonly DocEdit[]) => {
      let tab = blank;
      return edits.map(edit => {
        let made = makeDocEdit(tab, edit);
        tab = made.after;
        return {
          requests: made.requests, tab: made.after, markdown: renderTab(made.after).markdown,
          exact: true,
        };
      });
    };
    let outcome = (run: () => unknown) => {
      try {
        return run();
      } catch (error) {
        return { thrown: (error as Error).message };
      }
    };

    // Text appended, then a table inserted after it: each step is the whole tab's.
    let edits = [append, newTable];
    expect(throughStore(blankDocTabToKeep(add), edits)).toEqual(inHand(blankDocTabToKeep(add), edits));
    // The model is handed the blank tab's one run, as the piece decoded it.
    let store = fakeDocStore();
    let blank = store.putTab(DOC, blankDocTabToKeep(add), []);
    expect(spent(() => docEditResult(store, blank, append))).toMatchObject({ runsDecoded: 1 });

    // THE TEETH: the same with the blank tab's paragraph one index off. A slice is not
    // re-indexed on the way in and a tab in hand is, so the two differ.
    let off = blankDocTabToKeep(add);
    let [, paragraph] = off.body.content;
    Object.assign(paragraph, { startIndex: 2, endIndex: 3 });
    Object.assign(paragraph.paragraph!.elements[0], { startIndex: 2, endIndex: 3 });
    expect(hasModelIndexes(off)).toBe(false);
    expect(outcome(() => throughStore(structuredClone(off), [append])))
      .not.toEqual(outcome(() => inHand(structuredClone(off), [append])));
  });

  it("the requests stored are the requests built", () => {
    let { store, base } = storedTabs(PROSE());
    let reach = model.batchReach;
    let frozen: readonly GoogleDocsRequest[] | undefined;
    // Frozen where the batch is first read for the model, before a run is decoded for it.
    vi.spyOn(model, "batchReach").mockImplementation(requests => {
      frozen = deepFreeze(requests);
      return reach(requests);
    });

    let made = docEditResult(store, base(), replaceWorld);

    expect(frozen).toBeDefined();
    expect(made.requests).toBe(frozen);
    expect(made.requests).toEqual(docEditRequests(renderTab(PROSE()), replaceWorld));
    expect(store.result(base(), docEditKey(replaceWorld)))
      .toEqual({ requests: made.requests, after: made.after });
  });

  it("a fault of storage while a run is read is not refused", () => {
    // Met by the piece, or by the slice where the piece hands no decoded run on.
    for (let meets of ["the piece", "the slice"]) {
      let { store, storage, base } = storedTabs(PROSE());
      let before = storage.rows();
      let refuseRuns = () =>
        storage.refuse(statement => statement.startsWith("SELECT json FROM doc_run"));
      if (meets === "the piece") {
        refuseRuns();
      } else {
        let piece = store.piece.bind(store);
        vi.spyOn(store, "piece").mockImplementation((version, at) => {
          let made = piece(version, at);
          made.decoded.clear();
          refuseRuns();
          return made;
        });
      }

      let thrown = thrownBy(() => docEditResult(store, base(), replaceWorld));

      storage.refuse(undefined);
      expect(thrown, meets).not.toBeInstanceOf(DocEditRefusedError);
      expect(thrown, meets).not.toBeInstanceOf(DocReadingFault);
      expect((thrown as Error).message, meets).toBe("storage refused the write");
      expect(store.result(base(), docEditKey(replaceWorld)), meets).toBeUndefined();
      expect(storage.rows(), meets).toEqual(before);
    }
  });
});

describe("renderTab", () => {
  it("renders each time it is asked", () => {
    let tab = PROSE();
    let before = replayCost.renders;
    let first = renderTab(tab);
    let second = renderTab(tab);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(replayCost.renders - before).toBe(2);
  });
});

describe("replayableDocEdits", () => {
  const part: DocVersion = {
    ...storedTabs(PROSE()).base(), writeMarkers: [{ writeId: "w1", id: "range.1" }],
  };

  it("leaves out a record whose write the tab already holds", () => {
    let held = record(1, replaceWorld, TAB, { writeId: "w1" });
    let elsewhere = record(2, replaceWorld, TAB, { writeId: "w2" });
    let noTab = record(3, replaceWorld, null, { writeId: "w1" });
    let unsent = record(4, replaceWorld);
    let kept = replayableDocEdits(part, [held, elsewhere, noTab, unsent]);
    expect(kept.map(({ id }) => id)).toEqual([2, 4]);
    expect(kept[0]).toBe(elsewhere);
    expect(kept[1]).toBe(unsent);
  });

  it("keeps every record of a tab the copy lacks", () => {
    let records = [record(1, replaceWorld, "ghost", { writeId: "w1" }), record(2, replaceWorld, "ghost")];
    expect(replayableDocEdits(undefined, records)).toEqual(records);
  });
});

// ---------------------------------------------------------------------------
// changedSpan
// ---------------------------------------------------------------------------

/** The two sides of the span `changedSpan` gives, after checking that the rest is the same text. */
function sides(
  before: string, after: string, named?: { start: number; end: number },
): [string, string] {
  let { start, beforeEnd, afterEnd } = changedSpan(before, after, named);
  expect(before.slice(0, start)).toBe(after.slice(0, start));
  expect(before.slice(beforeEnd)).toBe(after.slice(afterEnd));
  return [before.slice(start, beforeEnd), after.slice(start, afterEnd)];
}

/** The range `text` stands at in `markdown`. */
function rangeOf(markdown: string, text: string): { start: number; end: number } {
  let start = markdown.indexOf(text);
  return { start, end: start + text.length };
}

/** A `changedSpan` call and its two sides, and the span where the sides leave it ambiguous. */
type SpanCase = [
  name: string, before: string, after: string, named: { start: number; end: number } | undefined,
  sides: [string, string], span?: ReturnType<typeof changedSpan>,
];

/** Holds `changedSpan` to a case. */
function expectSpan(...[, before, after, named, expected, span]: SpanCase): void {
  expect(sides(before, after, named)).toEqual(expected);
  if (span) expect(changedSpan(before, after, named)).toEqual(span);
}

describe("changedSpan with the range the caller's text stands at", () => {
  const BEFORE = "first\none two three\nlast\n";
  const TWO = rangeOf(BEFORE, "two");
  // U+1F600 and U+1F601 share their high surrogate; U+1F600 and U+1F200 their low one.
  const [GRIN, BEAM, SQUARE] = ["\u{1F600}", "\u{1F601}", "\u{1F200}"];

  it.each<SpanCase>([
    ["is that range where the renderings are the same", BEFORE, BEFORE, TWO,
      ["two", "two"], { start: 10, beforeEnd: 13, afterEnd: 13 }],
    ["is that range where the change lies inside it", BEFORE, "first\none 2 and more three\nlast\n", TWO,
      ["two", "2 and more"], { start: 10, beforeEnd: 13, afterEnd: 20 }],
    ["is that range where its text is removed", BEFORE, "first\none  three\nlast\n", TWO, ["two", ""]],
    ["starts at the line's start where the change begins before the range",
      BEFORE, "first\nONE 2 three\nlast\n", TWO, ["one two", "ONE 2"]],
    ["starts at the start of the earlier line a change begins in",
      BEFORE, "First\none 2 three\nlast\n", TWO, ["first\none two", "First\none 2"]],
    ["ends at the line's end where the change ends after the range in the middle of a line",
      BEFORE, "first\none 2 thrEe\nlast\n", TWO, ["two three", "2 thrEe"]],
    ["ends at the end of the later line a change ends in",
      BEFORE, "first\none 2 three\nLast\n", TWO, ["two three\nlast", "2 three\nLast"]],
    ["ends after the line break where the change ends at one",
      "x\ny\n", "zy\n", { start: 0, end: 1 }, ["x\n", "z"], { start: 0, beforeEnd: 2, afterEnd: 1 }],
    ["is the text an insertion adds", "x a", "x b a", { start: 1, end: 1 }, ["", " b"]],
    ["is the text an insertion adds, though it repeats the text after it",
      "x a", "x a a", { start: 1, end: 1 }, ["", " a"], { start: 1, beforeEnd: 1, afterEnd: 3 }],
    ["splits neither of two emoji that share their high surrogate",
      `a ${GRIN} b`, `a ${BEAM} b`, { start: 2, end: 4 }, [GRIN, BEAM]],
    ["splits neither of two emoji that share their low surrogate",
      `a ${GRIN} b`, `a ${SQUARE} b`, { start: 2, end: 4 }, [GRIN, SQUARE]],
    ["splits no emoji of the line it widens to",
      `${GRIN}${BEAM}\n`, `${GRIN}${GRIN}\n`, { start: 0, end: 2 }, [`${GRIN}${BEAM}`, `${GRIN}${GRIN}`]],
  ])("%s", expectSpan);
});

describe("changedSpan with no range", () => {
  it.each<SpanCase>([
    ["is empty where the renderings are the same", "a\nb\n", "a\nb\n", undefined,
      ["", ""], { start: 4, beforeEnd: 4, afterEnd: 4 }],
    ["is what an append adds", "a\n", "a\n\nb\n", undefined, ["", "\nb\n"]],
    ["is what an append adds to a blank tab", "\n", "Hello\n", undefined, ["", "Hello"]],
    ["is the whole of a line that differs",
      "one\ntwo\nthree\n", "one\ntWo\nthree\n", undefined, ["two", "tWo"]],
    ["is the whole of a line that gains a character",
      "one\ntwo words\nthree\n", "one\ntwo  words\nthree\n", undefined, ["two words", "two  words"]],
    ["runs from the first line that differs to the last",
      "one\ntwo\nthree\nfour\n", "oNe\ntwo\nthrEe\nfour\n", undefined,
      ["one\ntwo\nthree", "oNe\ntwo\nthrEe"]],
    ["is empty on the after side for lines that are only removed",
      "one\ntwo\nthree\n", "one\nthree\n", undefined, ["two\n", ""]],
  ])("%s", expectSpan);
});

/** A table row of one paragraph to a cell, as the rendering writes it. */
const ROW = (...cells: string[]) =>
  `  <tr>\n${cells.map(cell => `    <td><p>${cell}</p></td>\n`).join("")}  </tr>\n`;

describe("changedSpan of lines that are only added", () => {
  const tab = TABLED();
  const before = docTabToMarkdown(tab).markdown;
  const afterEdit = (edit: DocEdit) => docTabToMarkdown(applyDocEdit(tab, edit)).markdown;

  it("gives a row added between two rows, at the top of the table or after its last row", () => {
    for (let at of [0, 1, 2]) {
      let after = afterEdit({
        type: "insertTableRows", at, cells: [["x", "y"]], expected: expectedOf(tab),
      });
      expect(sides(before, after)).toEqual(["", ROW("x", "y")]);
    }
  });

  it("gives a row that reads as the row before it, whole", () => {
    let after = afterEdit({
      type: "insertTableRows", at: 1, cells: [["a", "b"]], expected: expectedOf(tab),
    });
    expect(sides(before, after)).toEqual(["", ROW("a", "b")]);
  });

  it("gives a table added in front of a table, with the paragraph Google adds after it", () => {
    let after = afterEdit({
      type: "insertTable", rows: 1, columns: 1, cells: [["new"]], after: "Before",
    });
    expect(sides(before, after)).toEqual(["", `<table>\n${ROW("new")}</table>\n\n\n\n`]);
  });

  it("leaves a line appended that repeats the last line where it is", () => {
    let repeated = buildTab([para("same")]);
    let after = docTabToMarkdown(applyDocEdit(repeated, { type: "appendText", markdown: "same" })).markdown;
    expect(after).toBe("same\n\nsame\n");
    expect(changedSpan("same\n", after)).toEqual({ start: 5, beforeEnd: 5, afterEnd: 11 });
  });

  it("places lines that could stand earlier where their first line is indented least", () => {
    // The added lines could start at `  b`, at the second `a` or at `    c`.
    expect(sides("a\n  b\n", "a\n  b\na\n  b\n")).toEqual(["", "a\n  b\n"]);
    expect(sides("a\n    c\n  b\n", "a\n    c\n  b\n    c\n  b\n")).toEqual(["", "  b\n    c\n"]);
  });
});

const atLineStart = (text: string, index: number) => index === 0 || text[index - 1] === "\n";
const textOf = (lines: string[]) => lines.map(line => `${line}\n`).join("");

describe("changedSpan of any two texts", () => {
  const LINES = ["a", "  b", "    c", "", "  b", "a"];
  const TEXTS = ["", "q", "\n", "a\n  b"];

  it("leaves the same text outside the span, which holds the named range", () => {
    let { below } = diceOf(7);
    let lines = (count: number) => Array.from({ length: count }, () => LINES[below(LINES.length)]);
    for (let round = 0; round < 4000; round++) {
      let beforeLines = lines(below(9));
      let before = textOf(beforeLines);
      let after: string;
      if (below(2) === 0) {
        // Whole lines added at a line start.
        let at = below(beforeLines.length + 1);
        after = textOf([...beforeLines.slice(0, at), ...lines(1 + below(4)), ...beforeLines.slice(at)]);
        let { start, beforeEnd, afterEnd } = changedSpan(before, after);
        expect(beforeEnd).toBe(start);
        expect(atLineStart(after, start)).toBe(true);
        expect(after[afterEnd - 1]).toBe("\n");
        expect(after.length - (afterEnd - start)).toBe(before.length);
      } else {
        after = textOf(lines(below(9)));
      }
      sides(before, after);

      let start = below(before.length + 1);
      let named = { start, end: start + below(before.length - start + 1) };
      let span = changedSpan(before, after, named);
      sides(before, after, named);
      expect(span.start).toBeLessThanOrEqual(named.start);
      expect(span.beforeEnd).toBeGreaterThanOrEqual(named.end);

      // The named range replaced by any text: the span is that range, and the text.
      let written = TEXTS[below(TEXTS.length)];
      let replaced = before.slice(0, named.start) + written + before.slice(named.end);
      expect(changedSpan(before, replaced, named)).toEqual({
        start: named.start, beforeEnd: named.end, afterEnd: named.start + written.length,
      });
    }
  });
});

describe("changedSpan of two strings of a tab that reads on", () => {
  const OPEN = { before: true, after: true };
  const AFTER = { before: false, after: true };
  const BEFORE = { before: true, after: false };
  const CLOSED = { before: false, after: false };

  it("a span says when the text beyond could change it", () => {
    // A string that is the whole start of the other: the tabs' common start runs on into the
    // text after them.
    expect(changedSpan("a\n", "a\nb\n", undefined, AFTER)).toEqual({ more: "after" });
    expect(changedSpan("a\nb\n", "a\n", undefined, AFTER)).toEqual({ more: "after" });
    // With a range named past the common start too.
    expect(changedSpan("a\nb\nc\n", "a\n", { start: 4, end: 5 }, AFTER)).toEqual({ more: "after" });
    // A named range the common start reaches starts the span, whatever follows: the shorter
    // string after, and before.
    for (let [before, after, named] of [
      ["a\nb\n", "a\n", { start: 2, end: 4 }],
      ["a\nb\n", "a\n", { start: 1, end: 3 }],
      ["a\n", "a\nb\n", { start: 2, end: 2 }],
      ["a\n", "a\nb\n", { start: 0, end: 1 }],
    ] as const) {
      expect(changedSpan(before, after, named, OPEN)).toEqual(changedSpan(before, after, named));
    }
    expect(changedSpan("a\nb\n", "a\n", { start: 2, end: 4 }, OPEN))
      .toEqual({ start: 2, beforeEnd: 4, afterEnd: 2 });

    // Lines only added, whose walk back over equal lines reaches the strings' start: the line
    // before the strings may be equal too.
    expect(changedSpan("a\n", "a\na\n", undefined, BEFORE)).toEqual({ more: "before" });
    expect(changedSpan("", "a\n", undefined, BEFORE)).toEqual({ more: "before" });
    // A line that differs ends the walk inside the strings.
    expect(changedSpan("b\na\n", "b\na\na\n", undefined, BEFORE))
      .toEqual(changedSpan("b\na\n", "b\na\na\n"));

    // A side that is not open reads on into nothing.
    expect(changedSpan("a\n", "a\nb\n", undefined, BEFORE)).toEqual(changedSpan("a\n", "a\nb\n"));
    expect(changedSpan("a\n", "a\na\n", undefined, AFTER)).toEqual({ more: "after" });
    expect(changedSpan("a\n", "a\na\n", undefined, CLOSED)).toEqual({ start: 2, beforeEnd: 2, afterEnd: 4 });

    // Two equal strings are two equal tabs.
    expect(changedSpan("a\n", "a\n", undefined, OPEN)).toEqual({ start: 2, beforeEnd: 2, afterEnd: 2 });
    expect(changedSpan("a\n", "a\n", { start: 0, end: 1 }, OPEN))
      .toEqual({ start: 0, beforeEnd: 1, afterEnd: 1 });
    expect(changedSpan("", "", undefined, OPEN)).toEqual({ start: 0, beforeEnd: 0, afterEnd: 0 });
  });

  it("extended by the lines beyond while it says so, the span is the whole strings', moved", () => {
    // Lines of a small alphabet, so that the text beyond repeats what was added or removed.
    const LINES = ["a\n", "a\n", "  b\n", "    c\n", "\n", "<td>\n"];
    let { below } = diceOf(11);
    let lines = (count: number) => Array.from({ length: count }, () => LINES[below(LINES.length)]);
    let extended = { before: 0, after: 0 };
    let pairs = 0;
    while (pairs < 200) {
      let x = lines(below(6)), y = lines(below(6));
      let b = lines(below(4)), a = lines(below(4));
      // Two strings that read alike say nothing of where they stand.
      if (b.join("") === a.join("")) continue;
      pairs++;
      let first = x.join("").length;
      let named = below(3) === 0 ? undefined : { start: first, end: first + b.join("").length };
      let whole = changedSpan(x.join("") + b.join("") + y.join(""), x.join("") + a.join("") + y.join(""), named);

      let before = b.join(""), after = a.join("");
      let from = x.length, to = 0;
      for (;;) {
        let start = x.slice(0, from).join("").length;
        let span = changedSpan(
          before, after, named && { start: named.start - start, end: named.end - start },
          { before: from > 0, after: to < y.length });
        if ("more" in span) {
          extended[span.more]++;
          if (span.more === "after") {
            before += y[to];
            after += y[to++];
          } else {
            before = x[--from] + before;
            after = x[from] + after;
          }
          continue;
        }
        expect({
          start: span.start + start, beforeEnd: span.beforeEnd + start, afterEnd: span.afterEnd + start,
        }).toEqual(whole);
        break;
      }
    }
    // Both sides were extended, so the pairs are the cases they are.
    expect(extended.before).toBeGreaterThan(0);
    expect(extended.after).toBeGreaterThan(0);
  });
});

// A batch past its piece, and a piece that cannot be made, are refusals (they come again at
// every rebuild), never faults; a spy on the store's `piece` makes them.
describe("a batch that reaches past the piece it was built from", () => {
  const piece = DocStore.prototype.piece;
  /** What the store's `piece` does while a test says so: nothing otherwise. */
  let faulty: "leaves" | "unmade" | undefined;

  beforeEach(() => {
    faulty = undefined;
    vi.spyOn(DocStore.prototype, "piece").mockImplementation(function (this: DocStore, version, at) {
      if (faulty === "unmade") throw new DocPieceError("A piece that cannot be made.");
      let made = piece.call(this, version, at);
      if (faulty !== "leaves") return made;
      // The piece's inner range narrowed to nothing at its end, where the tab goes on before
      // it: the batch built from it names an index before it.
      let { inner } = made.at;
      return { ...made, at: { ...made.at, first: false, inner: { from: inner.to, to: inner.to } } };
    });
  });
  afterEach(() => vi.restoreAllMocks());

  /** What `run` throws, which must be a refusal of the edit. */
  const refusalOf = (run: () => unknown): DocEditRefusedError => {
    let thrown = thrownBy(run);
    expect(thrown).toBeInstanceOf(DocEditRefusedError);
    return thrown as DocEditRefusedError;
  };
  /** The words of a fault of the model for a replacement, as the suite's own fault words it. */
  function modelFault(): string {
    let { store, base } = storedTabs(PROSE());
    modelThrows(new RangeError("out of range"));
    return refusalOf(() => docEditResult(store, base(), replaceWorld)).refusal.reason;
  }
  const APPEND: DocEdit = { type: "appendText", markdown: "More" };
  /** The refusal of each record a fold refused, by the record's id. */
  const refusedOf = (fold: TabFold) =>
    new Map(fold.refused.map(({ record: { id }, refusal }) => [id, refusal]));
  /** The tab a fold of `stored` reached, as its stored Markdown. */
  const markdownOf = (stored: Stored, fold: TabFold) => stored.store.markdown(fold.entity!);
  /** The lines logged for `event`. */
  const logged = (spy: { mock: { calls: unknown[][] } }, event: string) =>
    spy.mock.calls.map(([line]) => line as Record<string, unknown>).filter(line => line?.event === event);

  it("is refused in the words of a fault of the model, marked, stored and thrown again", () => {
    let reason = modelFault();
    let { store, base } = storedTabs(PROSE());
    faulty = "leaves";
    let reading = storedTabReading(store, base());

    let thrown = refusalOf(() => docEditResult(store, base(), replaceWorld, reading));

    expect(thrown.name).toBe("DocModelError");
    expect(thrown.refusal).toEqual({ reason, overreach: "before" });
    // The batch was built from a piece, which the reading let go of as the build refused it.
    expect(reading.takeDecoded()).toBeUndefined();
    expect(thrown.refusal.modelError).toBeUndefined();
    expect(reason).toBe(
      "replaceText: this change cannot be shown as it will read once applied, so it cannot be " +
      "made through this connection. Make it in Google Docs.");
    expect(store.result(base(), docEditKey(replaceWorld))).toEqual({ refusal: thrown.refusal });
    expect(docRefusal(thrown)).toBe(thrown.refusal);
    // What `tabEditRequests` throws for it stands for the same refusal.
    let cause = new DocPieceOverreachError("before");
    expect([cause.name, cause.message])
      .toEqual(["DocPieceOverreachError", "A batch reaches past the piece it was built from."]);
    expect(docRefusal(new DocModelError(reason, cause))).toEqual(thrown.refusal);

    // Asked again: the refusal is found stored, nothing decoded or rendered.
    faulty = undefined;
    let again!: DocEditRefusedError;
    let cost = spent(() => { again = refusalOf(() => docEditResult(store, base(), replaceWorld)); });
    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 0, resultsFound: 1, resultsStored: 0 });
    expect([again.name, again.message]).toEqual(["DocModelError", reason]);
    expect(again.refusal).toEqual(thrown.refusal);
  });

  it("a table change's batch past its piece is refused the same, and closes its tab's table gate", () => {
    let stored = storedTabs(TABLED());
    let { store, base } = stored;
    let rows: DocEdit = { type: "insertTableRows", at: 1, cells: [["x", "y"]], expected: expectedOf(TABLED()) };
    let reason = "insertTableRows: this change cannot be shown as it will read once applied, so it " +
      "cannot be made through this connection. Make it in Google Docs.";
    faulty = "leaves";

    // The piece around the table, narrowed: the batch names the table's start, before it.
    let thrown = refusalOf(() => docEditResult(store, base(), rows));
    expect(thrown.name).toBe("DocModelError");
    expect(thrown.refusal).toEqual({ reason, overreach: "before" });
    expect(store.result(base(), docEditKey(rows))).toEqual({ refusal: thrown.refusal });

    // In a fold it closes the tab's table gate, and a change placed by its text is made.
    let fold = foldOf(stored, [
      record(1, rows),
      record(2, { type: "deleteTableRows", at: 0, count: 1, expected: expectedOf(TABLED()) }),
      record(3, APPEND),
    ]);
    expect(refusedOf(fold)).toStrictEqual(new Map<number, DocRefusal>([
      [1, { reason, overreach: "before", closesGate: true }],
      [2, { reason: tableGateRefusal("deleteTableRows").message, closesGate: true }],
    ]));
    expect(markdownOf(stored, fold)).toBe(`${store.markdown(base())}\nMore\n`);
  });

  it("is logged from its mark: the operation and the side, and nothing of the batch", () => {
    let error = vi.spyOn(console, "error").mockImplementation(() => {});
    let { store, base } = storedTabs(PROSE());
    faulty = "leaves";
    let thrown = refusalOf(() => docEditResult(store, base(), replaceWorld));
    faulty = undefined;

    logModelRefusal("replaceText", thrown);

    expect(logged(error, "google.doc.piece.overreach")).toEqual([{
      component: "gatekeeper.google", vendorId: "google", event: "google.doc.piece.overreach",
      operation: "replaceText", side: "before",
      message: "Google Doc edit's batch reaches past the piece of the tab it was built from",
    }]);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("a piece that cannot be made is refused in the same words, marked as a fault", () => {
    let reason = modelFault();
    let stored = storedTabs(PROSE());
    let { store, storage, base } = stored;
    faulty = "unmade";

    // A preparation asks its piece before the edit, and lets the error pass as it is.
    let before = storage.rows();
    let prepared = thrownBy(() => prepareTextReplacement(
      store, base(), "world", "there", "Tab", googleDocDisplayLimit("replaceText")));
    expect(prepared).toBeInstanceOf(DocPieceError);
    expect((prepared as Error).name).toBe("DocPieceError");
    expect(storage.rows()).toEqual(before);

    let thrown = refusalOf(() => docEditResult(store, base(), replaceWorld));
    expect(thrown.name).toBe("DocModelError");
    expect(thrown.refusal.reason).toBe(reason);
    expect(thrown.refusal.overreach).toBeUndefined();
    expect(thrown.refusal.modelError?.name).toBe("DocPieceError");
    expect(thrown.refusal.modelError?.frames).toContain("docs-replay.test");
    expect(store.result(base(), docEditKey(replaceWorld))).toEqual({ refusal: thrown.refusal });

    // The fold goes on past it, and the copy is not dropped: the version reads back.
    faulty = undefined;
    let fold = foldOf(stored, [record(1, replaceWorld), record(2, { type: "replaceText", oldMarkdown: "End", newMarkdown: "Finish" })]);
    expect(refusedOf(fold)).toStrictEqual(new Map([[1, thrown.refusal]]));
    expect(markdownOf(stored, fold)).toBe("Hello world\n\nFinish\n");
    expect(store.markdown(base())).toBe("Hello world\n\nEnd\n");
  });
});
