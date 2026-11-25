import { ActionApplyError, ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { RpcStub } from "cloudflare:workers";
import {
  assertGoogleDocDisplaySize, describeDocEdit, DOC_DEFINITIONS, DOC_REVISION_PIN_MS,
  DOC_SNAPSHOT_TTL_MS, docDefinition, docRevisionPins, googleDocDisplayLimit, pendingDocKeys,
  replayGoogleDoc, replayGoogleDocActions, REPLAY_CONTEXT, type DocHost, type GoogleDocAction,
  type GoogleDocEditAction, type GoogleDocPendingAction, type GoogleDocReplay,
  type GoogleDocReplayQueue, type GoogleDocSnapshot,
} from "../../src/doc-actions";
import {
  driveDocSource, GoogleDocSessionImpl, type DocChangeQueue, type DriveDocSource,
} from "../../src/docs";
import {
  blankDocsTab, type GoogleDocsApi, type GoogleDocsDocument, type GoogleDocsTab,
} from "../../src/docs-api";
import { replayCost } from "../../src/docs-model";
import type { RunSizes } from "../../src/docs-runs";
import {
  applyDocEdit, docEditResult, materializeDocEdit, type DocEdit,
} from "../../src/docs-replay";
import {
  driveDocCopies, DriveDocCopyLimits, StoredDocCopy, storedDocCopy, storedIn, type DocCopy,
  type DocCopyRemoval,
} from "../../src/docs-copy";
import { DOC_COPY_UNREADABLE, pruneTab } from "../../src/docs-replica";
import {
  DOC_ROW_BYTES, DocRowTooLargeError, DocRunRenderError, DocStore, docStoreCost,
  type DocStoreStorage, type DocVersion,
} from "../../src/docs-store";
import {
  prepareTableChange, prepareTextReplacement, type TableCall,
} from "../../src/docs-table-actions";
import { tableGateRefusal, tableIdentity } from "../../src/docs-tables";
import type { DriveAction } from "../../src/drive-actions";
import type { DriveApi } from "../../src/drive-api";
import { DriveFileEditors } from "../../src/drive-editors";
import { GoogleApiError } from "../../src/google-response";
import { docTabToMarkdown, MARKDOWN_RENDERING_VERSION } from "../../src/markdown-converter";
import type { GoogleSheetsApi } from "../../src/sheets-api";
import {
  buildTab, BULLET_LIST, cardField, diceOf, footnote, grid, item, keptSnapshot, NUMBERED_LIST,
  para, presetLevels, tableAt, thrownMessage, type BlockSpec, type Dice,
} from "../doc-fixture";
import { storedRows, tableCounts } from "../doc-store-scenarios";
import { FakeKv } from "../fake-kv";
import { WIDER } from "../wider-run";
import { withDocStore } from "./doc-store-host";

type Append = Parameters<typeof DOC_DEFINITIONS.appendText.describe>[0];
type Replace = Parameters<typeof DOC_DEFINITIONS.replaceText.describe>[0];
type AddTab = Parameters<typeof DOC_DEFINITIONS.addTab.describe>[0];

const BASE = {
  tabId: "tab-1", submittedAt: 0, markdownVersion: MARKDOWN_RENDERING_VERSION, writeId: "w-1",
};
const APPEND: Append = { ...BASE, type: "appendText", markdown: "More", display: { tab: "\"Main\" (tab-1)" } };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The store of the test that is running, for the length of its body (`inStore`). */
let store: DocStore | undefined;
/** The storage that store is on. */
let storage: DurableObjectStorage | undefined;
let kept = 0;

/** `body` as a test inside a Durable Object, whose storage holds the test's store. */
function inStore<A extends unknown[]>(body: (...args: A) => unknown): (...args: A) => Promise<void> {
  return (...args) => withDocStore(async (made, on) => {
    store = made;
    storage = on;
    try {
      await body(...args);
    } finally {
      store = storage = undefined;
    }
  });
}

/** `tab` as the store reads it back: its opening section break has no start index, as Google sends. */
function asStored(tab: GoogleDocsTab): GoogleDocsTab {
  let [{ startIndex: _, ...opening }, ...rest] = tab.body.content;
  return { ...tab, body: { content: [opening as GoogleDocsTab["body"]["content"][number], ...rest] } };
}

/** The store of the running test. */
function running(): DocStore {
  if (!store) throw new Error("This test keeps a snapshot: run its body with inStore().");
  return store;
}

/** `document` as a snapshot, kept in the running test's store under a key of its own. */
const snapshotOf = (document: GoogleDocsDocument): GoogleDocSnapshot =>
  keptSnapshot(running(), document, `doc-${kept++}`);

/** `tab` put in the running test's store under a document of its own, to prepare an edit in. */
const versionOf = (tab: GoogleDocsTab): DocVersion =>
  running().putTab(`prepared-${kept++}`, tab, []);

/** The Markdown of `version`, a tab of a copy in the running test's store or of a replay over one. */
const markdownIn = (version: DocVersion | undefined): string => running().markdown(version!);

/** What a Drive source needs of the running test's store, for file `doc`. */
const copiesOf = (doc = "file") => driveDocCopies(running, doc);

/** The two forms a host's `tryFetched` has, by whose it is. */
const FORMS = ["a bound Doc's", "a Drive connection's"] as const;
type Form = typeof FORMS[number];
/** What no pending edit reaches. */
const NONE = { edits: [], roots: [] };

/** How a fake host stores the document its approval fetched: in which `form`, where. */
type Fetching = { form?: Form; doc?: string; store?: () => DocStore };

/**
 * A host over one stubbed document, recording `landed`, `unapplyable`, `spendCopy` and
 * `tryFetched`. `getDocument` answers a fresh copy: storing a fetched document empties it.
 */
function host(
  document: GoogleDocsDocument, receipt?: { actionId: number; markerId: string },
  held?: GoogleDocSnapshot, fetching: Fetching = {},
) {
  let { form = FORMS[0], doc = "fetched", store: on = running } = fetching;
  let api = {
    getDocument: vi.fn(async () => structuredClone(document)),
    deleteNamedRange: vi.fn<GoogleDocsApi["deleteNamedRange"]>(async () => {}),
    batchUpdate: vi.fn<GoogleDocsApi["batchUpdate"]>(
      async () => ({ revisionId: "r-next", writeMarkerId: "marker-new", replies: [] })),
  };
  let landed = vi.fn<DocHost["landed"]>();
  let unapplyable = vi.fn<DocHost["unapplyable"]>(async () => {});
  let spendCopy = vi.fn<DocHost["spendCopy"]>(() => { held = undefined; });
  let tryFetched = vi.fn<DocHost["tryFetched"]>(form === FORMS[0]
    ? (fetched, use) => on().trial(doc, on().fetched(fetched, Date.now()), () => NONE,
      head => use(storedDocCopy(on(), doc, head, { trial: true })))
    : (fetched, use) => driveDocCopies(on, doc).tryFetched(fetched, Date.now(), use));
  let docHost: DocHost = {
    api: api as unknown as DocHost["api"],
    documentId: "doc-1",
    mimeType: async () => "application/vnd.google-apps.document",
    receipt: () => receipt,
    clearReceipt: () => {},
    saved: () => {},
    landed,
    unapplyable,
    heldCopy: () => held,
    spendCopy,
    tryFetched: tryFetched as DocHost["tryFetched"],
  };
  return { api, landed, unapplyable, spendCopy, tryFetched, docHost };
}

function document(text: string): GoogleDocsDocument {
  return {
    documentId: "doc-1", title: "Plan", revisionId: "r1",
    tabs: [{ ...buildTab([{ runs: [`${text}\n`] }]), title: "Main" }],
  };
}

/** `document(text)` at revision `revisionId`. */
const docAt = (revisionId: string, text: string): GoogleDocsDocument =>
  ({ ...document(text), revisionId });

/** `doc` with the markers `ids` of write `writeId` in its first tab. */
function withMarkers(doc: GoogleDocsDocument, writeId: string, ...ids: string[]): GoogleDocsDocument {
  let name = `gadgets-write-${writeId}`;
  let [first, ...rest] = doc.tabs;
  let namedRanges = { [name]: { namedRanges: ids.map(namedRangeId => ({ namedRangeId, name })) } };
  return { ...doc, tabs: [{ ...first, namedRanges }, ...rest] };
}

/** What `landed` was told, call by call: the edit, its marker and the tab an add made. */
const landings = (landed: MockInstance<DocHost["landed"]>) => landed.mock.calls.map(
  ([id, marker, addedTab]) => ({ id, ...marker && { marker }, ...addedTab && { addedTab } }));

/** The lines logged of a batch built from the copy held that was not accepted. */
const copyRefusals = (warn: MockInstance<typeof console.warn>) =>
  warn.mock.calls.map(([line]) => line as Record<string, unknown>)
    .filter(line => line?.event === "google.doc.action.apply.copy-refused");

/** A refusal of a Docs batch with `status`, as the Docs API throws one. */
const docsRefusal = (status: string | undefined) =>
  new GoogleApiError("Google Docs batchUpdate failed [http=400]", status);
/** Google's refusal of a batch pinned to a revision the document has moved past. */
const STALE_PIN = () => docsRefusal("INVALID_ARGUMENT");
/** Google's answer to the batch that adds a tab. */
const ADDED_TAB_REPLY = {
  revisionId: "r-next", writeMarkerId: "marker-new",
  replies: [{ addDocumentTab: { tabProperties: { tabId: "tab-made" } } }],
};

describe("Google Doc edit definitions", () => {
  it("declares text edits, new tabs and table changes under their three kinds, applied without a claim", () => {
    for (let [name, definition] of Object.entries(DOC_DEFINITIONS)) {
      expect(definition.kind.tag, name).toBe(
        name === "addTab" ? "addDocumentTab"
          : name === "replaceText" || name === "appendText" ? "editDocument" : "document-tables");
      expect(definition.autoApprovable, name).toBe(true);
      expect(definition.delivery, name).toBe("continue-with-simulation");
      // A retried approval settles from the write's own marker instead.
      expect(definition.claimBeforeApply, name).toBeUndefined();
    }
  });

  it("builds each card from the stored edit and its display fields", () => {
    expect(DOC_DEFINITIONS.appendText.describe(APPEND, undefined as never)).toMatchObject({
      title: "Append to Google Doc",
      description: "Append content to the end of tab \"Main\" (tab-1).",
      fields: [{ label: "Content", value: "More" }],
    });

    // Only what differs from the stored text is recorded for the card.
    let replace: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "a", newMarkdown: "*b*",
      display: { tab: "\"Main\" (tab-1)", rendered: "_b_" },
    };
    expect(DOC_DEFINITIONS.replaceText.describe(replace, undefined as never)).toMatchObject({
      title: "Edit Google Doc",
      description: "Replace text in tab \"Main\" (tab-1).",
      fields: [
        { label: "Old", value: "a" }, { label: "Requested New", value: "*b*" },
        { label: "New", value: "_b_" },
      ],
    });

    let add: AddTab = {
      submittedAt: 0, writeId: "w-2", type: "addTab", provisionalTabId: "pending-tab-1", title: "Notes",
      display: { placement: "Add a new, empty tab at the top level, after the tabs already there." },
    };
    expect(DOC_DEFINITIONS.addTab.describe(add, undefined as never)).toMatchObject({
      title: "Add tab to Google Doc",
      description: "Add a new, empty tab at the top level, after the tabs already there.",
      fields: [{ label: "Title", value: "Notes" }],
    });

    // A table change shows the card prepared when it was queued, which is stored with it.
    let rows: Parameters<typeof DOC_DEFINITIONS.insertTableRows.describe>[0] = {
      ...BASE, type: "insertTableRows", expected: "<table>\n  <tr>\n    <td>Name</td>\n  </tr>\n</table>",
      at: 1, cells: [["Ana"]],
      display: {
        title: "Add a row to a table in a Google Doc",
        description: {
          description: "Add 1 row to table 1 of tab \"Main\" (tab-1).",
          fields: [{ label: "New row", kind: "text", value: "Ana" }],
        },
      },
    };
    expect(DOC_DEFINITIONS.insertTableRows.describe(rows, undefined as never)).toEqual({
      title: "Add a row to a table in a Google Doc",
      description: "Add 1 row to table 1 of tab \"Main\" (tab-1).",
      fields: [{ label: "New row", kind: "text", value: "Ana" }],
      implementsRevert: false,
    });
    expect(() => DOC_DEFINITIONS.insertTableRows.describe({ ...rows, display: undefined }, undefined as never))
      .toThrow("This Google Doc edit has no card to show.");

    // A record stored before cards were built from records is never described again.
    expect(() => DOC_DEFINITIONS.appendText.describe({ ...APPEND, display: undefined }, undefined as never))
      .toThrow("This Google Doc edit has no card to show.");
  });

  it("builds a replacement's card around the text named, and a cell's as the table's HTML", () => {
    // The card's old and requested texts are the edit's own between the context stored with it.
    let widened: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "b", newMarkdown: "b\n\nplain",
      display: {
        tab: "\"Main\" (tab-1)", context: { before: "", after: "\n1. c" },
        rendered: "b\n\nplain\n\n3. c",
      },
    };
    expect(describeDocEdit(widened).fields).toEqual([
      cardField("Old", "b\n1. c", "markdown"),
      cardField("Requested New", "b\n\nplain\n1. c", "markdown"),
      cardField("New", "b\n\nplain\n\n3. c", "markdown"),
    ]);

    // With no rendering stored, a read returns the requested text, context included.
    let { rendered: _, ...context } = widened.display!;
    expect(describeDocEdit({ ...widened, display: context })
      .fields).toEqual([
        cardField("Old", "b\n1. c", "markdown"),
        cardField("New", "b\n\nplain\n1. c", "markdown"),
      ]);

    let cell: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "alpha", newMarkdown: "A & B", inTable: true,
      display: { tab: "x", prose: "Replace text in a table.", rendered: "A &amp; B" },
    };
    expect(DOC_DEFINITIONS.replaceText.describe(cell, undefined as never)).toMatchObject({
      title: "Edit Google Doc",
      description: "Replace text in a table.",
      fields: [
        cardField("Old", "alpha", "html"), cardField("Requested New", "A & B", "html"),
        cardField("New", "A &amp; B", "html"),
      ],
    });
  });

  it("shows on an append's card the rendering stored with it, or the canonical form", () => {
    let stored: Append = { ...APPEND, markdown: "\nplain", display: { tab: "x", rendered: "\n\nplain" } };
    expect(describeDocEdit(stored).fields).toEqual([
      cardField("Requested", "\nplain", "markdown"), cardField("Resulting", "\n\nplain", "markdown"),
    ]);
    // A record stored with no rendering reads as the canonical form of its text.
    let escaped: Append = { ...APPEND, markdown: String.raw`\# title`, display: { tab: "x" } };
    expect(describeDocEdit(escaped).fields).toEqual([
      cardField("Requested", String.raw`\# title`, "markdown"),
      cardField("Resulting", "# title", "markdown"),
    ]);
  });

  it("holds what a card shows beyond the edit to the bytes the edit's own texts are held to", () => {
    const MIB = 1024 * 1024;
    let rendered = "r".repeat(MIB - 20);
    let context = { before: "b".repeat(10), after: "a".repeat(10) };
    expect(() => assertGoogleDocDisplaySize("replaceText", { tab: "x", rendered, context }))
      .not.toThrow();
    // The tab's label is the card's own and is not counted.
    expect(() => assertGoogleDocDisplaySize("replaceText", { tab: "x".repeat(2 * MIB) })).not.toThrow();
    expect(() => assertGoogleDocDisplaySize(
      "replaceText", { tab: "x", rendered, context: { ...context, after: "a".repeat(11) } },
    )).toThrow(
      "replaceText: what this edit's approval card would show exceeds the 1048576-byte safe " +
      "submission limit. Split the edit into smaller ones.");
    // Bytes, not characters: a character of two bytes counts twice.
    expect(() => assertGoogleDocDisplaySize("appendText", { tab: "x", rendered: "é".repeat(MIB / 2) }))
      .not.toThrow();
    expect(() => assertGoogleDocDisplaySize("appendText", { tab: "x", rendered: "é".repeat(MIB / 2) + "a" }))
      .toThrow(/^appendText: what this edit's approval card would show exceeds/);
  });

  it("writes an edit once, with a marker, and reports where it landed", inStore(async () => {
    let { api, landed, docHost } = host(document("Draft"));
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
    expect(api.batchUpdate).toHaveBeenCalledTimes(1);
    expect(api.batchUpdate.mock.calls[0]).toMatchObject(
      ["doc-1", expect.any(Array), "r1", { name: "gadgets-write-w-1", tabId: "tab-1" }]);
    expect(landed).toHaveBeenCalledWith(4, { id: "marker-new", tabId: "tab-1" }, undefined);
  }));

  // A connection whose record outlives its receipt, as a Drive binding's does until the kit
  // retires it, can be approved again in between: it must not clean up its own marker first.
  it("settles from a receipt that names the edit, without cleaning up or writing", async () => {
    let { api, landed, docHost } = host(document("Draft"), { actionId: 4, markerId: "marker-old" });
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
    expect(api.deleteNamedRange).not.toHaveBeenCalled();
    expect(api.batchUpdate).not.toHaveBeenCalled();
    expect(landed).toHaveBeenCalledWith(4, undefined);
  });

  it("fails for good an edit that no longer applies, recording why first", inStore(async () => {
    let { api, unapplyable, docHost } = host(document("Draft"));
    let replace: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "Gone", newMarkdown: "New", display: { tab: "x" },
    };
    let applied = DOC_DEFINITIONS.replaceText.apply(replace, docHost, { id: 2 });
    await expect(applied).rejects.toBeInstanceOf(ActionApplyError);
    await expect(applied).rejects.toThrow("oldMarkdown was not found");
    expect(unapplyable).toHaveBeenCalledWith(
      2, replace, expect.stringMatching(/^Pending Google Doc edit could not be applied: /));
    expect(api.batchUpdate).not.toHaveBeenCalled();
  }));

  // An edit built from the copy the connection holds

  it("builds an edit from the copy held and pins it to the copy's revision, reading no document", inStore(async () => {
    let held = snapshotOf(docAt("r-copy", "Draft"));
    let { api, landed, spendCopy, docHost } = host(docAt("r-now", "Other"), undefined, held);
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
    expect(api.getDocument).not.toHaveBeenCalled();
    expect(api.batchUpdate).toHaveBeenCalledTimes(1);
    expect(api.batchUpdate.mock.calls[0]).toMatchObject(
      ["doc-1", expect.any(Array), "r-copy", { name: "gadgets-write-w-1", tabId: "tab-1" }]);
    expect(spendCopy).toHaveBeenCalledWith(held);
    expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-new", tabId: "tab-1" } }]);
  }));

  // A stored result is keyed by the edit's fields, not the preview version: the version is asked
  // first.
  it("builds no write from a stored result for an edit stored under an earlier Markdown version", inStore(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let held = snapshotOf(docAt("r-copy", "Draft"));
    let earlier: Append = { ...APPEND, markdownVersion: 5 };
    // What a replay of the same edit, previewed under the current version, stored.
    let stored = docEditResult(storedIn(held.copy).store, held.copy.tab("tab-1")!, earlier);
    expect(stored.requests.length).toBeGreaterThan(0);
    let { api, landed, unapplyable, docHost } = host(docAt("r-now", "Draft"), undefined, held);

    let applied = DOC_DEFINITIONS.appendText.apply(earlier, docHost, { id: 4 });

    await expect(applied).rejects.toThrow(EARLIER_FORMAT);
    // The document was read, and refused the edit as it does with no copy held.
    expect(api.getDocument).toHaveBeenCalledTimes(1);
    expect(api.batchUpdate).not.toHaveBeenCalled();
    expect(unapplyable).toHaveBeenCalledWith(
      4, earlier, `Pending Google Doc edit could not be applied: ${EARLIER_FORMAT}`);
    expect(landed).not.toHaveBeenCalled();
  }));

  it("builds a write from the copy as a replay makes it, and keeps nothing of it", inStore(async () => {
    let held = snapshotOf(docAt("r-copy", "Draft"));
    let { api, landed, docHost } = host(docAt("r-now", "Other"), undefined, held);
    let before = { ...docStoreCost };
    let rows = storedRows(storage!);
    let atBatch: { cost: typeof before; rows: string } | undefined;
    api.batchUpdate.mockImplementationOnce(async () => {
      atBatch = { cost: { ...docStoreCost }, rows: storedRows(storage!) };
      return { revisionId: "r-next", writeMarkerId: "marker-new", replies: [] };
    });

    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });

    // No result was stored: the edit is made and checked as a replay makes it, then undone.
    expect(api.getDocument).not.toHaveBeenCalled();
    expect(atBatch!.rows).toBe(rows);
    expect(atBatch!.cost).toMatchObject({
      runsDecoded: before.runsDecoded + 1, runsRendered: before.runsRendered + 2,
      resultsStored: before.resultsStored + 1, resultsFound: before.resultsFound,
    });
    expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-new", tabId: "tab-1" } }]);
  }));

  it("sends the batch a replay stored for the edit, decoding no tab", inStore(async () => {
    let held = snapshotOf(docAt("r-copy", "Draft"));
    let { requests } = docEditResult(storedIn(held.copy).store, held.copy.tab("tab-1")!, APPEND);
    let { api, docHost } = host(docAt("r-now", "Other"), undefined, held);
    let decoded = docStoreCost.runsDecoded;

    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });

    expect(api.getDocument).not.toHaveBeenCalled();
    expect(api.batchUpdate.mock.calls[0][1]).toEqual(requests);
    expect(api.batchUpdate.mock.calls[0][2]).toBe("r-copy");
    expect(docStoreCost.runsDecoded).toBe(decoded);
  }));

  it.each<[string, (api: ReturnType<typeof host>["api"]) => void]>([
    ["is answered", () => {}],
    ["is refused with INVALID_ARGUMENT", api => api.batchUpdate.mockRejectedValueOnce(STALE_PIN())],
    ["is refused with no status", api => api.batchUpdate.mockRejectedValueOnce(docsRefusal(undefined))],
    ["fails with a plain Error", api => api.batchUpdate.mockRejectedValueOnce(new Error("socket closed"))],
    ["is answered without a marker id",
      api => api.batchUpdate.mockResolvedValueOnce({ revisionId: "r-next", replies: [] })],
  ])("spends the copy before its batch leaves, when the batch %s", inStore(async (_name, arrange) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let held = snapshotOf(docAt("r-copy", "Draft"));
    let { api, spendCopy, docHost } = host(docAt("r-now", "Draft"), undefined, held);
    arrange(api);
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 }).catch(() => {});
    expect(spendCopy).toHaveBeenCalledTimes(1);
    expect(spendCopy).toHaveBeenCalledWith(held);
    expect(api.batchUpdate.mock.calls[0][2]).toBe("r-copy");
    expect(spendCopy.mock.invocationCallOrder[0])
      .toBeLessThan(api.batchUpdate.mock.invocationCallOrder[0]);
  }));

  it("does not spend a copy it builds no batch from", inStore(async () => {
    // The copy holds the write's marker.
    let settled = host(docAt("r-now", "Draft"), undefined,
      snapshotOf(withMarkers(docAt("r-copy", "Draft"), "w-1", "marker-1")));
    await DOC_DEFINITIONS.appendText.apply(APPEND, settled.docHost, { id: 4 });
    expect(settled.spendCopy).not.toHaveBeenCalled();

    // The copy cannot say.
    let unpinned = host(docAt("r-now", "Draft"), undefined,
      { ...snapshotOf(docAt("r-copy", "Draft")), revisionId: undefined });
    await DOC_DEFINITIONS.appendText.apply(APPEND, unpinned.docHost, { id: 4 });
    expect(unpinned.spendCopy).not.toHaveBeenCalled();

    // An add of a tab.
    let added = host(docAt("r-now", "Draft"), undefined, snapshotOf(docAt("r-copy", "Draft")));
    added.api.batchUpdate.mockResolvedValueOnce(ADDED_TAB_REPLY);
    await DOC_DEFINITIONS.addTab.apply(add("pending-tab-1", {}), added.docHost, { id: 4 });
    expect(added.spendCopy).not.toHaveBeenCalled();

    // A receipt waits.
    let waiting = host(docAt("r-now", "Draft"), { actionId: 9, markerId: "marker-old" },
      snapshotOf(docAt("r-copy", "Draft")));
    await DOC_DEFINITIONS.appendText.apply(APPEND, waiting.docHost, { id: 4 });
    expect(waiting.spendCopy).not.toHaveBeenCalled();
    for (let { landed } of [settled, unpinned, added, waiting]) expect(landed).toHaveBeenCalledTimes(1);
  }));

  it("reads the document and builds again when Google refuses the batch built from a stale copy", inStore(async () => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fresh = docAt("r-now", "Draft and what a collaborator wrote since");
    let { api, landed, docHost } = host(fresh, undefined, snapshotOf(docAt("r-copy", "Draft")));
    api.batchUpdate.mockRejectedValueOnce(STALE_PIN());
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });

    expect(api.getDocument).toHaveBeenCalledTimes(1);
    expect(api.batchUpdate).toHaveBeenCalledTimes(2);
    let [[, staleRequests, staleRevision, staleMarker], [, requests, revision, marker]] =
      api.batchUpdate.mock.calls;
    expect(staleRevision).toBe("r-copy");
    expect(revision).toBe("r-now");
    // Built against the document as it is: the append goes at its end, past where the copy ended.
    expect(requests).toEqual(materializeDocEdit(fresh.tabs, APPEND).requests);
    expect(requests).not.toEqual(staleRequests);
    expect(marker!.rangeStart).toBeGreaterThan(staleMarker!.rangeStart);
    expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-new", tabId: "tab-1" } }]);

    expect(copyRefusals(warn)).toHaveLength(1);
    expect(copyRefusals(warn)[0]).toMatchObject({
      actionId: 4, operation: "appendText", failure: "absent",
      providerStatus: "INVALID_ARGUMENT", fallback: "read",
    });
  }));

  it("logs a batch built from the copy that was not accepted, with nothing of the document", inStore(async () => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let replace: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "Quokka", newMarkdown: "Numbat", display: { tab: "x" },
    };
    let held = snapshotOf(docAt("revision-wombat", "Quokka wanders"));
    let { api, docHost } = host(docAt("r-now", "Quokka wanders"), undefined, held);
    // A message Google's errors never have: the caught value is not what is logged.
    api.batchUpdate.mockRejectedValueOnce(
      new GoogleApiError("Google refused to move the Tamarin past Quokka", "INVALID_ARGUMENT"));
    await DOC_DEFINITIONS.replaceText.apply(replace, docHost, { id: 7 });

    let [line, ...more] = copyRefusals(warn);
    expect(more).toEqual([]);
    // Beside what the logger writes on every line, the line holds these fields and no other.
    let { component: _c, vendorId: _v, message: _m, level: _l, ...own } = line;
    expect(own).toStrictEqual({
      event: "google.doc.action.apply.copy-refused", actionId: 7, operation: "replaceText",
      failure: "absent", providerStatus: "INVALID_ARGUMENT", fallback: "read",
    });
    let written = JSON.stringify(line);
    for (let word of ["Quokka", "wanders", "Numbat", "Tamarin", "revision-wombat"]) {
      expect(written, word).not.toContain(word);
    }
  }));

  it("logs nothing of the copy where no batch built from it fails", inStore(async () => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let copy = () => snapshotOf(docAt("r-copy", "Draft"));
    // The copy's batch is answered.
    await DOC_DEFINITIONS.appendText.apply(
      APPEND, host(docAt("r-now", "Draft"), undefined, copy()).docHost, { id: 4 });
    // The copy holds the write's marker.
    await DOC_DEFINITIONS.appendText.apply(APPEND, host(docAt("r-now", "Draft"), undefined,
      snapshotOf(withMarkers(docAt("r-copy", "Draft"), "w-1", "marker-1"))).docHost, { id: 4 });
    // The copy cannot say.
    await DOC_DEFINITIONS.appendText.apply(APPEND, host(docAt("r-now", "Draft"), undefined,
      { ...copy(), revisionId: undefined }).docHost, { id: 4 });
    // An add of a tab.
    let added = host(docAt("r-now", "Draft"), undefined, copy());
    added.api.batchUpdate.mockResolvedValueOnce(ADDED_TAB_REPLY);
    await DOC_DEFINITIONS.addTab.apply(add("pending-tab-1", {}), added.docHost, { id: 4 });
    // No copy is held, and the batch built from the document is refused.
    let refused = host(docAt("r-now", "Draft"));
    refused.api.batchUpdate.mockRejectedValueOnce(STALE_PIN());
    await expect(DOC_DEFINITIONS.appendText.apply(APPEND, refused.docHost, { id: 4 })).rejects.toThrow();
    expect(copyRefusals(warn)).toEqual([]);
  }));

  it("fails as it does on a fresh read when the document no longer takes the edit", inStore(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let replace: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "Draft", newMarkdown: "Final", display: { tab: "x" },
    };
    let { api, landed, unapplyable, docHost } =
      host(docAt("r-now", "Rewritten"), undefined, snapshotOf(docAt("r-copy", "Draft")));
    api.batchUpdate.mockRejectedValueOnce(STALE_PIN());
    let applied = DOC_DEFINITIONS.replaceText.apply(replace, docHost, { id: 2 });
    await expect(applied).rejects.toBeInstanceOf(ActionApplyError);
    await expect(applied).rejects.toThrow("oldMarkdown was not found");
    expect(unapplyable).toHaveBeenCalledWith(
      2, replace, expect.stringMatching(/^Pending Google Doc edit could not be applied: /));
    expect(api.batchUpdate).toHaveBeenCalledTimes(1);
    expect(landed).not.toHaveBeenCalled();
  }));

  it.each<[string, () => Error, string, string | undefined]>([
    ["a failure that is no answer", () => new Error("socket closed"), "unknown", undefined],
    ["a refusal for rate", () => docsRefusal("RESOURCE_EXHAUSTED"), "rateLimited", "RESOURCE_EXHAUSTED"],
    ["a refusal that carries no status", () => docsRefusal(undefined), "unknown", undefined],
  ])("reads the document at the next approval, not in this one, after %s",
    inStore(async (_name, failed, failure, providerStatus) => {
      let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // The document as the retry finds it: without the write's marker, and with it.
      for (let fresh of [docAt("r-now", "Draft"), withMarkers(docAt("r-now", "DraftMore"), "w-1", "marker-1")]) {
        warn.mockClear();
        let { api, landed, docHost } =
          host(fresh, undefined, snapshotOf(docAt("r-copy", "Draft")));
        let error = failed();
        api.batchUpdate.mockRejectedValueOnce(error);
        await expect(DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 })).rejects.toBe(error);
        expect(api.getDocument).not.toHaveBeenCalled();
        expect(api.batchUpdate).toHaveBeenCalledTimes(1);
        expect(landed).not.toHaveBeenCalled();
        let [line, ...more] = copyRefusals(warn);
        expect(more).toEqual([]);
        expect(line).toMatchObject({ actionId: 4, operation: "appendText", failure, fallback: "retry" });
        expect(line.providerStatus).toBe(providerStatus);

        await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
        expect(api.getDocument).toHaveBeenCalledTimes(1);
        if (fresh.tabs[0].namedRanges["gadgets-write-w-1"]) {
          expect(api.batchUpdate).toHaveBeenCalledTimes(1);
          expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-1", tabId: "tab-1" } }]);
        } else {
          expect(api.batchUpdate).toHaveBeenCalledTimes(2);
          expect(api.batchUpdate.mock.calls[1][2]).toBe("r-now");
          expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-new", tabId: "tab-1" } }]);
        }
        expect(copyRefusals(warn)).toHaveLength(1);
      }
    }));

  it("settles from the marker the copy holds, writing and reading nothing", inStore(async () => {
    let held = snapshotOf(withMarkers(docAt("r-copy", "DraftMore"), "w-1", "marker-1"));
    let { api, landed, docHost } = host(docAt("r-now", "DraftMore"), undefined, held);
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
    expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-1", tabId: "tab-1" } }]);
    expect(api.batchUpdate).not.toHaveBeenCalled();
    expect(api.getDocument).not.toHaveBeenCalled();
  }));

  it("finds the marker in the document when the copy predates the write", inStore(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fresh = withMarkers(docAt("r-now", "DraftMore"), "w-1", "marker-1");
    let { api, landed, docHost } = host(fresh, undefined, snapshotOf(docAt("r-copy", "Draft")));
    // The write landed and moved the document past the copy.
    api.batchUpdate.mockRejectedValueOnce(STALE_PIN());
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
    expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-1", tabId: "tab-1" } }]);
    expect(api.batchUpdate).toHaveBeenCalledTimes(1);
    expect(api.getDocument).toHaveBeenCalledTimes(1);
  }));

  it("reads the document while a receipt waits, and deletes its marker first", inStore(async () => {
    let fresh = withMarkers(docAt("r-now", "Draft"), "w-earlier", "marker-old");
    let { api, landed, spendCopy, docHost } = host(
      fresh, { actionId: 9, markerId: "marker-old" }, snapshotOf(docAt("r-copy", "Draft")));
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
    expect(spendCopy).not.toHaveBeenCalled();
    expect(api.deleteNamedRange).toHaveBeenCalledWith("doc-1", "marker-old", "tab-1");
    // Once to find the marker, and again without it.
    expect(api.getDocument).toHaveBeenCalledTimes(2);
    expect(api.deleteNamedRange.mock.invocationCallOrder[0])
      .toBeLessThan(api.batchUpdate.mock.invocationCallOrder[0]);
    expect(api.batchUpdate).toHaveBeenCalledTimes(1);
    expect(api.batchUpdate.mock.calls[0][2]).toBe("r-now");
    expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-new", tabId: "tab-1" } }]);
  }));

  it("reads the document for an add of a tab, whatever copy is held", inStore(async () => {
    let { api, landed, spendCopy, docHost } =
      host(docAt("r-now", "Draft"), undefined, snapshotOf(docAt("r-copy", "Draft")));
    api.batchUpdate.mockResolvedValueOnce(ADDED_TAB_REPLY);
    await DOC_DEFINITIONS.addTab.apply(add("pending-tab-1", {}), docHost, { id: 4 });
    expect(api.getDocument).toHaveBeenCalledTimes(1);
    expect(spendCopy).not.toHaveBeenCalled();
    expect(api.batchUpdate).toHaveBeenCalledTimes(1);
    expect(api.batchUpdate.mock.calls[0][2]).toBe("r-now");
    expect(landings(landed)).toEqual([{
      id: 4, marker: { id: "marker-new", tabId: "tab-1" },
      addedTab: { provisionalTabId: "pending-tab-1", tabId: "tab-made" },
    }]);
  }));

  /** The copy of "Draft" at `r-copy`, with its tabs read through `tab`. */
  const copyReadBy = (tab: (part: DocVersion) => DocVersion | undefined): GoogleDocSnapshot => {
    let snapshot = snapshotOf(docAt("r-copy", "Draft"));
    return { ...snapshot, copy: { ...snapshot.copy, tab: tabId => tab(snapshot.copy.tab(tabId)!) } };
  };
  const REPLACE_DRAFT: Replace = {
    ...BASE, type: "replaceText", oldMarkdown: "Draft", newMarkdown: "Final", display: { tab: "x" },
  };

  it.each<[string, () => GoogleDocSnapshot, Append | Replace, GoogleDocsDocument, "written" | "nothing to write"]>([
    ["has no revision", () => ({ ...snapshotOf(docAt("r-copy", "Draft")), revisionId: undefined }),
      APPEND, docAt("r-now", "Draft"), "written"],
    ["has an empty revision", () => snapshotOf(docAt("", "Draft")),
      APPEND, docAt("r-now", "Draft"), "written"],
    ["lacks the edit's tab", () => snapshotOf({
      ...docAt("r-copy", "Draft"), tabs: [{ ...docAt("r-copy", "Draft").tabs[0], tabId: "tab-9" }],
    }), APPEND, docAt("r-now", "Draft"), "written"],
    // A text run with no content is one the model cannot index.
    ["cannot index it", () => snapshotOf({ ...docAt("r-copy", "Draft"), tabs: [{
      ...docAt("r-copy", "Draft").tabs[0], body: buildTab([{ runs: ["Draft", "", "\n"] }]).body,
    }] }), APPEND, docAt("r-now", "Draft"), "written"],
    ["throws reading it back", () => copyReadBy(() => { throw new Error(DOC_COPY_UNREADABLE); }),
      APPEND, docAt("r-now", "Draft"), "written"],
    // The copy lacks the text the edit replaces, and the document holds it.
    ["refuses the edit", () => snapshotOf(docAt("r-copy", "Sketch")),
      REPLACE_DRAFT, docAt("r-now", "Draft"), "written"],
    ["builds no request for it", () => snapshotOf(docAt("r-copy", "Draft")),
      { ...REPLACE_DRAFT, newMarkdown: "Draft" }, docAt("r-now", "Draft"), "nothing to write"],
    ["holds two markers of the write",
      () => snapshotOf(withMarkers(docAt("r-copy", "Draft"), "w-1", "marker-1", "marker-2")),
      APPEND, docAt("r-now", "Draft"), "written"],
  ])("reads the document when the copy %s", inStore(async (_name, held, action, fresh, outcome) => {
    let { api, landed, spendCopy, docHost } = host(fresh, undefined, held());
    await docDefinition(action).apply(action, docHost, { id: 4 });
    expect(api.getDocument).toHaveBeenCalledTimes(1);
    expect(spendCopy).not.toHaveBeenCalled();
    if (outcome === "written") {
      // Whatever the copy's revision, the one batch sent is pinned to the document's.
      expect(api.batchUpdate.mock.calls.map(([, , revision]) => revision)).toEqual(["r-now"]);
      expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-new", tabId: "tab-1" } }]);
    } else {
      expect(api.batchUpdate).not.toHaveBeenCalled();
      expect(landings(landed)).toEqual([{ id: 4 }]);
    }
  }));
});

