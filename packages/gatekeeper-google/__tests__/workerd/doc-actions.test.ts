import { ActionApplyError } from "@gadgets/gatekeeper-kit/actions";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { RpcStub } from "cloudflare:workers";
import {
  DOC_DEFINITIONS, googleDocSnapshot, type DocHost, type GoogleDocAction,
} from "../../src/doc-actions";
import { GoogleDocSessionImpl, type DocChangeQueue } from "../../src/docs";
import type { GoogleDocsApi, GoogleDocsDocument } from "../../src/docs-api";
import type { DriveApi } from "../../src/drive-api";
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

describe("a Doc edit prepared through a read that is authorized", () => {
  /** A session over "Draft" with `pending` queued, whose next read's authorization runs `during`. */
  function session(pending: { id: number; action: GoogleDocAction }[]) {
    let during: (() => void) | undefined;
    let queued: GoogleDocAction[] = [];
    let document = {
      documentId: "doc-1", title: "Plan", revisionId: "r1",
      tabs: [{ ...buildTab([{ runs: ["Draft\n"] }]), title: "Main" }],
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
        snapshot: async () => googleDocSnapshot(structuredClone(document)),
        approved: () => {},
        metadata: async () => ({ title: "Plan", modifiedAt: 0 }),
        metadataObservation: { title: "t", description: "d" },
      },
    });
    return { docs, queued, decideDuringNextRead: (decide: () => void) => { during = decide; } };
  }

  // The read's authorization is awaited after the check: an edit rejected meanwhile would leave
  // the new one queued against content that will never exist.
  it("is refused when an edit it was checked against is decided meanwhile", async () => {
    let pending = [{ id: 1, action: { ...APPEND, markdown: "More" } }];
    let { docs, queued, decideDuringNextRead } = session(pending);
    decideDuringNextRead(() => pending.splice(0));

    await expect(docs.replaceText("More", "Most")).rejects.toThrow("was approved or rejected");
    expect(queued).toEqual([]);
  });

  // Checked again, the caller's text would be matched over another queue than
  // the one it read, and could name other content: the caller reads again instead.
  it("is refused even where a fresh check over the moved queue would pass", async () => {
    let pending = [{ id: 1, action: { ...APPEND, markdown: "More" } }];
    let { docs, queued, decideDuringNextRead } = session(pending);
    decideDuringNextRead(() => pending.splice(0));

    await expect(docs.replaceText("Draft", "Final")).rejects.toThrow("was approved or rejected");
    expect(queued).toEqual([]);
  });

  it("is queued when nothing it was checked against moved", async () => {
    let pending = [{ id: 1, action: { ...APPEND, markdown: "More" } }];
    let { docs, queued } = session(pending);
    await docs.replaceText("More", "Most");
    expect(queued).toMatchObject([{ type: "replaceText", oldMarkdown: "More", newMarkdown: "Most" }]);
  });
});
