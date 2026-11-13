import { ActionApplyError } from "@gadgets/gatekeeper-kit/actions";
import { describe, expect, it, vi } from "vitest";
import { DOC_DEFINITIONS, type DocHost } from "../../src/doc-actions";
import type { GoogleDocsDocument } from "../../src/docs-api";
import { MARKDOWN_RENDERING_VERSION } from "../../src/markdown-converter";
import { buildTab } from "../doc-fixture";

type Append = Parameters<typeof DOC_DEFINITIONS.appendText.describe>[0];
type Replace = Parameters<typeof DOC_DEFINITIONS.replaceText.describe>[0];
type AddTab = Parameters<typeof DOC_DEFINITIONS.addTab.describe>[0];

const BASE = {
  tabId: "tab-1", submittedAt: 0, markdownVersion: MARKDOWN_RENDERING_VERSION, writeId: "w-1",
};
const APPEND: Append = { ...BASE, type: "appendText", markdown: "More", display: { tab: "\"Main\" (tab-1)" } };

/** A host over one document whose Docs API is a stub; `landed` and `unapplyable` are recorded. */
function host(document: GoogleDocsDocument, receipt?: { actionId: number; markerId: string }) {
  let api = {
    getDocument: vi.fn(async () => document),
    deleteNamedRange: vi.fn(async () => {}),
    batchUpdate: vi.fn(async () => ({ writeMarkerId: "marker-new", replies: [] })),
  };
  let landed = vi.fn<DocHost["landed"]>();
  let unapplyable = vi.fn<DocHost["unapplyable"]>(async () => {});
  let docHost: DocHost = {
    api: api as unknown as DocHost["api"],
    documentId: "doc-1",
    mimeType: async () => "application/vnd.google-apps.document",
    receipt: () => receipt,
    clearReceipt: () => {},
    saved: () => {},
    landed,
    unapplyable,
  };
  return { api, landed, unapplyable, docHost };
}

function document(text: string): GoogleDocsDocument {
  return {
    documentId: "doc-1", title: "Plan", revisionId: "r1",
    tabs: [{ ...buildTab([{ runs: [`${text}\n`] }]), title: "Main" }],
  };
}

describe("Google Doc edit definitions", () => {
  it("declares text edits and new tabs under their two kinds, applied without a claim", () => {
    for (let [name, definition] of Object.entries(DOC_DEFINITIONS)) {
      expect(definition.kind.tag, name).toBe(name === "addTab" ? "addDocumentTab" : "editDocument");
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

    // A record stored before cards were built from records is never described again.
    expect(() => DOC_DEFINITIONS.appendText.describe({ ...APPEND, display: undefined }, undefined as never))
      .toThrow("This Google Doc edit has no card to show.");
  });

  it("writes an edit once, with a marker, and reports where it landed", async () => {
    let { api, landed, docHost } = host(document("Draft"));
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
    expect(api.batchUpdate).toHaveBeenCalledTimes(1);
    expect(api.batchUpdate.mock.calls[0]).toMatchObject(
      ["doc-1", expect.any(Array), "r1", { name: "gadgets-write-w-1", tabId: "tab-1" }]);
    expect(landed).toHaveBeenCalledWith(
      4, { id: "marker-new", tabId: "tab-1" }, expect.objectContaining({ revisionId: "r1" }), undefined);
  });

  // A connection whose record outlives its receipt, as a Drive binding's does until the kit
  // retires it, can be approved again in between: it must not clean up its own marker first.
  it("settles from a receipt that names the edit, without cleaning up or writing", async () => {
    let { api, landed, docHost } = host(document("Draft"), { actionId: 4, markerId: "marker-old" });
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
    expect(api.deleteNamedRange).not.toHaveBeenCalled();
    expect(api.batchUpdate).not.toHaveBeenCalled();
    expect(landed).toHaveBeenCalledWith(4, undefined, expect.anything());
  });

  it("fails for good an edit that no longer applies, recording why first", async () => {
    let { api, unapplyable, docHost } = host(document("Draft"));
    let replace: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "Gone", newMarkdown: "New", display: { tab: "x" },
    };
    let applied = DOC_DEFINITIONS.replaceText.apply(replace, docHost, { id: 2 });
    await expect(applied).rejects.toBeInstanceOf(ActionApplyError);
    await expect(applied).rejects.toThrow("oldMarkdown was not found");
    expect(unapplyable).toHaveBeenCalledWith(
      2, replace, expect.stringMatching(/^Pending Google Doc edit could not be applied: /),
      expect.anything());
    expect(api.batchUpdate).not.toHaveBeenCalled();
  });
});