describe("how long a revision id pins a write", () => {
  it("pins for 24 hours after Google returned it, and not a millisecond longer", () => {
    expect(DOC_REVISION_PIN_MS).toBe(24 * 60 * 60 * 1000);
    let t = Date.UTC(2026, 0, 1);
    expect(docRevisionPins(t, t)).toBe(true);
    expect(docRevisionPins(t, t + DOC_REVISION_PIN_MS - 1)).toBe(true);
    expect(docRevisionPins(t, t + DOC_REVISION_PIN_MS)).toBe(true);
    expect(docRevisionPins(t, t + DOC_REVISION_PIN_MS + 1)).toBe(false);

    // With no time given, the clock is read.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t + DOC_REVISION_PIN_MS);
    expect(docRevisionPins(t)).toBe(true);
    vi.setSystemTime(t + DOC_REVISION_PIN_MS + 1);
    expect(docRevisionPins(t)).toBe(false);
  });
});

// An edit built from the document its approval fetched

/** The message of what the renderer throws on `tab`. */
const rendererSays = (tab: GoogleDocsTab): string => thrownMessage(() => docTabToMarkdown(tab));

/** The tab `tabId` of a fetched document, by what becomes of storing it. */
const FETCHED_TABS = {
  /** A tab the store holds. */
  stored: (tabId: string): GoogleDocsTab => ({ ...buildTab([para("Draft"), para("Kept")]), tabId }),
  /** A tab with a paragraph too large for one stored row. */
  pastRow: (tabId: string): GoogleDocsTab =>
    ({ ...buildTab([para("Draft"), para("a".repeat(DOC_ROW_BYTES + 1))]), tabId }),
  /** A tab with a paragraph the copy refuses: it has no paragraph style. */
  unstyled(tabId: string): GoogleDocsTab {
    let tab = FETCHED_TABS.stored(tabId);
    delete (tab.body.content[2].paragraph as { paragraphStyle?: unknown }).paragraphStyle;
    return tab;
  },
  /** A tab whose named ranges are malformed: one has an empty id. */
  misnamed: (tabId: string): GoogleDocsTab =>
    ({ ...FETCHED_TABS.stored(tabId), namedRanges: { broken: { namedRanges: [{ namedRangeId: "" }] } } }),
  /** A tab with a list item the renderer throws on: its nesting level is -1. */
  unrendered(tabId: string): GoogleDocsTab {
    let tab = { ...buildTab([para("Draft"), item("Listed"), para("Kept")], BULLET_LIST), tabId };
    tab.body.content[2].paragraph!.bullet!.nestingLevel = -1;
    return tab;
  },
} satisfies Record<string, (tabId: string) => GoogleDocsTab>;
type FetchedTab = keyof typeof FETCHED_TABS;

/** A document at `revisionId` of two tabs: `tab-1`, which the edits here name, and `tab-2`. */
const twoTabs = (revisionId: string, first: FetchedTab, second: FetchedTab): GoogleDocsDocument => ({
  documentId: "doc-1", title: "Plan", revisionId,
  tabs: [
    { ...FETCHED_TABS[first]("tab-1"), title: "Main" },
    { ...FETCHED_TABS[second]("tab-2"), title: "Other", index: 1 },
  ],
});

/** The lines logged of an edit recorded as one that cannot be applied. */
const unapplyableLines = (error: MockInstance<typeof console.error>) =>
  error.mock.calls.map(([line]) => line as Record<string, unknown>)
    .filter(line => line?.event === "google.doc.action.apply.unapplyable");

/** The documents `api.getDocument` answered, in order. */
const documentsAnswered = (api: ReturnType<typeof host>["api"]): Promise<GoogleDocsDocument[]> =>
  Promise.all(api.getDocument.mock.results.map(result => result.value as Promise<GoogleDocsDocument>));

/** How many body elements each tab of `document` holds. */
const elementsOf = (fetched: GoogleDocsDocument): number[] =>
  fetched.tabs.map(tab => tab.body.content.length);

describe.each(FORMS)("an edit built from the document its approval fetched, on %s host", form => {
  /** The document key the copy is stored under and the fetched document is tried beside. */
  const KEPT = "kept";

  /**
   * An approval that falls back: Google refuses the batch pinned to the held copy of a
   * two-tab document, and the approval fetches `fresh`. With the rows as they stood before.
   */
  function fallback(fresh: GoogleDocsDocument, on: () => DocStore = running) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let held = keptSnapshot(running(), twoTabs("r-copy", "stored", "stored"), KEPT);
    let made = host(fresh, undefined, held, { form, doc: KEPT, store: on });
    made.api.batchUpdate.mockRejectedValueOnce(STALE_PIN());
    return { ...made, logged, rows: storedRows(storage!), head: running().head(KEPT) };
  }

  /** Expects storage to hold what it held when `before` was taken. */
  function expectStoredAs(before: { rows: string; head: ReturnType<DocStore["head"]> }): void {
    expect(storedRows(storage!)).toBe(before.rows);
    expect(running().head(KEPT)).toEqual(before.head);
  }

  it("stores the document the fallback fetched in a trial, and builds from it", inStore(async () => {
    let fresh = twoTabs("r-now", "stored", "stored");
    fresh.tabs[0] = { ...buildTab([para("Draft"), para("Written since")]), tabId: "tab-1", title: "Main" };
    // What decoding the edit's tab of the fetched document counts.
    let reference = keptSnapshot(running(), fresh, "reference");
    let counted = docStoreCost.runsDecoded;
    running().tab(reference.copy.tab("tab-1")!);
    let runs = docStoreCost.runsDecoded - counted;
    expect(runs).toBeGreaterThan(0);

    let before = fallback(fresh);
    let { api, landed, tryFetched } = before;
    let decoded = 0;
    api.batchUpdate.mockReset();
    api.batchUpdate.mockImplementationOnce(async () => {
      decoded = docStoreCost.runsDecoded;
      throw STALE_PIN();
    });
    api.batchUpdate.mockResolvedValue({ revisionId: "r-next", writeMarkerId: "marker-new", replies: [] });
    await DOC_DEFINITIONS.appendText.apply(APPEND, before.docHost, { id: 4 });

    expect(tryFetched).toHaveBeenCalledTimes(1);
    // The document went through the walk, which empties each tab's place as it reaches it.
    expect((await documentsAnswered(api)).map(fetched => fetched.tabs.filter(Boolean))).toEqual([[]]);
    expect(docStoreCost.runsDecoded - decoded).toBe(runs);
    expectStoredAs(before);
    let [, [, requests, revision, marker]] = api.batchUpdate.mock.calls;
    let sent = materializeDocEdit(fresh.tabs, APPEND);
    expect(requests).toEqual(sent.requests);
    expect(revision).toBe("r-now");
    expect(marker).toMatchObject({ rangeStart: sent.tab.bodyEndIndex - 1, tabId: "tab-1" });
    expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-new", tabId: "tab-1" } }]);
  }));

  /** `doc` with the markers `markers`, each a write's id and its named range's, in its first tab. */
  function marked(doc: GoogleDocsDocument, markers: Record<string, string>): GoogleDocsDocument {
    let [first, ...rest] = doc.tabs;
    let namedRanges = Object.fromEntries(Object.entries(markers).map(([writeId, namedRangeId]) => {
      let name = `gadgets-write-${writeId}`;
      return [name, { namedRanges: [{ namedRangeId, name }] }];
    }));
    return { ...doc, tabs: [{ ...first, namedRanges }, ...rest] };
  }

  describe.each<[string, FetchedTab]>([
    ["holds a paragraph past a row in another tab", "pastRow"],
    ["holds a list item the renderer throws on in another tab", "unrendered"],
  ])("settles from a receipt or a marker without storing the fetched document, which %s", (_name, other) => {
    const fresh = () => twoTabs("r-now", "stored", other);

    async function expectSettled(
      made: ReturnType<typeof host>, landing: ReturnType<typeof landings>[number], reads: number,
    ): Promise<void> {
      await DOC_DEFINITIONS.appendText.apply(APPEND, made.docHost, { id: 4 });
      expect(made.tryFetched).not.toHaveBeenCalled();
      expect(made.unapplyable).not.toHaveBeenCalled();
      expect(made.api.batchUpdate).not.toHaveBeenCalled();
      let documents = await documentsAnswered(made.api);
      expect(documents).toHaveLength(reads);
      // Nothing walked a document: each still holds every element of every tab.
      for (let fetched of documents) expect(elementsOf(fetched)).toEqual(elementsOf(fresh()));
      expect(landings(made.landed)).toEqual([landing]);
      expect(tableCounts(storage!)).toEqual(tableCounts0);
    }
    let tableCounts0: Record<string, number>;
    const taken = () => { tableCounts0 = tableCounts(storage!); };

    it("with a receipt that names the edit", inStore(async () => {
      taken();
      let made = host(
        marked(fresh(), { "w-1": "marker-1" }), { actionId: 4, markerId: "marker-1" }, undefined, { form });
      await expectSettled(made, { id: 4, marker: { id: "marker-1", tabId: "tab-1" } }, 1);
      expect(made.api.deleteNamedRange).not.toHaveBeenCalled();
    }));

    it("with another edit's receipt, whose marker is deleted first, and this write's marker", inStore(async () => {
      taken();
      let made = host(
        marked(fresh(), { "w-earlier": "marker-old", "w-1": "marker-1" }),
        { actionId: 9, markerId: "marker-old" }, undefined, { form });
      await expectSettled(made, { id: 4, marker: { id: "marker-1", tabId: "tab-1" } }, 2);
      expect(made.api.deleteNamedRange).toHaveBeenCalledTimes(1);
      expect(made.api.deleteNamedRange).toHaveBeenCalledWith("doc-1", "marker-old", "tab-1");
    }));

    it("with this write's marker in the document, after a send whose reply was lost", inStore(async () => {
      taken();
      let made = host(marked(fresh(), { "w-1": "marker-1" }), undefined, undefined, { form });
      await expectSettled(made, { id: 4, marker: { id: "marker-1", tabId: "tab-1" } }, 1);
    }));
  });

  it.each<[string, FetchedTab]>([
    ["holds a paragraph past a row", "pastRow"],
    ["holds a list item the renderer throws on", "unrendered"],
  ])("does not store the fetched document for an add, where it %s", inStore(async (_name, other) => {
    let counts = tableCounts(storage!);
    let made = host(twoTabs("r-now", "stored", other), undefined, undefined, { form });
    made.api.batchUpdate.mockResolvedValueOnce(ADDED_TAB_REPLY);
    await DOC_DEFINITIONS.addTab.apply(add("pending-tab-1", {}), made.docHost, { id: 4 });
    expect(made.tryFetched).not.toHaveBeenCalled();
    expect((await documentsAnswered(made.api)).map(elementsOf)).toEqual([elementsOf(twoTabs("r-now", "stored", other))]);
    expect(made.api.batchUpdate).toHaveBeenCalledTimes(1);
    expect(landings(made.landed)).toEqual([{
      id: 4, marker: { id: "marker-new", tabId: "tab-1" },
      addedTab: { provisionalTabId: "pending-tab-1", tabId: "tab-made" },
    }]);
    expect(tableCounts(storage!)).toEqual(counts);
  }));

  /** What `run` throws. Fails where it returns. */
  async function rejection(run: Promise<unknown>): Promise<unknown> {
    let outcome = await run.then(() => ({ returned: true }), (error: unknown) => ({ error }));
    if ("returned" in outcome) throw new Error("Expected the approval to fail");
    return outcome.error;
  }

  /** The message of what storing `document` throws, in a trial of a document of its own. */
  const storingSays = (fetched: GoogleDocsDocument): string => thrownMessage(() =>
    running().trial("probe", running().fetched(structuredClone(fetched), 0), () => NONE, () => {}));

  it.each<[string, FetchedTab, FetchedTab, new (...args: never[]) => Error]>([
    ["a paragraph past a row in the edit's tab", "pastRow", "stored", DocRowTooLargeError],
    ["a paragraph past a row in another tab", "stored", "pastRow", DocRowTooLargeError],
    ["a paragraph with no paragraph style", "unstyled", "stored", TypeError],
    ["malformed named ranges in a tab the edit does not name", "stored", "misnamed", Error],
  ])("fails the approval and keeps the edit pending when the fetched document holds %s",
    inStore(async (_name, first, second, thrown) => {
      let fresh = twoTabs("r-now", first, second);
      let says = storingSays(fresh);
      let before = fallback(fresh);
      let { api, landed, unapplyable, logged, docHost } = before;

      let failure = await rejection(DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 }));
      // The class thrown, and no class made of it.
      expect(Object.getPrototypeOf(failure)).toBe(thrown.prototype);
      expect(failure).not.toBeInstanceOf(ActionApplyError);
      expect((failure as Error).message).toBe(says);
      expect(unapplyable).not.toHaveBeenCalled();
      expect(landed).not.toHaveBeenCalled();
      // The pinned batch Google refused, and none after the fetch.
      expect(api.batchUpdate).toHaveBeenCalledTimes(1);
      expect(api.getDocument).toHaveBeenCalledTimes(1);
      expect(unapplyableLines(logged)).toEqual([]);
      expectStoredAs(before);

      // The edit is still pending: approved again over a document that can be stored, it applies.
      api.getDocument.mockImplementation(async () => twoTabs("r-later", "stored", "stored"));
      await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
      expect(api.batchUpdate).toHaveBeenCalledTimes(2);
      expect(api.batchUpdate.mock.calls[1][2]).toBe("r-later");
      expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-new", tabId: "tab-1" } }]);
      expect(unapplyable).not.toHaveBeenCalled();
      expectStoredAs(before);
    }));

  it("refuses an edit that would leave a paragraph of the fetched document past a row, and sends nothing", inStore(async () => {
    // The fetched document's paragraph still fits a row; the replacement would take it past one.
    let fresh = twoTabs("r-now", "stored", "stored");
    let grown = `Draft ${"a".repeat(DOC_ROW_BYTES - 2_000)}`;
    fresh.tabs[0] = { ...buildTab([para(grown), para("Kept")]), tabId: "tab-1", title: "Main" };
    let replace: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "Draft", newMarkdown: `Final ${"b".repeat(4_000)}`,
      display: { tab: "x" },
    };
    let before = fallback(fresh);
    let { api, landed, unapplyable, docHost } = before;

    let failure = await rejection(DOC_DEFINITIONS.replaceText.apply(replace, docHost, { id: 4 }));

    expect(failure).toBeInstanceOf(ActionApplyError);
    expect((failure as Error).message).toContain("this edit is too large");
    expect(unapplyable.mock.calls).toEqual(
      [[4, replace, `Pending Google Doc edit could not be applied: ${(failure as Error).message}`]]);
    expect(landed).not.toHaveBeenCalled();
    // The pinned batch Google refused, and none after the fetch.
    expect(api.getDocument).toHaveBeenCalledTimes(1);
    expect(api.batchUpdate).toHaveBeenCalledTimes(1);
    expectStoredAs(before);
  }));

  it.each<[string, FetchedTab, FetchedTab]>([
    ["the edit's tab", "unrendered", "stored"],
    ["another tab", "stored", "unrendered"],
  ])("records the edit as unapplyable when the renderer throws on a list item of %s",
    inStore(async (_name, first, second) => {
      let says = rendererSays(FETCHED_TABS.unrendered("tab-1"));
      expect(says).not.toBe(new DocRunRenderError(undefined).message);
      let before = fallback(twoTabs("r-now", first, second));
      let { api, landed, unapplyable, logged, docHost } = before;

      let failure = await rejection(DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 }));
      expect(failure).toBeInstanceOf(ActionApplyError);
      expect((failure as Error).message).toBe(says);
      // The renderer's own throw, not the store's name for it.
      expect((failure as Error).cause).toBeInstanceOf(RangeError);
      expect((failure as Error).cause).not.toBeInstanceOf(DocRunRenderError);
      expect(unapplyable.mock.calls).toEqual(
        [[4, APPEND, `Pending Google Doc edit could not be applied: ${says}`]]);
      expect(unapplyableLines(logged)).toHaveLength(1);
      expect(unapplyableLines(logged)[0]).toMatchObject({ actionId: 4 });
      expect(landed).not.toHaveBeenCalled();
      expect(api.batchUpdate).toHaveBeenCalledTimes(1);
      expectStoredAs(before);
    }));

  it("a fault of storage while the edit's tab is read back fails the approval and not the edit", inStore(async () => {
    let refusal = new Error("storage refused the read");
    let state = { armed: false, refused: 0, used: 0 };
    let on = storage!;
    let faulty: DocStoreStorage = {
      sql: {
        exec: <T extends Record<string, SqlStorageValue>>(statement: string, ...bindings: unknown[]) => {
          if (state.armed && statement === "SELECT json FROM doc_run WHERE id = ? AND doc = ?") {
            state.refused++;
            throw refusal;
          }
          return on.sql.exec<T>(statement, ...bindings);
        },
      },
      transactionSync: run => on.transactionSync(run),
    };
    let refusing = new DocStore(faulty);
    let before = fallback(twoTabs("r-now", "stored", "stored"), () => refusing);
    let { api, landed, unapplyable, logged, docHost } = before;
    let stores = docHost.tryFetched;
    docHost.tryFetched = <T>(fetched: GoogleDocsDocument, use: (copy: DocCopy) => T): T =>
      stores(fetched, copy => {
        state.used++;
        return use(copy);
      });

    state.armed = true;
    await expect(DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 })).rejects.toBe(refusal);
    state.armed = false;
    // Storing the document read no run: the read refused is the one of the edit's tab.
    expect(state).toEqual({ armed: false, refused: 1, used: 1 });
    expect(refusal).not.toBeInstanceOf(ActionApplyError);
    expect(unapplyable).not.toHaveBeenCalled();
    expect(unapplyableLines(logged)).toEqual([]);
    expect(api.batchUpdate).toHaveBeenCalledTimes(1);
    expectStoredAs(before);

    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
    expect(api.batchUpdate).toHaveBeenCalledTimes(2);
    expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-new", tabId: "tab-1" } }]);
    expectStoredAs(before);
  }));

  it("refuses an edit the fetched document does not take as it does from the tab as Google sent it", inStore(async () => {
    let replace: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "Gone", newMarkdown: "New", display: { tab: "x" },
    };
    let fresh = twoTabs("r-now", "stored", "stored");
    let says = thrownMessage(() => materializeDocEdit(fresh.tabs, replace));
    expect(says).toContain("oldMarkdown was not found");
    let before = fallback(fresh);
    let { api, landed, unapplyable, tryFetched, logged, docHost } = before;

    let failure = await rejection(DOC_DEFINITIONS.replaceText.apply(replace, docHost, { id: 2 }));
    expect(failure).toBeInstanceOf(ActionApplyError);
    expect((failure as Error).message).toBe(says);
    expect(unapplyable.mock.calls).toEqual(
      [[2, replace, `Pending Google Doc edit could not be applied: ${says}`]]);
    expect(unapplyableLines(logged)).toHaveLength(1);
    expect(tryFetched).toHaveBeenCalledTimes(1);
    // The copy held refuses the edit too, so no batch was pinned to it.
    expect(api.batchUpdate).not.toHaveBeenCalled();
    expect(landed).not.toHaveBeenCalled();
    expectStoredAs(before);
  }));

  // The edit's own refusals stand before anything the document's content gives.
  describe.each<[string, GoogleDocEditAction, (fetched: GoogleDocsDocument) => GoogleDocsDocument]>([
    ["whose tab is gone from the fetched document", APPEND,
      fetched => ({ ...fetched, tabs: fetched.tabs.slice(1) })],
    ["queued under an earlier Markdown version that does not replay",
      { ...APPEND, markdownVersion: 5 }, fetched => fetched],
    ["that carries a stored reason",
      { ...APPEND, invalidatedReason: "Refused when it was replayed." }, fetched => fetched],
    ["that names no tab, in a document that has gained one",
      { ...APPEND, tabId: undefined }, fetched => fetched],
  ])("refuses an edit %s before it stores the fetched document", (_name, action, shaped) => {
    it.each<[string, FetchedTab]>([
      ["holds a paragraph past a row", "pastRow"],
      ["holds a list item the renderer throws on", "unrendered"],
    ])("where the document %s", inStore(async (_holding, other) => {
      let fresh = shaped(twoTabs("r-now", "stored", other));
      // The edit's own refusal, of a document of the same tabs that can be stored.
      let says = thrownMessage(
        () => materializeDocEdit(shaped(twoTabs("r-now", "stored", "stored")).tabs, action));
      let logged = vi.spyOn(console, "error").mockImplementation(() => {});
      keptSnapshot(running(), twoTabs("r-copy", "stored", "stored"), KEPT);
      let before = { rows: storedRows(storage!), head: running().head(KEPT) };
      let { api, landed, unapplyable, tryFetched, docHost } =
        host(fresh, undefined, undefined, { form, doc: KEPT });

      let failure = await rejection(docDefinition(action).apply(action, docHost, { id: 4 }));
      expect(failure).toBeInstanceOf(ActionApplyError);
      expect((failure as Error).message).toBe(says);
      expect(tryFetched).not.toHaveBeenCalled();
      // Nothing walked the document: it still holds every element of every tab.
      expect((await documentsAnswered(api)).map(elementsOf)).toEqual([elementsOf(fresh)]);
      expect(unapplyable.mock.calls).toEqual(
        [[4, action, `Pending Google Doc edit could not be applied: ${says}`]]);
      expect(unapplyableLines(logged)).toHaveLength(1);
      expect(landed).not.toHaveBeenCalled();
      expect(api.batchUpdate).not.toHaveBeenCalled();
      expectStoredAs(before);
    }));
  });

  it("refuses an edit whose tab is gone with the text that names the tab", () => {
    expect(thrownMessage(() => materializeDocEdit(twoTabs("r", "stored", "stored").tabs.slice(1), APPEND)))
      .toBe("appendText: no tab with ID \"tab-1\" exists in this document. Call listTabs() to refresh the tab list.");
  });

  /** No run ends by its size: each holds two elements. */
  const PAIRS: RunSizes = { least: Infinity, target: Infinity, most: Infinity, elements: 2 };
  const TABLE_TAB = (): GoogleDocsTab =>
    ({ ...buildTab([para("Before"), grid(["Name", "Role"], ["Ada", "Engineer"]), para("After")]), tabId: "tab-1" });
  /** The stored edit `edit` of `tab-1`. */
  const storedEdit = (edit: DocEdit): GoogleDocEditAction =>
    ({ ...BASE, ...edit, display: { tab: "x" } }) as GoogleDocEditAction;

  it.each<[string, () => GoogleDocsTab, (tab: GoogleDocsTab) => GoogleDocEditAction, RunSizes | undefined]>([
    // Footnote references out of place: the model cannot follow the tab, which the fallback never
    // asks.
    ["a replacement in a tab the model cannot follow",
      () => ({ ...buildTab([{ runs: ["Draft", footnote(2), " then", footnote(1), ".\n"] }, para("Kept")]), tabId: "tab-1" }),
      () => storedEdit({ type: "replaceText", oldMarkdown: "Kept", newMarkdown: "Held" }), undefined],
    ["an append to a tab the model cannot follow",
      () => ({ ...buildTab([{ runs: ["Draft", footnote(2), " then", footnote(1), ".\n"] }, para("Kept")]), tabId: "tab-1" }),
      () => APPEND, undefined],
    ["a replacement in a cell of a table", TABLE_TAB,
      () => storedEdit({ type: "replaceText", oldMarkdown: "<p>Ada</p>", newMarkdown: "<p>Grace</p>", inTable: true }),
      undefined],
    ["rows inserted in a table", TABLE_TAB,
      tab => storedEdit(prepareTableChange(running(), versionOf(tab), {
        method: "insertTableRows", lines: { table: 0, at: 1, cells: [["Lin", "Designer"]] },
      }, "x").change), undefined],
    ["a replacement in the last run of a tab of several runs",
      () => ({ ...buildTab(Array.from({ length: 9 }, (_, at) => para(`Line ${at}`))), tabId: "tab-1" }),
      () => storedEdit({ type: "replaceText", oldMarkdown: "Line 8", newMarkdown: "The last line" }), PAIRS],
  ])("builds from the copy what the tab as Google sent it builds: %s", inStore(async (name, tabOf, edit, sizes) => {
    let fresh: GoogleDocsDocument = {
      documentId: "doc-1", title: "Plan", revisionId: "r-now",
      tabs: [{ ...tabOf(), title: "Main" }, { ...FETCHED_TABS.stored("tab-2"), title: "Other", index: 1 }],
    };
    let action = edit(fresh.tabs[0]);
    let sent = materializeDocEdit(fresh.tabs, action);
    expect(sent.requests.length).toBeGreaterThan(0);
    let cutting = sizes ? new DocStore(storage!, undefined, undefined, sizes) : running();
    // The fetched tab as the store holds it: what the model can follow of it, and its runs.
    let reference = cutting.keep("reference", cutting.fetched(structuredClone(fresh), 0), NONE);
    let stored = storedDocCopy(cutting, "reference", reference).tab("tab-1")!;
    expect(cutting.unindexed(stored)).toBe(name.includes("cannot follow"));
    let counted = docStoreCost.runsDecoded;
    cutting.tab(stored);
    // Under forced sizes the tab is put together from more than one row.
    if (sizes) expect(docStoreCost.runsDecoded - counted).toBeGreaterThan(1);

    let { api, landed, docHost } = host(fresh, undefined, undefined, { form, store: () => cutting });
    await docDefinition(action).apply(action, docHost, { id: 4 });
    expect(api.batchUpdate).toHaveBeenCalledTimes(1);
    let [[, requests, revision, marker]] = api.batchUpdate.mock.calls;
    expect(requests).toEqual(sent.requests);
    expect(revision).toBe("r-now");
    expect(marker).toMatchObject({ rangeStart: sent.tab.bodyEndIndex - 1, tabId: sent.tab.tabId });
    expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-new", tabId: "tab-1" } }]);
  }));

});

// A fallback stores and removes its fetched document in one synchronous stretch: another fetch
// not yet kept is kept as if no approval came between. Rows are compared with and without it.
describe("a fallback while another fetch of the document waits to be kept", () => {
  const T = Date.UTC(2026, 0, 1);
  /** The document the waiting fetch brought: another state than the fallback's. */
  const brought = (): GoogleDocsDocument => {
    let state = twoTabs("r-brought", "stored", "stored");
    state.tabs[0] = { ...buildTab([para("Brought"), para("Kept")]), tabId: "tab-1", title: "Main" };
    return state;
  };
  /** The Markdown of `tab-1` in `copy`. */
  const mainOf = (copy: DocCopy): string => copy.markdown(copy.tab("tab-1")!).trim();

  /** Approves an append over `made`'s document `doc` in `form`, where the approval fetches `fresh`. */
  async function approveOver(
    made: DocStore, doc: string, form: Form, other: FetchedTab,
  ): Promise<void> {
    let { api, landed, unapplyable, docHost } =
      host(twoTabs("r-fallback", "stored", other), undefined, undefined, { form, doc, store: () => made });
    let applied = DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
    if (other === "pastRow") {
      // The edit stays pending.
      await expect(applied).rejects.toBeInstanceOf(DocRowTooLargeError);
      expect(api.batchUpdate).not.toHaveBeenCalled();
      expect(landed).not.toHaveBeenCalled();
    } else {
      await applied;
      expect(api.batchUpdate).toHaveBeenCalledTimes(1);
      expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-new", tabId: "tab-1" } }]);
    }
    expect(unapplyable).not.toHaveBeenCalled();
  }

  const FALLBACKS: [string, FetchedTab][] = [
    ["cannot be stored, so the approval fails", "pastRow"],
    ["is stored, and its batch sent", "stored"],
  ];

  it.each(FALLBACKS)(
    "leaves a fetch of the bound copy in flight to keep its document, where the fallback's %s",
    async (_name, other) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T);
      const sequence = (approve: boolean) => withDocStore(async (made, on) => {
        let answer: ((state: GoogleDocsDocument) => void) | undefined;
        let asked: () => void = () => {};
        let fetching = new Promise<void>(resolve => { asked = resolve; });
        let copy = new StoredDocCopy({
          store: made, doc: "doc", storage: on, ttlMs: DOC_SNAPSHOT_TTL_MS,
          fetch: () => new Promise(resolve => {
            answer = resolve;
            asked();
          }),
          pending: () => NONE,
        });
        let reading = copy.current();
        // The fetch is out, and nothing of the document is stored.
        await fetching;
        expect(made.head("doc")).toBeUndefined();
        if (approve) await approveOver(made, "doc", FORMS[0], other);
        expect(made.head("doc")).toBeUndefined();

        answer!(brought());
        let held = await reading;
        expect(held.revision).toBe("r-brought");
        expect(mainOf(held.copy)).toBe("Brought\n\nKept");
        expect(made.head("doc")).toMatchObject({ revision: "r-brought", stale: false });
        return storedRows(on);
      });
      expect(await sequence(true)).toBe(await sequence(false));
    });

  it.each(FALLBACKS)(
    "leaves a Drive read's document to be kept, between its trial and its keep, where the fallback's %s",
    async (_name, other) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T);
      const sequence = (approve: boolean) => withDocStore(async (made, on) => {
        let docsApi = { getDocument: async () => brought() } as unknown as GoogleDocsApi;
        let source = driveDocSource(docsApi, {} as DriveApi, "doc-1", driveDocCopies(() => made, "file"), {
          writes: () => 0, newestQueued: () => 0, revisionMoves: () => 0,
        });
        // The document is held, and read in a trial that keeps nothing.
        let snapshot = await source.snapshot();
        expect(source.read(snapshot, taken => mainOf(taken.copy))).toBe("Brought\n\nKept");
        expect(made.head("file")).toBeUndefined();
        if (approve) await approveOver(made, "file", FORMS[1], other);
        expect(made.head("file")).toBeUndefined();

        source.approved(snapshot);
        expect(made.head("file")).toMatchObject({ revision: "r-brought", stale: false });
        expect(snapshot.copy.held()).toBe(true);
        expect(source.read(snapshot, taken => mainOf(taken.copy))).toBe("Brought\n\nKept");
        return storedRows(on);
      });
      expect(await sequence(true)).toBe(await sequence(false));
    });
});

// The copy held and a fresh read build the same batch

const GENERATED_LISTS: GoogleDocsTab["lists"] = {
  bullets: { listProperties: { nestingLevels: presetLevels() } },
  numbers: { listProperties: { nestingLevels: presetLevels(true) } },
};

/** A run's style in an explicit font: bold, which the builders name, beside fields the copy drops. */
const EXPLICIT_FONT = {
  bold: true, smallCaps: true,
  weightedFontFamily: { fontFamily: "Lora", weight: 700 },
  backgroundColor: { color: { rgbColor: { red: 1, green: 0.9, blue: 0.6 } } },
};

/** A tab of a generated document, with the words its generators name. */
type GeneratedTab = {
  tab: GoogleDocsTab;
  /** The word of the paragraph whose run is in an explicit font. */
  fonted: string;
  /** The word of each paragraph outside the tables, the items of its lists among them. */
  paragraphs: string[];
  /** The words of the paragraphs that are no item of a list. */
  prose: string[];
  /** The tables no cell of which is merged: the index among the tab's tables, and the cells' words. */
  tables: { at: number; cells: string[][] }[];
};

/** A generated document as Google returns it. Every word in it is there once. */
type Generated = {
  document: GoogleDocsDocument;
  /** The tabs that hold text. The first one's first table has a merged region at its first cell. */
  tabs: GeneratedTab[];
  blank: GoogleDocsTab;
  /** A word the document does not hold. */
  word: () => string;
  /** The stored edit `edit` of `tab`, under a write id of its own. */
  stored: (tab: GoogleDocsTab, edit: DocEdit) => GoogleDocEditAction;
};

/**
 * A document of one or two tabs of text and a blank one, drawn from `dice`: prose, a heading,
 * lists, tables, a merged region, and named ranges the copy does not keep.
 */
function generatedDocument(dice: Dice, seed: number): Generated {
  let fresh = 0;
  let writes = 0;
  let tabs = Array.from({ length: 1 + dice.below(2) }, (_, index): GeneratedTab => {
    let count = 0;
    let word = () => `${"ab"[index]}w${String(count++).padStart(3, "0")}`;
    let paragraphs: string[] = [];
    let prose: string[] = [];
    let outside = (words = prose) => {
      let text = word();
      paragraphs.push(text);
      if (words === prose) prose.push(text);
      return text;
    };
    let listed = (listId: string) => ({ runs: [`${outside([])}\n`], bullet: { listId } });
    let tables: GeneratedTab["tables"] = [];
    let fonted = word();
    let blocks: BlockSpec[] = [
      para(outside()), listed("bullets"), listed("bullets"),
      { runs: [`${outside()}\n`], namedStyleType: "HEADING_2" },
      { runs: [{ text: `${fonted}\n`, style: EXPLICIT_FONT }] },
    ];
    let table = (plain: boolean) => {
      let columns = 2 + dice.below(2);
      let cells = Array.from({ length: 2 + dice.below(3) }, () => Array.from({ length: columns }, word));
      if (plain) tables.push({ at: blocks.filter(block => "table" in block).length, cells });
      blocks.push(grid(...cells), para(outside()));
    };
    // The first tab's first table is the one a region is merged in.
    if (index === 0) table(false);
    blocks.push(listed("numbers"), listed("numbers"), para(outside()));
    for (let more = 1 + dice.below(2); more > 0; more--) table(true);
    let tab: GoogleDocsTab = {
      ...buildTab(blocks, GENERATED_LISTS), tabId: `tab-${index + 1}`, title: `Tab ${index + 1}`, index,
    };
    if (index === 0) {
      tab = {
        ...applyDocEdit(tab, prepareTableChange(running(), versionOf(tab), {
          method: "mergeTableCells", cells: { table: 0, row: 0, column: 0, rows: 1, columns: 2 },
        }, "x").change),
        namedRanges: {
          "someone's": { namedRanges: [{ namedRangeId: "range.1", name: "someone's" }] },
          "gadgets-write-earlier": {
            namedRanges: [{ namedRangeId: "range.2", name: "gadgets-write-earlier" }],
          },
        },
      };
    }
    return { tab, fonted, paragraphs, prose, tables };
  });
  let blank = { ...blankDocsTab("tab-blank", "Blank"), index: tabs.length };
  return {
    document: {
      documentId: "doc-1", title: "Plan", revisionId: `revision-${seed}`,
      tabs: [...tabs.map(({ tab }) => tab), blank],
    },
    tabs, blank,
    word: () => `nw${String(fresh++).padStart(3, "0")}`,
    stored: (tab, edit) => ({ ...BASE, tabId: tab.tabId, writeId: `w-${seed}-${writes++}`, ...edit }),
  };
}

/** A tab of `generated` and one of its tables that has no merged cell. */
function drawnTable(dice: Dice, generated: Generated) {
  let { tab, tables } = dice.pick(generated.tabs);
  let { at, cells } = dice.pick(tables);
  return { tab, at, cells, row: dice.below(cells.length), column: dice.below(cells[0].length) };
}

/** The stored change `call` makes to a table of `tab`, recording the table as the tab has it. */
const tableChangeOf = (generated: Generated, tab: GoogleDocsTab, call: TableCall) =>
  generated.stored(tab, prepareTableChange(running(), versionOf(tab), call, "x").change);

/** The edits compared for each kind: a kind added to `DocEdit` fails the type check until it has one. */
const EDITS = {
  replaceText(dice, generated) {
    let outside = dice.pick(generated.tabs);
    let { tab, cells, row, column } = drawnTable(dice, generated);
    let cell = `<p>${cells[row][column]}</p>`;
    let replacement = `<p>${generated.word()}</p>`;
    expect(prepareTextReplacement(
      running(), versionOf(tab), cell, replacement, "x", googleDocDisplayLimit("replaceText")).inTable).toBe(true);
    return [
      generated.stored(outside.tab, {
        type: "replaceText", oldMarkdown: dice.pick(outside.paragraphs), newMarkdown: generated.word(),
      }),
      generated.stored(tab, {
        type: "replaceText", oldMarkdown: cell, newMarkdown: replacement, inTable: true,
      }),
      // Inside the run in an explicit font, whose style the text written takes.
      generated.stored(outside.tab, {
        type: "replaceText", oldMarkdown: outside.fonted, newMarkdown: generated.word(),
      }),
    ];
  },
  appendText: (dice, generated) => [
    generated.stored(dice.pick(generated.tabs).tab, {
      type: "appendText", markdown: `${dice.pick(["", "- ", "1. "])}${generated.word()}`,
    }),
    generated.stored(generated.blank, { type: "appendText", markdown: generated.word() }),
  ],
  insertTable(dice, generated) {
    let { tab, prose } = dice.pick(generated.tabs);
    return [tableChangeOf(generated, tab, {
      method: "insertTable",
      table: {
        rows: 1 + dice.below(2), columns: 2, cells: [[generated.word(), generated.word()]],
        ...(dice.random() < 0.5 ? { after: dice.pick(prose) } : {}),
      },
    })];
  },
  insertTableRows(dice, generated) {
    let { tab, at, cells } = drawnTable(dice, generated);
    return [tableChangeOf(generated, tab, {
      method: "insertTableRows",
      lines: { table: at, at: dice.below(cells.length + 1), cells: [cells[0].map(generated.word)] },
    })];
  },
  insertTableColumns(dice, generated) {
    let { tab, at, cells } = drawnTable(dice, generated);
    return [tableChangeOf(generated, tab, {
      method: "insertTableColumns",
      lines: {
        table: at, at: dice.below(cells[0].length + 1), cells: cells.map(() => [generated.word()]),
      },
    })];
  },
  deleteTableRows(dice, generated) {
    let { tab, at, row } = drawnTable(dice, generated);
    return [tableChangeOf(generated, tab, { method: "deleteTableRows", lines: { table: at, at: row } })];
  },
  deleteTableColumns(dice, generated) {
    let { tab, at, column } = drawnTable(dice, generated);
    return [tableChangeOf(
      generated, tab, { method: "deleteTableColumns", lines: { table: at, at: column } })];
  },
  deleteTable(dice, generated) {
    let { tab, at } = drawnTable(dice, generated);
    return [tableChangeOf(generated, tab, { method: "deleteTable", table: at })];
  },
  mergeTableCells(dice, generated) {
    let { tab, at, cells } = drawnTable(dice, generated);
    let across = dice.random() < 0.5;
    return [tableChangeOf(generated, tab, {
      method: "mergeTableCells",
      cells: across
        ? { table: at, row: dice.below(cells.length), column: dice.below(cells[0].length - 1), rows: 1, columns: 2 }
        : { table: at, row: dice.below(cells.length - 1), column: dice.below(cells[0].length), rows: 2, columns: 1 },
    })];
  },
  // The region merged in the first tab's first table.
  unmergeTableCells: (_dice, generated) => [tableChangeOf(generated, generated.tabs[0].tab, {
    method: "unmergeTableCells", cell: { table: 0, row: 0, column: 0 },
  })],
  setTableCellStyle(dice, generated) {
    let { tab, at, row, column } = drawnTable(dice, generated);
    return [tableChangeOf(generated, tab, {
      method: "setTableCellStyle",
      cells: { table: at, row, column, style: { background: `#${String(100000 + dice.below(899999))}` } },
    })];
  },
  setTableColumnWidths(dice, generated) {
    let { tab, at, column } = drawnTable(dice, generated);
    return [tableChangeOf(generated, tab, {
      method: "setTableColumnWidths", columns: { table: at, at: column, width: 40 + dice.below(100) },
    })];
  },
  setTableRowHeights(dice, generated) {
    let { tab, at, row } = drawnTable(dice, generated);
    return [tableChangeOf(generated, tab, {
      method: "setTableRowHeights", rows: { table: at, at: row, height: 20 + dice.below(40) },
    })];
  },
} satisfies Record<DocEdit["type"], (dice: Dice, generated: Generated) => GoogleDocEditAction[]>;

type BatchCall = Parameters<GoogleDocsApi["batchUpdate"]>;

/** The batch `call` sends as Google reads it: each style cut to its mask, the rest `unread`. */
function asGoogleReads([documentId, requests, ...pinAndMarker]: BatchCall) {
  let unread: string[] = [];
  let read = requests.map(request => {
    if (!("updateTextStyle" in request)) return request;
    let { textStyle, fields } = request.updateTextStyle;
    let named = fields.split(",");
    let set = Object.entries(textStyle).filter(([field]) => {
      if (!named.includes(field)) unread.push(field);
      return named.includes(field);
    });
    return { updateTextStyle: { ...request.updateTextStyle, textStyle: Object.fromEntries(set) } };
  });
  return { call: [documentId, read, ...pinAndMarker], unread };
}

// A batch built from the copy is the one built from the tab as Google sent it, as Google reads
// it: a text style carries only part of the run's style, but every field its mask names.
describe("a Doc edit built from the copy held and from a fresh read", () => {
  /** One seed by default, two in the wider run. */
  const SEEDS = WIDER ? [1, 2] : [1];
  /** How many edits of each kind were compared. */
  const compared = new Map<string, number>();
  /** The style fields the tab as Google sent it gives a batch, unread, that the copy's lacks. */
  const dropped = new Set<string>();

  it.each(SEEDS)("is the same batch, pinned to the same revision (seed %i)", inStore(async seed => {
    let dice = diceOf(seed);
    let generated = generatedDocument(dice, seed);
    for (let [kind, edits] of Object.entries(EDITS)) {
      for (let action of edits(dice, generated)) {
        let fresh = host(generated.document);
        let copy = host(generated.document, undefined, snapshotOf(generated.document));
        // An edit refused or changing nothing is a generator defect: it fails, never skipped.
        await docDefinition(action).apply(action, fresh.docHost, { id: 4 });
        await docDefinition(action).apply(action, copy.docHost, { id: 4 });
        expect(fresh.api.batchUpdate, kind).toHaveBeenCalledTimes(1);
        expect(copy.api.getDocument, kind).not.toHaveBeenCalled();
        expect(copy.api.batchUpdate, kind).toHaveBeenCalledTimes(1);
        let fromFresh = asGoogleReads(fresh.api.batchUpdate.mock.calls[0]);
        let fromCopy = asGoogleReads(copy.api.batchUpdate.mock.calls[0]);
        // The document, the requests, the revision and the marker's name, place and tab.
        expect(fromCopy.call, kind).toStrictEqual(fromFresh.call);
        // What the tab as Google sent it builds, which no approval sends.
        let sent = materializeDocEdit(generated.document.tabs, action);
        let [documentId, , ...pinAndMarker] = fresh.api.batchUpdate.mock.calls[0];
        let fromSent = asGoogleReads([documentId, sent.requests, ...pinAndMarker]);
        expect(fromFresh.call, kind).toStrictEqual(fromSent.call);
        expect(pinAndMarker[1], kind).toMatchObject(
          { rangeStart: sent.tab.bodyEndIndex - 1, tabId: sent.tab.tabId });
        for (let field of fromSent.unread) if (!fromCopy.unread.includes(field)) dropped.add(field);
        // No batch built from the copy leaves unpinned.
        let [, , pin] = copy.api.batchUpdate.mock.calls[0];
        expect(pin, kind).toBe(`revision-${seed}`);
        expect(landings(copy.landed), kind).toEqual(landings(fresh.landed));
        compared.set(kind, (compared.get(kind) ?? 0) + 1);
      }
    }
  }));

  it("compared every kind", () => {
    for (let kind of Object.keys(EDITS)) {
      expect(compared.get(kind) ?? 0, kind).toBeGreaterThanOrEqual(SEEDS.length);
    }
  });

  it("differs from what the tab as Google sent it builds only in style fields no mask names", () => {
    expect(dropped).toEqual(new Set(["backgroundColor", "smallCaps", "weightedFontFamily"]));
  });
});

/** A queue over `pending` that marks a refused record as a bound Doc's store does. */
function queueOf(pending: GoogleDocPendingAction[]): GoogleDocReplayQueue {
  return {
    pending: () => pending,
    invalidate: (record, reason) => { record.action.invalidatedReason = reason; },
  };
}

/** The add of a tab titled "Notes" under `provisionalTabId`, placed by `placement`. */
function add(provisionalTabId: string, placement: { parentTabId?: string; index?: number }): AddTab {
  return {
    submittedAt: 0, writeId: `w-${provisionalTabId}`, type: "addTab", provisionalTabId,
    title: "Notes", ...placement,
  };
}

/** An append of `markdown` to tab `tabId`. */
function appendTo(tabId: string, markdown: string): Append {
  return { ...APPEND, tabId, markdown };
}

/** A replacement in tab `tabId` of text no fixture holds, which a replay refuses. */
function goneIn(tabId: string): Replace {
  return {
    ...BASE, tabId, type: "replaceText", oldMarkdown: "Gone", newMarkdown: "Back",
    display: { tab: `"Main" (${tabId})` },
  };
}

/** `action` naming no tab, as a record stored before tabs could be named. */
function unnamed<T extends { tabId?: string }>(action: T): T {
  let { tabId: _, ...rest } = action;
  return rest as T;
}

/** The reason a replay stores with an edit it dropped for `refusal`. */
const dropped = (refusal: string) =>
  `${REPLAY_CONTEXT}: ${refusal} This edit was dropped from the document. ` +
  "Reject it and retry if it is still needed.";

const EARLIER_FORMAT =
  "Pending Google Doc edit was queued under an earlier Markdown format and may no longer " +
  "apply as previewed. Reject it and retry.";
const PREDATES_TABS =
  "Pending Google Doc edit predates tab support and the document has gained tabs since, so " +
  "the tab it was approved against is unknown. Reject it and retry on a selected tab.";

/** A document of the tabs `contents` lists, `tab-1` onwards, at the top level. */
function documentOf(...contents: BlockSpec[][]): GoogleDocsDocument {
  return {
    documentId: "doc-1", title: "Plan", revisionId: "r1",
    tabs: contents.map((blocks, index) => ({
      ...buildTab(blocks), tabId: `tab-${index + 1}`, title: `Tab ${index + 1}`, index,
    })),
  };
}

/** How a queue invalidates: in the record in hand (a bound Doc), or by removing it (Drive). */
type Invalidator = "marks the record" | "removes the record";
const INVALIDATORS: Invalidator[] = ["marks the record", "removes the record"];

/**
 * A queue over `pending` with its reasons by record; both forms throw for a record invalidated
 * twice, as a journal does.
 */
function countedQueue(
  pending: GoogleDocPendingAction[], invalidator: Invalidator = "marks the record",
) {
  let list = [...pending];
  let reasons = new Map<number, string>();
  let queue: GoogleDocReplayQueue = {
    pending: () => [...list],
    invalidate(record, reason) {
      if (reasons.has(record.id)) throw new Error(`Edit ${record.id} was invalidated twice`);
      reasons.set(record.id, reason);
      if (invalidator === "marks the record") record.action.invalidatedReason = reason;
      else list = list.filter(({ id }) => id !== record.id);
    },
  };
  return {
    queue, reasons,
    /** The ids still listed. */
    listed: () => list.map(({ id }) => id),
    /** Removes records from outside the replay, as an approval or a rejection does. */
    remove: (...ids: number[]) => { list = list.filter(({ id }) => !ids.includes(id)); },
    push: (record: GoogleDocPendingAction) => { list.push(record); },
  };
}

/** What `run` adds to the reducer steps and the queue reads counted. */
function spending<T>(run: () => T): { value: T; folds: number; queueReads: number } {
  let before = { ...replayCost };
  let value = run();
  return {
    value, folds: replayCost.folds - before.folds,
    queueReads: replayCost.queueReads - before.queueReads,
  };
}

/** `copy` with its tab reads counted. */
function watched(copy: DocCopy) {
  let read: string[] = [];
  let watching: DocCopy = { ...copy, tab: tabId => (read.push(tabId), copy.tab(tabId)) };
  return { copy: watching, read };
}

const TABLE: BlockSpec[] = [para("Before"), grid(["a", "b"], ["c", "d"]), para("After")];
/** The identity of the one table of `TABLE`, as a change to it records it. */
const TABLE_IDENTITY = tableIdentity(tableAt(docTabToMarkdown(buildTab(TABLE)), 0));
const STALE_IDENTITY = tableIdentity(docTabToMarkdown(buildTab([grid(["gone"])])).markdown.trim());

/** A table change of tab `tabId`: rows added to, or deleted from, the table that reads `expected`. */
function tableChange(
  tabId: string, type: "insertTableRows" | "deleteTableRows", expected = TABLE_IDENTITY,
): GoogleDocAction {
  return type === "insertTableRows"
    ? { ...BASE, tabId, type, at: 1, cells: [["x", "y"]], expected }
    : { ...BASE, tabId, type, at: 0, count: 1, expected };
}

describe("a Doc's pending actions replayed on a copy of it", () => {
  it("puts a queued tab where Google will, under its provisional ID, and replays edits into it", inStore(() => {
    let { copy } = snapshotOf(document("Draft"));
    let pending = [
      { id: 1, action: add("pending-tab-a", { index: 0 }) },
      { id: 2, action: appendTo("pending-tab-a", "First words") },
      { id: 3, action: add("pending-tab-b", { parentTabId: "pending-tab-a" }) },
    ];
    let replay = replayGoogleDoc(queueOf(pending), copy, REPLAY_CONTEXT);

    // The document's order, the new tab before the tab it displaced and its child after it.
    expect(replay.outline.map(({ tabId, index, nestingLevel, parentTabId }) =>
      ({ tabId, index, nestingLevel, parentTabId }))).toEqual([
      { tabId: "pending-tab-a", index: 0, nestingLevel: 0, parentTabId: undefined },
      { tabId: "pending-tab-b", index: 0, nestingLevel: 1, parentTabId: "pending-tab-a" },
      { tabId: "tab-1", index: 1, nestingLevel: 0, parentTabId: undefined },
    ]);
    expect(markdownIn(replay.tab("pending-tab-a"))).toBe("First words\n");
    expect(markdownIn(replay.tab("tab-1"))).toBe("Draft\n");
    expect(pending.map(({ action }) => action.invalidatedReason)).toEqual([undefined, undefined, undefined]);
    // The copy is never changed: its one tab stays where it was fetched.
    expect(copy.outline.map(({ tabId, index }) => ({ tabId, index }))).toEqual([{ tabId: "tab-1", index: 0 }]);
  }));

  it("refuses an add whose parent is gone, and the edit queued for its tab with it", inStore(() => {
    let { copy } = snapshotOf(document("Draft"));
    let pending = [
      { id: 1, action: add("pending-tab-a", { parentTabId: "gone" }) },
      { id: 2, action: appendTo("pending-tab-a", "First words") },
      { id: 3, action: appendTo("tab-1", "More") },
    ];
    let replay = replayGoogleDoc(queueOf(pending), copy, REPLAY_CONTEXT);

    // Both are refused by the replay itself, before any tab is asked for.
    expect(pending[0].action.invalidatedReason).toBe(
      `${REPLAY_CONTEXT}: addTab: no tab with ID "gone" exists in this document. Call listTabs() ` +
      "to refresh the tab list. This edit was dropped from the document. Reject it and retry if " +
      "it is still needed.");
    expect(pending[1].action.invalidatedReason).toContain(
      `${REPLAY_CONTEXT}: appendText: no tab with ID "pending-tab-a" exists in this document.`);
    expect(replay.outline.map(({ tabId }) => tabId)).toEqual(["tab-1"]);
    expect(markdownIn(replay.tab("tab-1"))).toBe("Draft\n\nMore\n");
    expect(pending[2].action.invalidatedReason).toBeUndefined();
  }));

  it("keeps replaying an add whose write marker the copy holds, and skips such an edit", inStore(() => {
    let marked = document("Draft");
    marked.tabs[0].namedRanges = Object.fromEntries(["w-pending-tab-a", "w-1"].map(writeId => [
      `gadgets-write-${writeId}`,
      { namedRanges: [{ namedRangeId: `marker-${writeId}`, name: `gadgets-write-${writeId}` }] },
    ]));
    let { copy } = snapshotOf(marked);
    let pending = [
      // Only its approval can tell the add's reply was lost, so it stays a tab of the replay.
      { id: 1, action: add("pending-tab-a", {}) },
      // The tab already holds this append, which a replay would show twice.
      { id: 2, action: appendTo("tab-1", "Draft") },
      { id: 3, action: { ...appendTo("tab-1", "More"), writeId: "w-3" } },
    ];
    let replay = replayGoogleDoc(queueOf(pending), copy, REPLAY_CONTEXT);

    expect(replay.outline.map(({ tabId }) => tabId)).toEqual(["tab-1", "pending-tab-a"]);
    expect(markdownIn(replay.tab("tab-1"))).toBe("Draft\n\nMore\n");
    expect(running().tab(replay.tab("pending-tab-a")!))
      .toEqual(asStored(pruneTab(blankDocsTab("pending-tab-a", "Notes"))));
    expect(pending.map(({ action }) => action.invalidatedReason)).toEqual([undefined, undefined, undefined]);
  }));

  it("counts one read of the queue for a replay, whatever it drops", inStore(() => {
    let { copy } = snapshotOf(document("Draft"));
    /** What replaying `actions` over the copy, every tab read, adds to the counts. */
    let spent = (...actions: GoogleDocAction[]) => {
      let pending = actions.map((action, index) => ({ id: index + 1, action }));
      let before = { ...replayCost };
      let replay = replayGoogleDoc(queueOf(pending), copy, REPLAY_CONTEXT);
      for (let { tabId } of replay.outline) replay.tab(tabId);
      return {
        queueReads: replayCost.queueReads - before.queueReads,
        folds: replayCost.folds - before.folds,
        dropped: pending.filter(({ action }) => action.invalidatedReason).map(({ id }) => id),
      };
    };

    expect(spent(appendTo("tab-1", "More"), appendTo("tab-1", "Again")))
      .toEqual({ queueReads: 1, folds: 2, dropped: [] });
    // The tab's fold drops the edit and goes on: each record is a step once.
    expect(spent(goneIn("tab-1"), appendTo("tab-1", "More")))
      .toEqual({ queueReads: 1, folds: 2, dropped: [1] });
    // An add is a tree step, and one more where its tab is made; an edit of a missing tab is one.
    expect(spent(add("pending-tab-a", { parentTabId: "gone" }), appendTo("ghost", "More")))
      .toEqual({ queueReads: 1, folds: 2, dropped: [1, 2] });
    expect(spent(add("pending-tab-a", {}), { ...add("pending-tab-b", {}), invalidatedReason: "Stale." }))
      .toEqual({ queueReads: 1, folds: 2, dropped: [2] });
  }));
});

describe("replaying a Doc's queue one tab at a time", () => {
  const two = () => snapshotOf(documentOf([para("Draft")], [para("Other")])).copy;
  const markdownOf = (replay: GoogleDocReplay, tabId: string) => markdownIn(replay.tab(tabId));

  it("folds only the records of the tab that is read", inStore(() => {
    let { copy, read } = watched(two());
    let { queue } = countedQueue([
      { id: 1, action: appendTo("tab-1", "More") },
      { id: 2, action: appendTo("tab-2", "Else") },
      { id: 3, action: appendTo("tab-1", "Again") },
    ]);
    let made = spending(() => replayGoogleDoc(queue, copy, REPLAY_CONTEXT));
    expect(made).toMatchObject({ folds: 0, queueReads: 1 });
    expect(read).toEqual([]);

    let first = spending(() => markdownOf(made.value, "tab-1"));
    expect(first).toEqual({ value: "Draft\n\nMore\n\nAgain\n", folds: 2, queueReads: 0 });
    expect(read).toEqual(["tab-1"]);
    expect(spending(() => markdownOf(made.value, "tab-2")))
      .toEqual({ value: "Other\n\nElse\n", folds: 1, queueReads: 0 });
  }));

  it("leaves an edit the replay dropped out of the next replay", inStore(() => {
    let copy = two();
    let pending = [{ id: 1, action: goneIn("tab-1") }, { id: 2, action: appendTo("tab-1", "More") }];
    let { queue, reasons } = countedQueue(pending);
    let first = spending(() => markdownOf(replayGoogleDoc(queue, copy, REPLAY_CONTEXT), "tab-1"));
    expect(first).toEqual({ value: "Draft\n\nMore\n", folds: 2, queueReads: 1 });
    expect([...reasons.keys()]).toEqual([1]);
    expect(pending[0].action.invalidatedReason).toBe(dropped(
      'replaceText: oldMarkdown was not found in the current simulated tab "tab-1". ' +
      'Make sure the text exactly matches content returned by getContent("tab-1").'));

    // The dropped edit carries its reason; the next replay folds the edit that remains.
    expect(spending(() => markdownOf(replayGoogleDoc(queue, copy, REPLAY_CONTEXT), "tab-1")))
      .toEqual({ value: "Draft\n\nMore\n", folds: 1, queueReads: 1 });
  }));

  it("folds a tab's own edits, whatever became of another tab's", inStore(() => {
    let copy = two();
    let { queue, remove } = countedQueue([
      { id: 1, action: appendTo("tab-1", "More") },
      { id: 2, action: goneIn("tab-2") },
      { id: 3, action: appendTo("tab-2", "Else") },
      { id: 4, action: appendTo("tab-2", "Last") },
    ]);
    let first = replayGoogleDoc(queue, copy, REPLAY_CONTEXT);
    expect(spending(() => [markdownOf(first, "tab-1"), markdownOf(first, "tab-2")]))
      .toMatchObject({ value: ["Draft\n\nMore\n", "Other\n\nElse\n\nLast\n"], folds: 4 });

    // Edit 2 was dropped from the second tab.
    let after = replayGoogleDoc(queue, copy, REPLAY_CONTEXT);
    expect(spending(() => markdownOf(after, "tab-1")).folds).toBe(1);

    // An edit of the second tab is settled: each tab folds what is left of its own queue.
    remove(3);
    let removed = replayGoogleDoc(queue, copy, REPLAY_CONTEXT);
    expect(spending(() => markdownOf(removed, "tab-1")).folds).toBe(1);
    expect(spending(() => markdownOf(removed, "tab-2")))
      .toMatchObject({ value: "Other\n\nLast\n", folds: 1 });
  }));

  it("leaves a dropped edit out of the next replay when it is removed from the queue instead of marked", inStore(() => {
    let copy = two();
    let pending = [{ id: 1, action: goneIn("tab-1") }, { id: 2, action: appendTo("tab-1", "More") }];
    let { queue, reasons, listed } = countedQueue(pending, "removes the record");
    expect(spending(() => markdownOf(replayGoogleDoc(queue, copy, REPLAY_CONTEXT), "tab-1")))
      .toEqual({ value: "Draft\n\nMore\n", folds: 2, queueReads: 1 });
    expect([...reasons.keys()]).toEqual([1]);
    expect(listed()).toEqual([2]);
    expect(pending[0].action.invalidatedReason).toBeUndefined();

    expect(spending(() => markdownOf(replayGoogleDoc(queue, copy, REPLAY_CONTEXT), "tab-1")))
      .toEqual({ value: "Draft\n\nMore\n", folds: 1, queueReads: 1 });
  }));

  it("marks an edit that names a tab the document does not hold, reading no tab", inStore(() => {
    let { copy, read } = watched(two());
    let pending = [
      { id: 1, action: appendTo("ghost", "More") },
      { id: 2, action: appendTo("tab-1", "More") },
    ];
    let replay = replayGoogleDoc(countedQueue(pending).queue, copy, REPLAY_CONTEXT);
    expect(pending[0].action.invalidatedReason).toBe(dropped(
      'appendText: no tab with ID "ghost" exists in this document. ' +
      "Call listTabs() to refresh the tab list."));
    expect(pending[1].action.invalidatedReason).toBeUndefined();
    expect(read).toEqual([]);
    expect(replay.tab("ghost")).toBeUndefined();
  }));

  it("leaves an unreplayable edit of a tab that is not read unmarked, and marks it when its tab is read", inStore(() => {
    let pending = [
      { id: 1, action: goneIn("tab-2") },
      { id: 2, action: appendTo("tab-1", "More") },
    ];
    let replay = replayGoogleDoc(countedQueue(pending).queue, two(), REPLAY_CONTEXT);
    expect(markdownOf(replay, "tab-1")).toBe("Draft\n\nMore\n");
    expect(pending[0].action.invalidatedReason).toBeUndefined();

    expect(markdownOf(replay, "tab-2")).toBe("Other\n");
    expect(pending[0].action.invalidatedReason).toContain(
      `${REPLAY_CONTEXT}: replaceText: oldMarkdown was not found in the current simulated tab "tab-2".`);
  }));

  it("lists a queued add in the outline at its place and shifts its siblings", inStore(() => {
    let { copy, read } = watched(two());
    let { queue } = countedQueue([{ id: 1, action: add("pending-tab-a", { index: 1 }) }]);
    let { outline } = replayGoogleDoc(queue, copy, REPLAY_CONTEXT);
    expect(outline).toEqual([
      { tabId: "tab-1", title: "Tab 1", index: 0, nestingLevel: 0 },
      { tabId: "pending-tab-a", title: "Notes", index: 1, nestingLevel: 0 },
      { tabId: "tab-2", title: "Tab 2", index: 2, nestingLevel: 0 },
    ]);
    // Identities only: no tab's content was read, and the copy's own outline is as it was.
    expect(read).toEqual([]);
    expect(copy.outline.map(({ tabId, index }) => [tabId, index])).toEqual([["tab-1", 0], ["tab-2", 1]]);
  }));

  it.each(INVALIDATORS)(
    "makes no tab for an add whose place is gone, and refuses the edits queued for it in the same replay, in a queue that %s",
    inStore(invalidator => {
      let pending = [
        { id: 1, action: add("pending-tab-a", { parentTabId: "gone" }) },
        { id: 2, action: appendTo("pending-tab-a", "First words") },
        { id: 3, action: goneIn("pending-tab-a") },
        { id: 4, action: appendTo("tab-1", "More") },
      ];
      let { queue, reasons, listed } = countedQueue(pending, invalidator);
      let { copy, read } = watched(two());
      let made = spending(() => replayGoogleDoc(queue, copy, REPLAY_CONTEXT));

      // One replay, and no tab asked for.
      expect(made.queueReads).toBe(1);
      expect(read).toEqual([]);
      expect([...reasons]).toEqual([
        [1, dropped('addTab: no tab with ID "gone" exists in this document. ' +
          "Call listTabs() to refresh the tab list.")],
        [2, dropped('appendText: no tab with ID "pending-tab-a" exists in this document. ' +
          "Call listTabs() to refresh the tab list.")],
        [3, dropped('replaceText: no tab with ID "pending-tab-a" exists in this document. ' +
          "Call listTabs() to refresh the tab list.")],
      ]);
      expect(made.value.outline.map(({ tabId }) => tabId)).toEqual(["tab-1", "tab-2"]);
      expect(made.value.tab("pending-tab-a")).toBeUndefined();
      if (invalidator === "removes the record") expect(listed()).toEqual([4]);
      else expect(pending.map(({ action }) => !!action.invalidatedReason)).toEqual([true, true, true, false]);
    }));

  it.each(INVALIDATORS)(
    "leaves out a record that carries a reason, and one it invalidated, in a queue that %s",
    inStore(invalidator => {
      // A record that carries a reason is never reduced, whatever it would do.
      let stale = { invalidatedReason: "It was dropped." };
      let carried = countedQueue([
        { id: 1, action: { ...tableChange("tab-1", "deleteTableRows", STALE_IDENTITY), ...stale } },
        { id: 2, action: { ...add("pending-tab-a", {}), ...stale } },
        { id: 3, action: { ...appendTo("pending-tab-a", "First words"), ...stale } },
        { id: 4, action: tableChange("tab-1", "insertTableRows") },
      ], invalidator);
      let tabled = snapshotOf(documentOf(TABLE)).copy;
      let read = spending(() => {
        let replay = replayGoogleDoc(carried.queue, tabled, REPLAY_CONTEXT);
        expect(replay.outline.map(({ tabId }) => tabId)).toEqual(["tab-1"]);
        return markdownOf(replay, "tab-1");
      });
      expect(read.folds).toBe(1);
      expect(read.value).toContain("<td><p>x</p></td>");
      expect(carried.reasons.size).toBe(0);

      // An edit the tab tree refused is not reduced again by the only tab's fold.
      let refused = countedQueue([
        { id: 1, action: add("pending-tab-a", {}) },
        { id: 2, action: unnamed(appendTo("tab-1", "More")) },
      ], invalidator);
      let one = snapshotOf(document("Draft")).copy;
      let made = spending(() => replayGoogleDoc(refused.queue, one, REPLAY_CONTEXT));
      expect(made.folds).toBe(2);
      expect([...refused.reasons]).toEqual([[2, dropped(PREDATES_TABS)]]);
      expect(spending(() => markdownOf(made.value, "tab-1"))).toMatchObject({ value: "Draft\n", folds: 0 });
      expect(refused.reasons.size).toBe(1);
    }));

  it("applies an edit that names no tab to a document of one tab", inStore(() => {
    let pending = [{ id: 1, action: unnamed(appendTo("tab-1", "More")) }];
    let replay = replayGoogleDoc(
      countedQueue(pending).queue, snapshotOf(document("Draft")).copy, REPLAY_CONTEXT);
    expect(markdownOf(replay, "tab-1")).toBe("Draft\n\nMore\n");
    expect(pending[0].action.invalidatedReason).toBeUndefined();
  }));

  it("refuses it once an add precedes it", inStore(() => {
    let pending = [
      { id: 1, action: unnamed(appendTo("tab-1", "Kept")) },
      { id: 2, action: add("pending-tab-a", {}) },
      { id: 3, action: unnamed(appendTo("tab-1", "More")) },
    ];
    let replay = replayGoogleDoc(
      countedQueue(pending).queue, snapshotOf(document("Draft")).copy, REPLAY_CONTEXT);
    expect(pending.map(({ action }) => action.invalidatedReason))
      .toEqual([undefined, undefined, dropped(PREDATES_TABS)]);
    expect(markdownOf(replay, "tab-1")).toBe("Draft\n\nKept\n");
  }));

  it("refuses it in a document of several tabs", inStore(() => {
    let pending = [{ id: 1, action: unnamed(appendTo("tab-1", "More")) }];
    let replay = replayGoogleDoc(countedQueue(pending).queue, two(), REPLAY_CONTEXT);
    expect(pending[0].action.invalidatedReason).toBe(dropped(PREDATES_TABS));
    expect(markdownOf(replay, "tab-1")).toBe("Draft\n");
  }));

  it("leaves it out when a tab already holds its write", inStore(() => {
    let marker = { "gadgets-write-w-1": {
      namedRanges: [{ namedRangeId: "marker-w-1", name: "gadgets-write-w-1" }] } };
    let one = document("Draft");
    one.tabs[0].namedRanges = marker;
    let several = documentOf([para("Draft")], [para("Other")]);
    several.tabs[1].namedRanges = marker;
    for (let fetched of [one, several]) {
      let pending = [{ id: 1, action: unnamed(appendTo("tab-1", "More")) }];
      let spent = spending(() => {
        let replay = replayGoogleDoc(
          countedQueue(pending).queue, snapshotOf(fetched).copy, REPLAY_CONTEXT);
        return markdownOf(replay, "tab-1");
      });
      expect(spent).toMatchObject({ value: "Draft\n", folds: 0 });
      expect(pending[0].action.invalidatedReason).toBeUndefined();
    }
  }));

  describe.each([
    ["a document of several tabs", () => documentOf([para("Draft")], [para("Other")]), []],
    ["a document of one tab behind a queued add", () => document("Draft"),
      [{ id: 1, action: add("pending-tab-a", {}) }]],
  ] as const)("in %s", (_name, fetched, ahead) => {
    it.each([undefined, 5, 6])(
      "refuses an edit that names no tab for its earlier Markdown format before it asks which tab it meant (version %s)",
      inStore(markdownVersion => {
        let pending: GoogleDocPendingAction[] = [
          ...ahead,
          { id: 2, action: { ...unnamed(appendTo("tab-1", "Old")), markdownVersion } },
          { id: 3, action: unnamed(appendTo("tab-1", "More")) },
        ];
        // One replay, and no tab asked for.
        replayGoogleDoc(countedQueue(pending).queue, snapshotOf(fetched()).copy, REPLAY_CONTEXT);
        expect(pending.at(-2)!.action.invalidatedReason).toBe(dropped(EARLIER_FORMAT));
        expect(pending.at(-1)!.action.invalidatedReason).toBe(dropped(PREDATES_TABS));
      }));
  });

  it.each([undefined, 5, 6])(
    "refuses an edit that names no tab for its earlier Markdown format in a document of one tab, once (version %s)",
    inStore(markdownVersion => {
      let pending = [{ id: 1, action: { ...unnamed(appendTo("tab-1", "Old")), markdownVersion } }];
      let { queue, reasons } = countedQueue(pending);
      let made = spending(() =>
        replayGoogleDoc(queue, snapshotOf(document("Draft")).copy, REPLAY_CONTEXT));
      expect(made.folds).toBe(1);
      expect([...reasons]).toEqual([[1, dropped(EARLIER_FORMAT)]]);
      // The tab tree refused it, so the fold of the only tab is not given it.
      expect(spending(() => markdownOf(made.value, "tab-1"))).toMatchObject({ value: "Draft\n", folds: 0 });
    }));

  it("refuses the table changes behind a refused one in its tab, and none in another tab", inStore(() => {
    let copy = snapshotOf(documentOf(TABLE, TABLE)).copy;
    let pending = [
      { id: 1, action: tableChange("tab-1", "deleteTableRows", STALE_IDENTITY) },
      { id: 2, action: tableChange("tab-1", "insertTableRows") },
      { id: 3, action: tableChange("tab-2", "insertTableRows") },
      { id: 4, action: appendTo("tab-1", "More") },
    ];
    let replay = replayGoogleDoc(countedQueue(pending).queue, copy, REPLAY_CONTEXT);
    expect(markdownOf(replay, "tab-1")).not.toContain("<td><p>x</p></td>");
    expect(markdownOf(replay, "tab-1")).toContain("More\n");
    expect(markdownOf(replay, "tab-2")).toContain("<td><p>x</p></td>");
    expect(pending[0].action.invalidatedReason).toMatch(
      new RegExp(`^${REPLAY_CONTEXT}: deleteTableRows: `));
    expect(pending[1].action.invalidatedReason)
      .toBe(dropped(tableGateRefusal("insertTableRows").message));
    expect(pending[2].action.invalidatedReason).toBeUndefined();
    expect(pending[3].action.invalidatedReason).toBeUndefined();
  }));

  it("replays every tab a pending edit targets after an approval, over one read of the queue", inStore(() => {
    let { copy, read } = watched(
      snapshotOf(documentOf([para("Draft")], [para("Other")], [para("Third")])).copy);
    let pending = [
      { id: 1, action: goneIn("tab-1") },
      { id: 2, action: goneIn("tab-2") },
      { id: 3, action: appendTo("tab-2", "Else") },
    ];
    let spent = spending(() =>
      replayGoogleDocActions(countedQueue(pending).queue, copy, "After an approval"));
    expect(spent).toMatchObject({ queueReads: 1, folds: 3 });
    expect(pending.map(({ action }) => action.invalidatedReason?.split(":")[0]))
      .toEqual(["After an approval", "After an approval", undefined]);
    // A tab with no pending edit is not read.
    expect(read).toEqual(["tab-1", "tab-2"]);
  }));

  it.each(INVALIDATORS)(
    "answers a tab asked for twice from one replay without folding or invalidating again, in a queue that %s",
    inStore(invalidator => {
      let { queue, reasons } = countedQueue(
        [{ id: 1, action: goneIn("tab-1") }, { id: 2, action: appendTo("tab-1", "More") }], invalidator);
      let replay = replayGoogleDoc(queue, two(), REPLAY_CONTEXT);
      let first = replay.tab("tab-1");
      let again = spending(() => replay.tab("tab-1"));
      expect(again).toEqual({ value: first, folds: 0, queueReads: 0 });
      expect(again.value).toBe(first);
      expect([...reasons.keys()]).toEqual([1]);
    }));

  describe("what a sweep keeps of a pending add's tab", () => {
    /** An add and two edits of its tab, replayed over a copy of "Draft". */
    function addedTab() {
      let { copy } = snapshotOf(document("Draft"));
      let { store, doc } = storedIn(copy);
      let pending: GoogleDocPendingAction[] = [
        { id: 1, action: add("pending-tab-a", {}) },
        { id: 2, action: appendTo("pending-tab-a", "First words") },
        { id: 3, action: appendTo("pending-tab-a", "More") },
      ];
      let read = () => markdownIn(replayGoogleDoc(queueOf(pending), copy, REPLAY_CONTEXT).tab("pending-tab-a"));
      expect(read()).toBe("First words\n\nMore\n");
      let results = () => storage!.sql
        .exec<{ rows: number }>("SELECT count(*) AS rows FROM doc_result").one().rows;
      return { store, doc, pending, read, results };
    }

    it("a sweep keeps what the edits queued in a pending add's tab made", inStore(() => {
      let { store, doc, pending, read } = addedTab();
      store.sweep(doc, pendingDocKeys(store, doc, pending));
      let before = { ...docStoreCost };
      expect(read()).toBe("First words\n\nMore\n");
      expect(docStoreCost.resultsStored).toBe(before.resultsStored);
      expect(docStoreCost.resultsFound).toBe(before.resultsFound + 2);
    }));

    it("a sweep removes them once the add is rejected", inStore(() => {
      let { store, doc, pending, results } = addedTab();
      expect(results()).toBe(2);
      // The add is gone from the queue: nothing starts from the tab it made.
      store.sweep(doc, pendingDocKeys(store, doc, pending.slice(1)));
      expect(results()).toBe(0);
      expect(storage!.sql.exec<{ rows: number }>(
        "SELECT count(*) AS rows FROM doc_version WHERE doc = ?", doc).one().rows).toBe(1);
    }));
  });

  it("makes the tab of an add from nothing when another add takes a rejected add's id", inStore(() => {
    let copy = two();
    let { queue, remove, push } = countedQueue([
      { id: 1, action: add("pending-tab-a", {}) },
      { id: 2, action: appendTo("pending-tab-a", "First words") },
      { id: 3, action: appendTo("tab-1", "More") },
    ]);
    let read = () => spending(() => {
      let replay = replayGoogleDoc(queue, copy, REPLAY_CONTEXT);
      return [replay.tab("pending-tab-a"), replay.tab("tab-1")].map(tab => tab && markdownIn(tab));
    });
    // The add is a step of the tab tree and one of its tab.
    expect(read()).toMatchObject({ value: ["First words\n", "Draft\n\nMore\n"], folds: 4 });
    expect(read()).toMatchObject({ value: ["First words\n", "Draft\n\nMore\n"], folds: 4 });

    // The add is rejected with the edit queued for its tab; another add takes the same id.
    remove(1, 2);
    push({ id: 4, action: add("pending-tab-a", { index: 0 }) });
    let replay = replayGoogleDoc(queue, copy, REPLAY_CONTEXT);
    expect(replay.outline.map(({ tabId }) => tabId)).toEqual(["pending-tab-a", "tab-1", "tab-2"]);
    expect(running().tab(replay.tab("pending-tab-a")!))
      .toEqual(asStored(pruneTab(blankDocsTab("pending-tab-a", "Notes"))));
  }));
});

describe("a Doc edit prepared through a read that is authorized", () => {
  /** A session over one tab with `pending` queued, whose next read's authorization runs `during`. */
  function session(
    pending: { id: number; action: GoogleDocAction }[],
    tab: GoogleDocsTab = buildTab([{ runs: ["Draft\n"] }]),
  ) {
    let during: (() => void) | undefined;
    let queued: GoogleDocAction[] = [];
    let document = {
      documentId: "doc-1", title: "Plan", revisionId: "r1",
      tabs: [{ ...tab, title: "Main" }],
    };
    let changes: DocChangeQueue = {
      pending: () => pending,
      invalidate: () => {},
      cache: { writes: 0 },
      queue: async prepare => {
        let { action, result } = await prepare();
        queued.push(action);
        return result;
      },
      afterTurns: async () => {},
      adoptedTabId: tabId => tabId,
      authorizesPreparation: true,
      simulates: true,
    };
    let docs = new GoogleDocSessionImpl({
      docsApi: {
        getDocument: async () => structuredClone(document),
        getRevisionId: async () => "r1",
        getDocumentMetadata: async () => ({ title: "Plan", revisionId: "r1" }),
      } as unknown as GoogleDocsApi,
      driveApi: {} as DriveApi,
      documentId: "doc-1",
      approvalQueue: {} as RpcStub<ApprovalQueue>,
      // The authorization is awaited after the fetch, as a Drive binding's is.
      read: async (fetch, observe) => {
        let value = await fetch();
        observe(value);
        let decide = during;
        during = undefined;
        decide?.();
        return value;
      },
      changes,
      source: {
        snapshot: async () => snapshotOf(structuredClone(document)),
        read: (snapshot, use) => use(snapshot),
        approved: () => {},
        metadata: async () => ({ title: "Plan", modifiedAt: 0 }),
        metadataObservation: { title: "t", description: "d" },
      },
    });
    return { docs, queued, decideDuringNextRead: (decide: () => void) => { during = decide; } };
  }

  // The read's authorization is awaited after the check: an edit rejected meanwhile would leave
  // the new one queued against content that will never exist.
  it("is refused when an edit it was checked against is decided meanwhile", inStore(async () => {
    let pending = [{ id: 1, action: { ...APPEND, markdown: "More" } }];
    let { docs, queued, decideDuringNextRead } = session(pending);
    decideDuringNextRead(() => pending.splice(0));

    await expect(docs.replaceText("More", "Most")).rejects.toThrow("was approved or rejected");
    expect(queued).toEqual([]);
  }));

  // Checked again, the caller's text would be matched over another queue than
  // the one it read, and could name other content: the caller reads again instead.
  it("is refused even where a fresh check over the moved queue would pass", inStore(async () => {
    let pending = [{ id: 1, action: { ...APPEND, markdown: "More" } }];
    let { docs, queued, decideDuringNextRead } = session(pending);
    decideDuringNextRead(() => pending.splice(0));

    await expect(docs.replaceText("Draft", "Final")).rejects.toThrow("was approved or rejected");
    expect(queued).toEqual([]);
  }));

  it("is queued when nothing it was checked against moved", inStore(async () => {
    let pending = [{ id: 1, action: { ...APPEND, markdown: "More" } }];
    let { docs, queued } = session(pending);
    await docs.replaceText("More", "Most");
    expect(queued).toMatchObject([{ type: "replaceText", oldMarkdown: "More", newMarkdown: "Most" }]);
  }));

  // What a card shows beyond the edit's own texts is stored with it; the texts never twice.
  it("stores with an edit only what its card shows beyond the edit", inStore(async () => {
    let label = "\"Main\" (tab-1)";
    let plain = session([]);
    await plain.docs.replaceText("Draft", "Final");
    await plain.docs.appendText("More");
    expect(plain.queued.map(({ display }) => display)).toEqual([{ tab: label }, { tab: label }]);

    // Splitting a numbered item renumbers the item after it, so the card shows that item too.
    let list = session([], buildTab(
      [item("a", "N1"), item("b", "N1"), item("c", "N1")], NUMBERED_LIST));
    await list.docs.replaceText("b", "b\n\nplain");
    expect(list.queued[0]).toMatchObject({ oldMarkdown: "b", newMarkdown: "b\n\nplain" });
    expect(list.queued[0]).not.toHaveProperty("inTable");
    expect(list.queued[0].display).toEqual({
      tab: label, context: { before: "", after: "\n1. c" }, rendered: "b\n\nplain\n\n3. c",
    });
    expect(describeDocEdit(list.queued[0] as Replace).fields)
      .toEqual([
        cardField("Old", "b\n1. c", "markdown"),
        cardField("Requested New", "b\n\nplain\n1. c", "markdown"),
        cardField("New", "b\n\nplain\n\n3. c", "markdown"),
      ]);

    // In a table cell the values are the table's HTML, and the card's prose says so.
    let table = session([], buildTab([para("top"), grid(["alpha", "b"], ["c", "d"]), para("end")]));
    await table.docs.replaceText("alpha", "A & B");
    expect(table.queued[0]).toMatchObject({ inTable: true });
    expect(table.queued[0].display).toEqual({
      tab: label, rendered: "A &amp; B",
      prose: `Replace text in a table of tab ${label}. The values below are the table's HTML: ` +
        "Markdown syntax in them is written to the cells as typed.",
    });
    expect(describeDocEdit(table.queued[0] as Replace).fields)
      .toEqual([
        cardField("Old", "alpha", "html"), cardField("Requested New", "A & B", "html"),
        cardField("New", "A &amp; B", "html"),
      ]);

    // An append whose markers the named styles already give stores how it reads.
    let styled = session([], {
      ...buildTab([para("Intro")]),
      namedStyles: { styles: [{ namedStyleType: "NORMAL_TEXT", textStyle: { bold: true } }] },
    });
    await styled.docs.appendText("*a* **b**");
    expect(styled.queued[0].display).toEqual({ tab: label, rendered: "*a* b" });
    expect(describeDocEdit(styled.queued[0] as Append).fields)
      .toEqual([
        cardField("Requested", "*a* **b**", "markdown"), cardField("Resulting", "*a* b", "markdown"),
      ]);
  }));
});

describe("a Drive binding's Doc snapshot", () => {
  // Another session on the binding can queue an edit checked against a newer revision while this
  // one's request is out: replayed over the older answer, that valid edit would fail for good.
  it("is fetched again when an edit is queued while the fetch is out", inStore(async () => {
    let revision = "r1";
    let calls = 0;
    let release: (() => void) | undefined;
    let docsApi = {
      getDocument: async () => {
        calls++;
        let answered = { ...document("Draft"), revisionId: revision };
        if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
        return answered;
      },
    } as unknown as GoogleDocsApi;
    let newest = 0;
    let source = driveDocSource(docsApi, {} as DriveApi, "doc-1", copiesOf(), {
      writes: () => 0, newestQueued: () => newest, revisionMoves: () => 0,
    });

    let fetched = source.snapshot();
    await vi.waitFor(() => expect(release).toBeDefined());
    revision = "r2";
    newest = 7;
    release!();
    expect((await fetched).revisionId).toBe("r2");
    expect(calls).toBe(2);
  }));
});

/** A source over a stub Google that counts its requests, with the document at revision `r<n>`. */
function countedSource() {
  let state = { revision: 1, gets: 0, probes: 0, writes: 0, newest: 0, moves: 0 };
  let docsApi = {
    getDocument: async () => { state.gets++; return docAt(`r${state.revision}`, "Draft"); },
    getRevisionId: async () => { state.probes++; return `r${state.revision}`; },
  } as unknown as GoogleDocsApi;
  let source = driveDocSource(docsApi, {} as DriveApi, "doc-1", copiesOf(), {
    writes: () => state.writes, newestQueued: () => state.newest,
    revisionMoves: () => state.moves,
  });
  return { state, source };
}

describe("a Drive binding's Doc snapshot, reused", () => {
  // An edit is stamped while it is prepared and may enter the queue only after a snapshot fetched
  // later than that: its time cannot tell the snapshot holds what the edit was checked against.
  it("is not reused once an edit has been queued since it was fetched", inStore(async () => {
    let calls = 0;
    let docsApi = {
      getDocument: async () => { calls++; return { ...document("Draft"), revisionId: `r${calls}` }; },
    } as unknown as GoogleDocsApi;
    let newest = 0;
    let source = driveDocSource(docsApi, {} as DriveApi, "doc-1", copiesOf(), {
      writes: () => 0, newestQueued: () => newest, revisionMoves: () => 0,
    });
    let first = await source.snapshot();
    source.approved(first);
    expect(await source.snapshot()).toBe(first);
    newest = 4;
    expect((await source.snapshot()).revisionId).toBe("r2");
    expect(calls).toBe(2);
  }));

  const T = Date.UTC(2026, 0, 1);

  /** One document in a counting stub Google, and sources of one file id, each with its own counters. */
  function sharedDoc() {
    let google = {
      revision: 1, text: "Draft", gets: 0, probes: 0,
      /** Awaited by a fetch before it answers the document it read when it was asked. */
      duringGet: undefined as (() => Promise<void>) | undefined,
      /** Awaited by a revision probe before it answers. */
      duringProbe: undefined as (() => Promise<void>) | undefined,
      /** What a revision probe answers, in place of the document's revision. */
      probed: undefined as string | undefined,
    };
    let docsApi = {
      getDocument: async () => {
        google.gets++;
        let document = docAt(`r${google.revision}`, google.text);
        await google.duringGet?.();
        return document;
      },
      getRevisionId: async () => {
        google.probes++;
        await google.duringProbe?.();
        return google.probed ?? `r${google.revision}`;
      },
    } as unknown as GoogleDocsApi;
    let open = () => {
      let binding = { writes: 0, newest: 0, moves: 0 };
      let copies = copiesOf();
      let source = driveDocSource(docsApi, {} as DriveApi, "doc-1", copies, {
        writes: () => binding.writes, newestQueued: () => binding.newest,
        revisionMoves: () => binding.moves,
      });
      /** A read through the source that is authorized: what it read of the tab. */
      let read = async (folder?: string) => {
        let snapshot = await source.snapshot();
        let text = textOf(source, snapshot);
        source.approved(snapshot, folder);
        return text;
      };
      return { binding, copies, source, read };
    };
    return { google, open };
  }

  /** The Markdown of the document's one tab, read through `source` as a session reads it. */
  const textOf = (source: DriveDocSource, snapshot: GoogleDocSnapshot): string =>
    source.read(snapshot, taken => taken.copy.markdown(taken.copy.tab("tab-1")!).trim());

  /** How many rows each of the store's tables holds of any document. */
  function docRows(): Record<string, number> {
    let { sql } = storage!;
    let tables = sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'doc\\_%' ESCAPE '\\' " +
      "AND name <> 'doc_format' ORDER BY name").toArray();
    return Object.fromEntries(tables.map(({ name }) =>
      [name, sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`).one().n]));
  }
  const stored = () => Object.values(docRows()).reduce((sum, n) => sum + n, 0);

  it("stores nothing of a document before its read is approved", inStore(async () => {
    let { google, open } = sharedDoc();
    let { source } = open();
    let snapshot = await source.snapshot();
    expect(snapshot.copy.held()).toBe(false);
    expect(() => snapshot.copy.tab("tab-1")).toThrow(DOC_COPY_UNREADABLE);
    expect(textOf(source, snapshot)).toBe("Draft");
    expect(stored()).toBe(0);
    expect(running().head("file")).toBeUndefined();

    source.approved(snapshot);
    expect(running().head("file")).toMatchObject({ revision: "r1", stale: false });
    expect(docRows()).toMatchObject({ doc_copy: 1, doc_version: 1, doc_run: 2 });
    expect(snapshot.copy.held()).toBe(true);
    expect(textOf(source, snapshot)).toBe("Draft");
    expect(google.gets).toBe(1);
  }));

  it("stores nothing of a read that is never approved", inStore(async () => {
    let { google, open } = sharedDoc();
    let { source } = open();
    expect(textOf(source, await source.snapshot())).toBe("Draft");
    // The snapshot is let go: the next read fetches, and still nothing is stored.
    expect(textOf(source, await source.snapshot())).toBe("Draft");
    expect(google.gets).toBe(2);
    expect(stored()).toBe(0);
    expect(source.held()).toBeUndefined();
  }));

  it("keeps what a trial's replay marked", inStore(async () => {
    let { open } = sharedDoc();
    let { source } = open();
    let { kv } = storage!;
    let gone: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "Missing", newMarkdown: "Found", display: { tab: "x" },
    };
    let queue: GoogleDocReplayQueue = {
      pending: () => kv.get("mark:1") === undefined ? [{ id: 1, action: gone }] : [],
      invalidate: ({ id }, reason) => kv.put(`mark:${id}`, reason),
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    source.read(await source.snapshot(), taken => replayGoogleDocActions(queue, taken.copy, "A trial"));
    // The mark is the replay's purpose: it stands though nothing of the document is stored.
    expect(kv.get<string>("mark:1")).toContain("A trial");
    expect(stored()).toBe(0);
  }));

  it("reads a second document of the file beside the stored copy and leaves that copy as it was", inStore(async () => {
    let { google, open } = sharedDoc();
    let first = open(), second = open();
    expect(await first.read()).toBe("Draft");
    let head = running().head("file");
    let rows = docRows();

    google.revision = 2;
    google.text = "Rewritten";
    expect(textOf(second.source, await second.source.snapshot())).toBe("Rewritten");
    expect(running().head("file")).toEqual(head);
    expect(docRows()).toEqual(rows);
    // The first source still reuses the copy its read kept.
    expect(await first.read()).toBe("Draft");
    expect(google.gets).toBe(2);
  }));

  // THE ONE EXTRA `documents.get`: another source kept a later document, so the first fetches
  // though its snapshot is inside its TTL.
  it("fetches again once another source kept a later document of the file", inStore(async () => {
    let { google, open } = sharedDoc();
    let first = open(), second = open();
    expect(await first.read()).toBe("Draft");
    google.revision = 2;
    google.text = "Rewritten";
    expect(await second.read()).toBe("Rewritten");
    expect(google.gets).toBe(2);

    expect(await first.read()).toBe("Rewritten");
    expect(google).toMatchObject({ gets: 3, probes: 0 });
    expect(await first.read()).toBe("Rewritten");
    expect(await second.read()).toBe("Rewritten");
    expect(google.gets).toBe(3);
  }));

  it("is still reused after another source kept the same document", inStore(async () => {
    let { google, open } = sharedDoc();
    let first = open(), second = open();
    let snapshot = await first.source.snapshot();
    first.source.approved(snapshot);
    expect(await second.read()).toBe("Draft");
    expect(google.gets).toBe(2);
    // An unchanged document has one id whichever read kept it.
    expect(snapshot.copy.held()).toBe(true);
    expect(await first.source.snapshot()).toBe(snapshot);
    expect(first.source.held()).toBe(snapshot);
    expect(google.gets).toBe(2);
  }));

  // An unchanged document has one id whichever read kept it: both snapshots stay reusable.
  it.each(["after", "before"])(
    "is reused by a source whose first read ended %s another's on the same document",
    inStore(async order => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T);
      let { google, open } = sharedDoc();
      let first = open(), second = open();
      let early = await first.source.snapshot();
      vi.setSystemTime(T + 1);
      let late = await second.source.snapshot();
      for (let [source, snapshot] of order === "after"
        ? [[second.source, late], [first.source, early]] as const
        : [[first.source, early], [second.source, late]] as const) {
        textOf(source, snapshot);
        source.approved(snapshot);
      }
      // The stored copy is the one fetched later, and both snapshots hold its view.
      expect(running().head("file")?.fetchedAt).toBe(T + 1);
      expect(early.copy.held()).toBe(true);
      expect(late.copy.held()).toBe(true);
      expect(await first.source.snapshot()).toBe(early);
      expect(await second.source.snapshot()).toBe(late);
      expect(google.gets).toBe(2);
    }));

  it("fetches past the TTL when another source kept a later document during the revision probe", inStore(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    let { google, open } = sharedDoc();
    let first = open(), second = open();
    expect(await first.read()).toBe("Draft");

    vi.setSystemTime(T + DOC_SNAPSHOT_TTL_MS + 1);
    google.revision = 2;
    google.text = "Rewritten";
    // While the probe is out the other source keeps a change; the probe says the revision stands.
    google.duringProbe = async () => {
      google.duringProbe = undefined;
      expect(await second.read()).toBe("Rewritten");
    };
    google.probed = "r1";
    // It fetches, where reusing its snapshot would throw: storage holds another copy.
    expect(textOf(first.source, await first.source.snapshot())).toBe("Rewritten");
    expect(google).toMatchObject({ gets: 3, probes: 1 });
  }));

  // An edit queued during the probe voids its answer: the read starts over and fetches once.
  it("fetches once past the TTL when an edit is queued during a revision probe that answers unchanged", inStore(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    let { google, open } = sharedDoc();
    let { binding, source, read } = open();
    expect(await read()).toBe("Draft");
    let first = await source.snapshot();

    vi.setSystemTime(T + DOC_SNAPSHOT_TTL_MS + 1);
    google.duringProbe = async () => { binding.newest = 5; };
    let second = await source.snapshot();
    expect(second).not.toBe(first);
    expect(textOf(source, second)).toBe("Draft");
    expect(google).toMatchObject({ gets: 2, probes: 1 });
  }));

  it("is not held for a write once another source kept a later document", inStore(async () => {
    let { google, open } = sharedDoc();
    let first = open(), second = open();
    let snapshot = await first.source.snapshot();
    first.source.approved(snapshot);
    expect(first.source.held()).toBe(snapshot);
    google.revision = 2;
    google.text = "Rewritten";
    await second.read();
    // The pin is not used: the approval fetches, as it does for a pin Google refuses.
    expect(first.source.held()).toBeUndefined();
  }));

  it("does not put an older document over one another source kept after it", inStore(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    let { google, open } = sharedDoc();
    let first = open(), second = open();
    let slow = await first.source.snapshot();
    vi.setSystemTime(T + 1);
    google.revision = 2;
    google.text = "Rewritten";
    expect(await second.read()).toBe("Rewritten");
    let head = running().head("file");

    first.source.approved(slow);
    expect(running().head("file")).toEqual(head);
    expect(slow.copy.held()).toBe(false);
    expect(first.source.held()).toBeUndefined();
    // Its next read fetches, and keeps what it fetched.
    expect(await first.read()).toBe("Rewritten");
    expect(google.gets).toBe(3);
  }));

  // A document is as old as the request that fetched it, however late its answer came.
  it("does not put a document whose fetch answered late over one another source fetched and kept meanwhile", inStore(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    let { google, open } = sharedDoc();
    let first = open(), second = open();
    // While the first source's fetch is out, the document changes and the other source keeps it.
    google.duringGet = async () => {
      google.duringGet = undefined;
      vi.setSystemTime(T + 1);
      google.revision = 2;
      google.text = "Rewritten";
      expect(await second.read()).toBe("Rewritten");
      vi.setSystemTime(T + 2);
    };
    let slow = await first.source.snapshot();
    let head = running().head("file");
    expect(head).toMatchObject({ revision: "r2", fetchedAt: T + 1 });

    expect(textOf(first.source, slow)).toBe("Draft");
    first.source.approved(slow);
    expect(running().head("file")).toEqual(head);
    expect(slow.copy.held()).toBe(false);
    expect(first.source.held()).toBeUndefined();
    // Its next read fetches, and keeps what it fetched.
    expect(await first.read()).toBe("Rewritten");
    expect(google.gets).toBe(3);
  }));

  // The record names the folder of the stored copy's last approved read; an approval of a read
  // of another document says nothing of it.
  it("does not record the approval of a read of an older copy on one another source kept after it", inStore(async () => {
    let { google, open } = sharedDoc();
    let first = open(), second = open();
    expect(await first.read("f1")).toBe("Draft");
    let reused = await first.source.snapshot();
    expect(reused.copy.held()).toBe(true);
    google.revision = 2;
    google.text = "Later";
    expect(await second.read("f2")).toBe("Later");
    let head = running().head("file");
    expect(head).toMatchObject({ folder: "f2", revision: "r2" });

    first.source.approved(reused, "f1");
    expect(running().head("file")).toEqual(head);
    expect(google.gets).toBe(2);
  }));

  it("keeps nothing of a fetch a queued edit overtook", inStore(async () => {
    let revision = 1;
    let calls = 0;
    let release: (() => void) | undefined;
    let docsApi = {
      getDocument: async () => {
        calls++;
        let answered = docAt(`r${revision}`, `Draft ${revision}`);
        if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
        return answered;
      },
    } as unknown as GoogleDocsApi;
    let newest = 0;
    let source = driveDocSource(docsApi, {} as DriveApi, "doc-1", copiesOf(), {
      writes: () => 0, newestQueued: () => newest, revisionMoves: () => 0,
    });
    let fetched = source.snapshot();
    await vi.waitFor(() => expect(release).toBeDefined());
    revision = 2;
    newest = 7;
    release!();
    let snapshot = await fetched;
    expect(stored()).toBe(0);
    source.approved(snapshot);
    // Only the document fetched after the edit was queued is kept.
    expect(running().head("file")?.revision).toBe("r2");
    expect(docRows()).toMatchObject({ doc_copy: 1, doc_version: 1 });
    expect(textOf(source, snapshot)).toBe("Draft 2");
  }));

  it("keeps nothing of a fetch a write landed after, while its read was checked", inStore(async () => {
    let { google, open } = sharedDoc();
    let { binding, copies, source, read } = open();
    expect(await read()).toBe("Draft");
    let head = running().head("file")!;

    binding.newest = 1;
    let snapshot = await source.snapshot();
    expect(google.gets).toBe(2);
    // The write lands during the scope check, and the binding marks the store where it does.
    binding.writes = 1;
    copies.wrote();
    source.approved(snapshot);
    expect(running().head("file")).toEqual({ ...head, stale: true });
    expect(snapshot.copy.held()).toBe(false);
    expect(source.held()).toBeUndefined();

    // The next read fetches, as it would whatever was kept, and its document is stored.
    google.revision = 2;
    google.text = "Written";
    expect(await read()).toBe("Written");
    expect(google.gets).toBe(3);
    expect(running().head("file")).toMatchObject({ revision: "r2", stale: false });
  }));

  it("keeps nothing of such a fetch where no copy was stored", inStore(async () => {
    let { open } = sharedDoc();
    let { binding, copies, source } = open();
    let snapshot = await source.snapshot();
    binding.writes = 1;
    copies.wrote();
    source.approved(snapshot);
    expect(running().head("file")).toBeUndefined();
    expect(stored()).toBe(0);
    expect(source.held()).toBeUndefined();
  }));

  it("is not reused once a write landed, by this source or one made after it", inStore(async () => {
    let { google, open } = sharedDoc();
    let { binding, copies, source } = open();
    let snapshot = await source.snapshot();
    source.approved(snapshot);
    expect(snapshot.copy.held()).toBe(true);

    binding.writes = 1;
    copies.wrote();
    expect(snapshot.copy.held()).toBe(false);
    expect(source.held()).toBeUndefined();
    // A connection that started again counts no write: what it reads of the store says so.
    let later = open();
    expect(running().head("file")?.stale).toBe(true);
    expect(later.source.held()).toBeUndefined();
    expect(await later.read()).toBe("Draft");
    expect(google.gets).toBe(2);
    expect(running().head("file")?.stale).toBe(false);
  }));

  it("keeps once what reads issued together fetched once", inStore(async () => {
    let { google, open } = sharedDoc();
    let { source } = open();
    let [one, other] = await Promise.all([source.snapshot(), source.snapshot()]);
    expect(other).toBe(one);
    expect(google.gets).toBe(1);

    source.approved(one, "f1");
    let head = running().head("file");
    let written = docStoreCost.rowsWritten;
    // The second finds the document kept, and its approval says what the record says already.
    source.approved(other, "f1");
    expect(docStoreCost.rowsWritten).toBe(written);
    expect(running().head("file")).toEqual(head);
    expect(head).toMatchObject({ folder: "f1" });
    expect(source.held()).toBe(one);
  }));

  // What a lookup of quoted text asks for: it may spend one request of Google and no more.
  it("a snapshot asked for with no confirmation is reused inside its TTL and fetched past it, with no revision probe", inStore(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    let { google, open } = sharedDoc();
    let { source, read } = open();
    expect(await read()).toBe("Draft");
    let first = await source.snapshot();

    vi.setSystemTime(T + DOC_SNAPSHOT_TTL_MS - 1);
    expect(await source.snapshot({ confirm: false })).toBe(first);
    expect(google).toMatchObject({ gets: 1, probes: 0 });

    // Past it the document is fetched, not probed: a probe and a fetch would be two requests.
    vi.setSystemTime(T + DOC_SNAPSHOT_TTL_MS);
    let second = await source.snapshot({ confirm: false });
    expect(second).not.toBe(first);
    expect(textOf(source, second)).toBe("Draft");
    expect(google).toMatchObject({ gets: 2, probes: 0 });
    // The fetched snapshot is reused once a read of it is approved, as any other.
    source.approved(second);
    expect(await source.snapshot({ confirm: false })).toBe(second);
    expect(await source.snapshot()).toBe(second);
    expect(google).toMatchObject({ gets: 2, probes: 0 });
  }));

  it("a snapshot asked for with no confirmation joins a fetch in flight, and one asked for with it joins that one's", inStore(async () => {
    let { google, open } = sharedDoc();
    let { source } = open();
    let [read, lookup] = await Promise.all([source.snapshot(), source.snapshot({ confirm: false })]);
    expect(lookup).toBe(read);
    let [again, reading] = await Promise.all([source.snapshot({ confirm: false }), source.snapshot()]);
    expect(reading).toBe(again);
    expect(google).toMatchObject({ gets: 2, probes: 0 });
  }));

  it("a snapshot asked for with no confirmation joins a probe in flight, whose requests are the read's", inStore(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    let { google, open } = sharedDoc();
    let { source, read } = open();
    expect(await read()).toBe("Draft");
    let first = await source.snapshot();

    vi.setSystemTime(T + DOC_SNAPSHOT_TTL_MS);
    let [confirmed, lookup] = await Promise.all([source.snapshot(), source.snapshot({ confirm: false })]);
    expect(confirmed).toBe(first);
    expect(lookup).toBe(first);
    expect(google).toMatchObject({ gets: 1, probes: 1 });
  }));

  // A file with pending edits is fetched at the first read after an edit is queued, not at every
  // read.
  it("reuses the approved snapshot of a file with pending edits until another edit is queued", inStore(async () => {
    let { google, open } = sharedDoc();
    let { binding, read } = open();
    binding.newest = 5;
    await read();
    expect(google.gets).toBe(1);
    for (let again = 0; again < 3; again++) await read();
    expect(google).toMatchObject({ gets: 1, probes: 0 });

    binding.newest = 6;
    await read();
    expect(google.gets).toBe(2);
    await read();
    expect(google).toMatchObject({ gets: 2, probes: 0 });
  }));

  it("leaves the stored copy, its folder and its hour as they were when a read is never approved", inStore(async () => {
    let { google, open } = sharedDoc();
    let { binding, source, read } = open();
    await read("f1");
    let head = running().head("file");
    expect(head).toMatchObject({ folder: "f1" });
    expect(head?.approvedAt).toBeTypeOf("number");
    let rows = docRows();

    // A queued edit makes the next read fetch; the document has changed, and the read is refused.
    binding.newest = 1;
    google.revision = 2;
    google.text = "Rewritten";
    expect(textOf(source, await source.snapshot())).toBe("Rewritten");
    expect(google.gets).toBe(2);
    expect(running().head("file")).toEqual(head);
    expect(docRows()).toEqual(rows);
  }));

  it("is held for a write only while a read could reuse it", inStore(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    let { state, source } = countedSource();
    expect(source.held()).toBeUndefined();
    let first = await source.snapshot();
    // No read that used it is authorized yet.
    expect(source.held()).toBeUndefined();
    source.approved(first);
    expect(source.held()).toBe(first);
    // Past the TTL too: the pin to its revision is the check, and nothing is asked.
    vi.setSystemTime(T + DOC_SNAPSHOT_TTL_MS + 1);
    expect(source.held()).toBe(first);
    expect(state).toMatchObject({ gets: 1, probes: 0 });

    state.writes = 1;
    expect(source.held()).toBeUndefined();
    let second = await source.snapshot();
    source.approved(second);
    expect(source.held()).toBe(second);
    state.newest = 4;
    expect(source.held()).toBeUndefined();
  }));

  // Deleting a write's marker moves the revision, and so does a suggestion of the binding's own.
  it("is not held for a write once the binding moved the revision since its fetch began, and is still read", inStore(async () => {
    let { state, source } = countedSource();
    let first = await source.snapshot();
    source.approved(first);
    state.moves = 1;
    expect(source.held()).toBeUndefined();
    expect(await source.snapshot()).toBe(first);
    expect(state).toMatchObject({ gets: 1, probes: 0 });

  }));

  it("is not held for a write when the binding moved the revision while its fetch was out", inStore(async () => {
    let moves = 0;
    let release: (() => void) | undefined;
    let docsApi = {
      getDocument: async () => {
        let answered = docAt("r1", "Draft");
        await new Promise<void>(resolve => { release = resolve; });
        return answered;
      },
    } as unknown as GoogleDocsApi;
    let source = driveDocSource(docsApi, {} as DriveApi, "doc-1", copiesOf(), {
      writes: () => 0, newestQueued: () => 0, revisionMoves: () => moves,
    });
    let fetched = source.snapshot();
    await vi.waitFor(() => expect(release).toBeDefined());
    moves = 1;
    release!();
    let snapshot = await fetched;
    source.approved(snapshot);
    expect(source.held()).toBeUndefined();
    // A read reuses it all the same.
    expect(await source.snapshot()).toBe(snapshot);
  }));

  it("is held for a write for 24 hours after it was fetched, whatever confirmed it since", inStore(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    let { state, source } = countedSource();
    let first = await source.snapshot();
    source.approved(first);
    vi.setSystemTime(T + DOC_REVISION_PIN_MS);
    expect(source.held()).toBe(first);
    vi.setSystemTime(T + DOC_REVISION_PIN_MS + 1);
    expect(source.held()).toBeUndefined();
    expect(state).toMatchObject({ gets: 1, probes: 0 });

    // A read past the TTL confirms the revision and is served the same snapshot, dated now.
    expect(await source.snapshot()).toBe(first);
    expect(state).toMatchObject({ gets: 1, probes: 1 });
    expect(first.fetchedAt).toBe(T + DOC_REVISION_PIN_MS + 1);
    // The confirmation did not make the revision id younger, and reads go on reusing it.
    expect(source.held()).toBeUndefined();
    expect(await source.snapshot()).toBe(first);
    expect(state).toMatchObject({ gets: 1, probes: 1 });

    // A snapshot fetched since is held.
    state.writes = 1;
    let second = await source.snapshot();
    expect(second).not.toBe(first);
    source.approved(second);
    expect(source.held()).toBe(second);
  }));

  it("is not held again once a batch was built from it, and is still read", inStore(async () => {
    let { state, source } = countedSource();
    let first = await source.snapshot();
    source.approved(first);
    source.spend(first);
    expect(source.held()).toBeUndefined();
    source.approved(first);
    expect(source.held()).toBeUndefined();
    expect(await source.snapshot()).toBe(first);
    expect(state).toMatchObject({ gets: 1, probes: 0 });

    state.newest = 4;
    let second = await source.snapshot();
    source.approved(second);
    expect(source.held()).toBe(second);
  }));
});

// A snapshot's view holds the copy's record and nothing of a tab, a rendering or a result:
// each test keeps one source and snapshot across reads, as a connection that stays awake does.
describe("a Drive source of a Doc, read twice through the same objects", () => {
  const FILE = "large";
  const line = (at: number) => `Line ${String(at).padStart(5, "0")}.`;
  /** A document of one tab of 20,000 paragraphs. */
  const large = (): GoogleDocsDocument => ({
    documentId: "doc-1", title: "Large", revisionId: "r1",
    tabs: [buildTab(Array.from({ length: 20_000 }, (_, at) => para(line(at))))],
  });
  const EDIT: GoogleDocPendingAction = {
    id: 1,
    action: { ...BASE, type: "replaceText", oldMarkdown: line(7), newMarkdown: "Changed.", display: { tab: "x" } },
  };

  /** A source of the large document over the running test's store, with `pending` queued. */
  function sourceOf(pending: GoogleDocPendingAction[] = [], copies = driveDocCopies(
    running, FILE, store => pendingDocKeys(store, FILE, pending))) {
    let state = { gets: 0 };
    let docsApi = {
      getDocument: async () => { state.gets++; return large(); },
      getRevisionId: async () => "r1",
    } as unknown as GoogleDocsApi;
    let source = driveDocSource(docsApi, {} as DriveApi, "doc-1", copies, {
      writes: () => 0, newestQueued: () => Math.max(0, ...pending.map(({ id }) => id)),
      revisionMoves: () => 0,
    });
    /** The tab as a pending read answers it over `snapshot`. */
    let read = (snapshot: GoogleDocSnapshot) => source.read(snapshot, ({ copy }) =>
      copy.markdown(replayGoogleDoc(queueOf(pending), copy, REPLAY_CONTEXT).tab("tab-1")!));
    return { state, source, read };
  }

  /** `sourceOf`, with a snapshot fetched, read in a trial and approved. */
  async function approved(pending: GoogleDocPendingAction[] = []) {
    let { state, source, read } = sourceOf(pending);
    let snapshot = await source.snapshot();
    read(snapshot);
    source.approved(snapshot);
    expect(snapshot.copy.held()).toBe(true);
    return { state, source, snapshot, read: () => read(snapshot) };
  }

  /** What `run` answers, and what it adds to the store's counts. */
  function spent<T>(run: () => T) {
    let before = { ...docStoreCost };
    let value = run();
    return {
      value,
      decoded: docStoreCost.runsDecoded - before.runsDecoded,
      rendered: docStoreCost.runsRendered - before.runsRendered,
      stored: docStoreCost.resultsStored - before.resultsStored,
      found: docStoreCost.resultsFound - before.resultsFound,
    };
  }

  it("a second read decodes the tab again once its Markdown is gone from storage", inStore(async () => {
    let { read } = await approved();
    // Each run was rendered when the copy was kept: a read decodes and renders nothing.
    let first = read();
    expect(spent(read)).toMatchObject({ value: first, decoded: 0, rendered: 0 });

    let { runs } = storage!.sql.exec<{ runs: number }>("SELECT count(*) AS runs FROM doc_seq").one();
    expect(runs).toBe(133);
    storage!.sql.exec("DELETE FROM doc_md").toArray();
    // Each run is decoded and rendered again: a view that remembered the tab would move neither
    // count.
    expect(spent(read)).toMatchObject({ value: first, decoded: runs, rendered: runs });
  }));

  it("a second read makes a pending edit again once its result is gone from storage", inStore(async () => {
    let { read } = await approved([EDIT]);
    let first = spent(read);
    expect(first).toMatchObject({ stored: 1, found: 0 });
    expect(first.value).toContain("Changed.\n");
    expect(spent(read)).toMatchObject({ value: first.value, stored: 0, found: 1, decoded: 0 });

    storage!.sql.exec("DELETE FROM doc_result").toArray();
    expect(spent(read)).toMatchObject({ value: first.value, stored: 1, found: 0 });
  }));

  it("a read fails once the copy's rows are gone, whatever the view remembers", inStore(async () => {
    let { state, source, snapshot, read } = await approved();
    read();
    storage!.sql.exec("DELETE FROM doc_copy").toArray();

    // The ids the view carries are asked of storage before each use.
    expect(snapshot.copy.held()).toBe(false);
    expect(() => snapshot.copy.tab("tab-1")).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(read).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(source.held()).toBeUndefined();
    expect(state.gets).toBe(1);
    expect(await source.snapshot()).not.toBe(snapshot);
    expect(state.gets).toBe(2);
  }));

  it("lets go of a document whose read was refused", inStore(async () => {
    let base = driveDocCopies(running, FILE);
    let document: WeakRef<object> | undefined;
    let { state, source, read } = sourceOf([], {
      ...base,
      // The held document the source keeps for the snapshot, as it hands it over.
      unkept: held => {
        document = new WeakRef(held);
        return base.unkept(held);
      },
    });
    /** A read that fetched, and whose scope check then failed: `approved` is never called. */
    let refused = async () => {
      let snapshot = await source.snapshot();
      expect(read(snapshot)).toContain(`${line(7)}\n`);
      return new WeakRef(snapshot);
    };
    let snapshot = await refused();

    let { gc } = globalThis as { gc?: () => void };
    if (gc) {
      gc();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(snapshot.deref()).toBeUndefined();
      expect(document?.deref()).toBeUndefined();
    }
    // Nothing of it is stored, and nothing is reused: the next read fetches.
    expect(running().head(FILE)).toBeUndefined();
    expect(source.held()).toBeUndefined();
    await source.snapshot();
    expect(state.gets).toBe(2);
  }));

});

// A source keeps which copy a read approved; the connection's caps may remove that copy under
// it, at another file's keep. What the source then does is what a missing copy always costs.
describe("a Drive source of a Doc whose copy the connection evicted", () => {
  const T = Date.UTC(2026, 0, 1), HOUR = 3_600_000;
  const small = (text: string): GoogleDocsDocument => ({
    documentId: "doc-1", title: "Small", revisionId: "r1", tabs: [buildTab([para(text)])],
  });
  /**
   * A connection that keeps one document, what its limits told it, and `sourceOf`: a source of
   * a file saying `text` with `pending` queued, and a whole read through it.
   */
  function connection() {
    let removed: [string, DocCopyRemoval][] = [];
    let pendingDocs = new Set<string>();
    let limits = new DriveDocCopyLimits({
      store: running, pendingDocs: () => pendingDocs,
      removed: (doc, why) => { removed.push([doc, why]); },
      caps: { count: 1, bytes: Infinity },
      // Holds no hour, so each activation's first read passes over the copies: none is old.
      kv: { get: () => undefined, put() {} },
    });
    let sourceOf = (file: string, text: string, pending: GoogleDocPendingAction[] = []) => {
      let state = { gets: 0 };
      let docsApi = {
        getDocument: async () => { state.gets++; return small(text); },
        getRevisionId: async () => "r1",
      } as unknown as GoogleDocsApi;
      let copies = driveDocCopies(running, file, store => pendingDocKeys(store, file, pending), limits);
      let source = driveDocSource(docsApi, {} as DriveApi, file, copies, {
        writes: () => 0, newestQueued: () => Math.max(0, ...pending.map(({ id }) => id)),
        revisionMoves: () => 0,
      });
      let read = async () => {
        let snapshot = await source.snapshot();
        let stored = docStoreCost.resultsStored;
        let markdown = source.read(snapshot, ({ copy }) =>
          copy.markdown(replayGoogleDoc(queueOf(pending), copy, REPLAY_CONTEXT).tab("tab-1")!));
        source.approved(snapshot);
        return { markdown, made: docStoreCost.resultsStored - stored };
      };
      return { state, source, read };
    };
    return { removed, pendingDocs, sourceOf };
  }

  it("fetches once at its next read, and holds no copy for an approval in between", inStore(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    let { removed, sourceOf } = connection();
    let first = sourceOf("file-a", "First."), second = sourceOf("file-b", "Second.");
    expect(await first.read()).toEqual({ markdown: "First.\n", made: 0 });
    expect(await first.read()).toEqual({ markdown: "First.\n", made: 0 });
    expect(first.state.gets).toBe(1);
    expect(first.source.held()).toBeDefined();

    // Another file's read is approved an hour later: its keep evicts the first file's copy.
    vi.setSystemTime(T + HOUR);
    expect((await second.read()).markdown).toBe("Second.\n");
    expect(removed).toEqual([["file-a", { event: "evicted", reason: "count" }]]);
    expect(running().head("file-a")).toBeUndefined();

    // An approval pinned to that copy falls back to a fetch; the next read fetches, once.
    expect(first.source.held()).toBeUndefined();
    expect(await first.read()).toEqual({ markdown: "First.\n", made: 0 });
    expect(await first.read()).toEqual({ markdown: "First.\n", made: 0 });
    expect(first.state.gets).toBe(2);
    expect(first.source.held()).toBeDefined();
    // That read's keep evicted the other file's copy in turn, whose source fetches as well.
    expect(removed.at(-1)).toEqual(["file-b", { event: "evicted", reason: "count" }]);
    expect(second.source.held()).toBeUndefined();
    expect((await second.read()).markdown).toBe("Second.\n");
    expect(second.state.gets).toBe(2);
  }));

});

/** A whole read of every tab through `source`, approved under a folder: what it answered. */
async function readThrough(source: DriveDocSource): Promise<string> {
  let snapshot = await source.snapshot();
  let markdown = source.read(snapshot, ({ copy }) =>
    copy.outline.map(tab => copy.markdown(copy.tab(tab.tabId)!)).join(""));
  source.approved(snapshot, "folder-of-the-read");
  return markdown;
}

/**
 * What the snapshot `source` approved reaches of `file`, as JSON: a field added to the
 * snapshot, its view or the record fails here until it is listed.
 */
function reached(source: DriveDocSource, file: string): string {
  let snapshot = source.held()!;
  let head = running().head(file)!;
  expect(Object.keys(snapshot)).toEqual(["revisionId", "copy", "fetchedAt"]);
  // The record: the copy, its revision and clocks, landed writes, each tab, the last allowed
  // read's folder and hour, the sweep's digest and the counted bytes.
  expect(Object.keys(head)).toEqual([
    "id", "revision", "fetchedAt", "checkedAt", "stale", "outline", "versions", "writeMarkers",
    "folder", "approvedAt", "made", "bytes",
  ]);
  let { copy } = snapshot;
  // The view: the store and the file's key, the record's outline, and functions.
  expect(Object.entries(copy).filter(([, value]) => typeof value !== "function").map(([key]) => key))
    .toEqual(["stored", "outline"]);
  expect(Object.keys(copy.stored!)).toEqual(["store", "doc"]);
  expect(copy.stored!.store).toBe(running());
  expect(copy.stored!.doc).toBe(file);
  // It names the stored record's copy, and reads each tab by the version that record lists.
  expect(copy.held()).toBe(true);
  expect(copy.outline).toEqual(head.outline);
  expect(copy.outline.map(tab => copy.tab(tab.tabId)!.id)).toEqual(head.versions);
  return JSON.stringify({ revisionId: snapshot.revisionId, fetchedAt: snapshot.fetchedAt, head });
}

// What a connection's memory holds of a document between two requests: the snapshot its source
// approved, which is the copy's record. The document is rows of the store.
describe("a Drive source of a Doc a read approved", () => {
  const T = Date.UTC(2026, 0, 1);
  /** What only the body of the test's documents says: a paragraph, a table's cells, a last line. */
  const BODY = ["Quarterly figures, opening.", "Owner of the task", "Second column", "Closing remark."];
  /** Each of its words of five letters or more. */
  const WORDS = BODY.flatMap(text => text.match(/[A-Za-z]{5,}/g) ?? []);
  const TITLE = "Planning notes";
  /** A revision id of 64 characters. */
  const REVISION = "r".repeat(64);
  /** A document of `tabs` tabs, each titled in 20 characters, whose bodies hold `BODY`. */
  const tabbed = (tabs: number): GoogleDocsDocument => ({
    documentId: "doc-1", title: TITLE, revisionId: REVISION,
    tabs: Array.from({ length: tabs }, (_, at) => ({
      ...buildTab([para(BODY[0]), grid([BODY[1], BODY[2]]), para(BODY[3])]),
      tabId: `t.tab${String(at).padStart(9, "0")}`, title: `Tab ${String(at).padStart(16, "0")}`, index: at,
    })),
  });

  /** A read and write binding, and `open`: its source of `file` with `tabs` tabs, counted in `made`. */
  function binding() {
    let journal = new ActionJournal<DriveAction>(new FakeKv(), { namespace: "drive" });
    let editors = new DriveFileEditors({
      kv: new FakeKv(),
      sheets: {} as GoogleSheetsApi,
      docs: {} as GoogleDocsApi,
      drive: {
        getFile: () => Promise.reject(new Error("No file is read here.")),
        getScopeNodes: () => Promise.reject(new Error("No scope is read here.")),
      },
      journal,
      submit: async () => { throw new Error("Nothing is submitted here."); },
      apply: async () => {},
      reject: async () => {},
      writeRefusal: async () => undefined,
      locate: async () => undefined,
      docStore: running,
    });
    let made = { sources: 0 };
    let open = (file: string, tabs = 1) => editors.docsSource(file, freshness => {
      made.sources++;
      let docsApi = { getDocument: async () => tabbed(tabs) } as unknown as GoogleDocsApi;
      return driveDocSource(docsApi, {} as DriveApi, file, editors.docCopies(file), freshness);
    });
    return { open, made };
  }

  // Under 700 bytes for a tab, and under 165 for each further one.
  it("what a Drive source holds of an approved copy is its record, and no text of the document", inStore(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    let { open, made } = binding();
    let one = open("file-1"), five = open("file-5", 5);
    // The reads answer the body, every tab's.
    let read = await readThrough(one), readWider = await readThrough(five);
    for (let text of BODY) {
      expect(read).toContain(text);
      expect(readWider.split(text)).toHaveLength(6);
    }
    // What the sources hold says none of it, nor the document's title.
    let record = reached(one, "file-1"), wider = reached(five, "file-5");
    for (let text of [...WORDS, TITLE]) {
      expect(record).not.toContain(text);
      expect(wider).not.toContain(text);
    }
    expect(JSON.parse(wider).head.outline).toHaveLength(5);
    expect(record.length).toBeLessThan(700);
    expect((wider.length - record.length) / 4).toBeLessThan(165);
    expect(made.sources).toBe(2);
  }));
});

describe("a Doc read a write lands during", () => {
  // The source checks the writes landed while it fetches, but the session's replay runs after the
  // source has answered: a write landing in between leaves the queue without its edit, and the
  // edits built on it would not replay over the older snapshot.
  it("takes the snapshot again when a write lands after the source answered", inStore(async () => {
    let replace: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "More", newMarkdown: "Final", display: { tab: "x" },
    };
    let pending = [{ id: 1, action: APPEND as GoogleDocAction }, { id: 2, action: replace }];
    let cache = { writes: 0 };
    let invalidated: number[] = [];
    let before = document("Draft");
    let after = {
      ...before, revisionId: "r2",
      tabs: [{ ...buildTab([{ runs: ["Draft\n"] }, { runs: ["More\n"] }]), title: "Main" }],
    };
    let snapshots = 0;
    let docs = new GoogleDocSessionImpl({
      docsApi: {} as GoogleDocsApi,
      driveApi: {} as DriveApi,
      documentId: "doc-1",
      approvalQueue: {} as RpcStub<ApprovalQueue>,
      read: async (fetch, observe) => {
        let value = await fetch();
        observe(value);
        return value;
      },
      changes: {
        pending: () => pending,
        invalidate: ({ id }) => { invalidated.push(id); },
        cache,
        queue: () => Promise.reject(new Error("nothing is queued here")),
        afterTurns: async () => {},
        adoptedTabId: tabId => tabId,
        authorizesPreparation: false,
        simulates: true,
      },
      source: {
        snapshot: async () => {
          snapshots++;
          if (snapshots > 1) return snapshotOf(structuredClone(after));
          // The append lands, and leaves the queue, once the source has answered.
          queueMicrotask(() => { cache.writes++; pending.splice(0, 1); });
          return snapshotOf(structuredClone(before));
        },
        read: (snapshot, use) => use(snapshot),
        approved: () => {},
        metadata: async () => ({ title: "Plan", modifiedAt: 0 }),
        metadataObservation: { title: "t", description: "d" },
      },
    });

    expect(await docs.getContent()).toContain("Final");
    expect(snapshots).toBe(2);
    expect(invalidated).toEqual([]);
  }));

  // Another session's edit can enter the queue there too, checked against a newer revision.
  it("takes the snapshot again when another session queues an edit after the source answered", inStore(async () => {
    let pending: { id: number; action: GoogleDocAction }[] = [];
    let invalidated: number[] = [];
    let before = document("Draft");
    let after = {
      ...before, revisionId: "r2",
      tabs: [{ ...buildTab([{ runs: ["Draft\n"] }, { runs: ["External\n"] }]), title: "Main" }],
    };
    let snapshots = 0;
    let docs = new GoogleDocSessionImpl({
      docsApi: {} as GoogleDocsApi,
      driveApi: {} as DriveApi,
      documentId: "doc-1",
      approvalQueue: {} as RpcStub<ApprovalQueue>,
      read: async (fetch, observe) => {
        let value = await fetch();
        observe(value);
        return value;
      },
      changes: {
        pending: () => pending,
        invalidate: ({ id }) => { invalidated.push(id); },
        cache: { writes: 0 },
        queue: () => Promise.reject(new Error("nothing is queued here")),
        afterTurns: async () => {},
        adoptedTabId: tabId => tabId,
        authorizesPreparation: false,
        simulates: true,
      },
      source: {
        snapshot: async () => {
          snapshots++;
          if (snapshots > 1) return snapshotOf(structuredClone(after));
          queueMicrotask(() => {
            pending.push({ id: 3, action: {
              ...BASE, type: "replaceText", oldMarkdown: "External", newMarkdown: "Final",
              display: { tab: "x" },
            } });
          });
          return snapshotOf(structuredClone(before));
        },
        read: (snapshot, use) => use(snapshot),
        approved: () => {},
        metadata: async () => ({ title: "Plan", modifiedAt: 0 }),
        metadataObservation: { title: "t", description: "d" },
      },
    });

    expect(await docs.getContent()).toContain("Final");
    expect(snapshots).toBe(2);
    expect(invalidated).toEqual([]);
  }));
});
