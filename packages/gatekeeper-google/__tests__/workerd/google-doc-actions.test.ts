import { abortAllDurableObjects, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { googleDocActionTab } from "../../src/google";

/** Every write coordinate names the tab it applies to; tab bodies index independently. */
type DocCoordinate = { tabId?: string };

type BatchRequest = {
  createNamedRange?: { name: string; range: DocCoordinate };
  deleteNamedRange?: { namedRangeId: string };
  insertText?: { location: DocCoordinate & { index: number }; text: string };
  deleteContentRange?: { range: DocCoordinate & { startIndex: number; endIndex: number } };
  updateParagraphStyle?: { range: DocCoordinate };
  createParagraphBullets?: { range: DocCoordinate };
  updateTextStyle?: { range: DocCoordinate };
};

/** One tab of the model document: its own text, and its place in the tab tree. */
type ModelTab = { id: string; title: string; parentId?: string; text: string };

/** The tab a single-tab document has, and the one the tab-agnostic tests exercise. */
const MAIN_TAB = "tab-1";

/** A batch either carries the edit and its marker, or deletes a marker on its own. */
type BatchKind = "content" | "cleanup";

class DocsModel {
  cleanupFailures = 0;
  ambiguousContentResponses = 0;
  contentBatches = 0;
  maxMarkerCount = 0;
  /** Google withholds `revisionId` from a caller without edit access. */
  editable = true;
  /** Full `documents.get` calls, excluding the lightweight revision probe. */
  documentFetches = 0;
  revisionProbes = 0;
  driveFetches = 0;
  /** Drive's modification time for the document. */
  driveModifiedTime = "2026-01-02T03:04:05Z";
  /** What Drive answers with instead of that time, if anything. */
  driveFailure: { status: number; reason?: string } | "malformed" | null = null;
  readonly deletedMarkerIds: string[] = [];
  /** Marker ID to its name and owning tab. */
  readonly markers = new Map<string, { name: string; tabId: string }>();
  /** Tab each write marker was anchored in, retained after cleanup deletes the marker. */
  readonly markerTabIds: string[] = [];
  /** Every tab in preorder; the first is the one a single-tab document has. */
  readonly tabs: ModelTab[] = [{ id: MAIN_TAB, title: "Main", text: "" }];
  #revision = 1;
  #nextMarkerId = 1;
  readonly #held = new Map<BatchKind, { reach: () => void; released: Promise<void> }>();

  install(): void {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) =>
      this.fetch(input, init)));
  }

  addMarker(name: string, id: string, tabId = MAIN_TAB): void {
    this.markers.set(id, { name, tabId });
    this.#recordMarkerCount();
  }

  addTab(id: string, title: string, parentId: string, text = ""): void {
    this.tabs.push({ id, title, parentId, text });
  }

  removeTab(id: string): void {
    this.tabs.splice(this.tabs.findIndex(tab => tab.id === id), 1);
    this.#revision++;
  }

  setText(tabId: string, text: string): void {
    this.#tab(tabId).text = text;
  }

  text(tabId = MAIN_TAB): string {
    return this.#tab(tabId).text;
  }

  clearMarkers(): void {
    this.markers.clear();
  }

  /**
   * Holds the next write of `kind` open, so another request can interleave with it mid-flight.
   *
   * `reached` resolves once the provider has the request in hand, before anything is applied.
   */
  hold(kind: BatchKind): { reached: Promise<void>; release: () => void } {
    let reach!: () => void;
    let release!: () => void;
    let reached = new Promise<void>(resolve => { reach = resolve; });
    let released = new Promise<void>(resolve => { release = resolve; });
    this.#held.set(kind, { reach, released });
    return { reached, release };
  }

  /** A collaborator edit: the document changes without this gatekeeper writing to it. */
  externalEdit(tabId = MAIN_TAB, text?: string): void {
    let tab = this.#tab(tabId);
    tab.text = text ?? tab.text + "collaborator";
    this.#revision++;
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    let url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "www.googleapis.com") {
      this.driveFetches++;
      if (this.driveFailure === "malformed") {
        return Response.json({ id: "doc-1", name: "Test document" });
      }
      if (this.driveFailure) {
        let { status, reason } = this.driveFailure;
        return Response.json(
          { error: { code: status, errors: reason ? [{ reason }] : [] } }, { status });
      }
      return Response.json(
        { id: "doc-1", name: "Test document", modifiedTime: this.driveModifiedTime });
    }
    if (url.hostname !== "docs.googleapis.com") {
      throw new Error(`Unexpected provider request: ${url}`);
    }
    if (!url.pathname.endsWith(":batchUpdate")) {
      let fields = url.searchParams.get("fields");
      if (fields === null) this.documentFetches++;
      else if (fields === "revisionId") this.revisionProbes++;
      return Response.json(this.#document());
    }

    let body = JSON.parse(String(init?.body)) as {
      requests: BatchRequest[];
      writeControl?: { requiredRevisionId?: string };
    };
    let isDelete = body.requests.length === 1 && !!body.requests[0].deleteNamedRange;
    await this.#hold(isDelete ? "cleanup" : "content");
    if (isDelete && this.cleanupFailures > 0) {
      this.cleanupFailures--;
      throw new Error("cleanup failed");
    }
    if (body.writeControl?.requiredRevisionId &&
        body.writeControl.requiredRevisionId !== `revision-${this.#revision}`) {
      return Response.json({ error: { code: 400, message: "revision mismatch" } }, { status: 400 });
    }

    let replies: unknown[] = [];
    let hasContent = false;
    for (const request of body.requests) {
      if (request.deleteNamedRange) {
        this.markers.delete(request.deleteNamedRange.namedRangeId);
        this.deletedMarkerIds.push(request.deleteNamedRange.namedRangeId);
        replies.push({});
        continue;
      }

      // Google resolves an unqualified coordinate against a default tab, so a request that omits
      // the ID would edit whichever tab that happens to be.
      let coordinate = request.createNamedRange?.range ?? request.insertText?.location ??
        request.deleteContentRange?.range ?? request.updateParagraphStyle?.range ??
        request.createParagraphBullets?.range ?? request.updateTextStyle?.range;
      if (!coordinate?.tabId) {
        throw new Error(`Google Docs request is missing tabId: ${JSON.stringify(request)}`);
      }
      let tab = this.#tab(coordinate.tabId);

      if (request.createNamedRange) {
        let id = `marker-${this.#nextMarkerId++}`;
        this.addMarker(request.createNamedRange.name, id, tab.id);
        this.markerTabIds.push(tab.id);
        replies.push({ createNamedRange: { namedRangeId: id } });
        continue;
      }

      hasContent = true;
      if (request.insertText) {
        let offset = request.insertText.location.index - 1;
        tab.text = tab.text.slice(0, offset) + request.insertText.text + tab.text.slice(offset);
      } else if (request.deleteContentRange) {
        let { startIndex, endIndex } = request.deleteContentRange.range;
        tab.text = tab.text.slice(0, startIndex - 1) + tab.text.slice(endIndex - 1);
      }
      replies.push({});
    }
    if (hasContent) this.contentBatches++;
    this.#revision++;
    this.#recordMarkerCount();

    if (hasContent && this.ambiguousContentResponses > 0) {
      this.ambiguousContentResponses--;
      throw new Error("content response lost");
    }
    return Response.json({
      replies,
      writeControl: { requiredRevisionId: `revision-${this.#revision}` },
    });
  }

  /** Blocks a held write until the test releases it. One hold, so a retry is never held twice. */
  async #hold(kind: BatchKind): Promise<void> {
    let held = this.#held.get(kind);
    if (!held) return;
    this.#held.delete(kind);
    held.reach();
    await held.released;
  }

  #recordMarkerCount(): void {
    this.maxMarkerCount = Math.max(this.maxMarkerCount, this.markers.size);
  }

  #tab(id: string): ModelTab {
    let tab = this.tabs.find(candidate => candidate.id === id);
    if (!tab) throw new Error(`Google Docs has no tab "${id}"`);
    return tab;
  }

  #documentTab(tab: ModelTab): unknown {
    let text = `${tab.text}\n`;
    let namedRanges: Record<string, { namedRanges: { namedRangeId: string; name: string }[] }> = {};
    for (const [namedRangeId, marker] of this.markers) {
      if (marker.tabId !== tab.id) continue;
      (namedRanges[marker.name] ??= { namedRanges: [] })
        .namedRanges.push({ namedRangeId, name: marker.name });
    }
    return {
      tabProperties: { tabId: tab.id, title: tab.title },
      documentTab: {
        body: {
          content: [{
            startIndex: 1,
            endIndex: text.length + 1,
            paragraph: {
              elements: [{
                startIndex: 1, endIndex: text.length + 1,
                textRun: { content: text, textStyle: {} },
              }],
              paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            },
          }],
        },
        lists: {},
        namedRanges,
      },
      childTabs: this.tabs.filter(child => child.parentId === tab.id)
        .map(child => this.#documentTab(child)),
    };
  }

  #document() {
    return {
      documentId: "doc-1",
      title: "Test document",
      ...this.editable ? { revisionId: `revision-${this.#revision}` } : {},
      tabs: this.tabs.filter(tab => tab.parentId === undefined)
        .map(tab => this.#documentTab(tab)),
    };
  }
}

function hooks() {
  return env.TEST_HOOKS.getByName("hooks");
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Google Doc write receipts", () => {
  it("applies content once and immediately deletes its exact marker", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("normal", "first");

    await hooks().applyAction("normal", actionId);

    expect(docs.text()).toContain("first");
    expect(docs.contentBatches).toBe(1);
    expect(docs.deletedMarkerIds).toEqual(["marker-1"]);
    expect(docs.markers.size).toBe(0);
    expect(await hooks().applyAction("normal", actionId)).toMatch(/Unknown pending/);
  });

  it("reconciles a committed write after its response is lost", async () => {
    let docs = new DocsModel();
    docs.ambiguousContentResponses = 1;
    docs.install();
    let actionId = await hooks().submitAppend("ambiguous", "first");

    expect(await hooks().applyAction("ambiguous", actionId)).toMatch(/content response lost/);
    expect(docs.contentBatches).toBe(1);
    expect(docs.markers.size).toBe(1);

    await hooks().applyAction("ambiguous", actionId);

    expect(docs.contentBatches).toBe(1);
    expect(docs.markers.size).toBe(0);
    expect(await hooks().applyAction("ambiguous", actionId)).toMatch(/Unknown pending/);
  });

  it("cleans a retained receipt after restart before the next write", async () => {
    let docs = new DocsModel();
    docs.cleanupFailures = 1;
    docs.install();
    let firstId = await hooks().submitAppend("restart", "first");
    await hooks().applyAction("restart", firstId);
    expect(docs.markers.size).toBe(1);

    await abortAllDurableObjects();
    let secondId = await hooks().submitAppend("restart", "second");
    await hooks().applyAction("restart", secondId);

    expect(docs.text()).toContain("first");
    expect(docs.text()).toContain("second");
    expect(docs.contentBatches).toBe(2);
    expect(docs.maxMarkerCount).toBe(1);
    expect(docs.markers.size).toBe(0);
  });

  it("keeps the next action pending while receipt cleanup fails", async () => {
    let docs = new DocsModel();
    docs.cleanupFailures = 2;
    docs.install();
    let firstId = await hooks().submitAppend("repeated-cleanup", "first");
    await hooks().applyAction("repeated-cleanup", firstId);
    let secondId = await hooks().submitAppend("repeated-cleanup", "second");

    expect(await hooks().applyAction("repeated-cleanup", secondId)).toMatch(/cleanup failed/);
    expect(docs.contentBatches).toBe(1);
    expect(docs.markers.size).toBe(1);

    await hooks().applyAction("repeated-cleanup", secondId);
    expect(docs.contentBatches).toBe(2);
    expect(docs.markers.size).toBe(0);
  });

  it("fails closed when the current marker name has multiple IDs", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("fixed-write-id");
    let docs = new DocsModel();
    docs.addMarker("gadgets-write-fixed-write-id", "duplicate-1");
    docs.addMarker("gadgets-write-fixed-write-id", "duplicate-2");
    docs.install();
    let actionId = await hooks().submitAppend("duplicates", "first");

    expect(await hooks().applyAction("duplicates", actionId)).toMatch(
      /multiple write markers/,
    );
    expect(docs.contentBatches).toBe(0);

    docs.clearMarkers();
    await hooks().applyAction("duplicates", actionId);
    expect(docs.contentBatches).toBe(1);
  });

  it("rejects an unapplied action without creating a write receipt", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("reject", "first");

    await hooks().rejectAction("reject", actionId);

    expect(docs.contentBatches).toBe(0);
    expect(docs.markers.size).toBe(0);
    expect(await hooks().applyAction("reject", actionId)).toMatch(/Unknown pending/);
  });

  // The overseer marks a record approved only after applyAction() returns, so a second approval of
  // one action can arrive while the first is mid-write. It must not reach the provider at all.
  it("holds a second approval of one action behind the first", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("concurrent", "first");
    let write = docs.hold("content");

    let first = hooks().applyAction("concurrent", actionId);
    await write.reached;
    let second = hooks().applyAction("concurrent", actionId);
    await scheduler.wait(5);
    write.release();

    expect(await first).toBeNull();
    expect(await second).toMatch(/Unknown pending/);
    expect(docs.contentBatches).toBe(1);
    expect(docs.text().match(/first/g)).toHaveLength(1);
    expect(docs.markers.size).toBe(0);
  });

  // Between the handoff and the marker cleanup the edit is committed and its action is gone, so
  // nothing is left to overlay the snapshot the submission cached: it must not be served.
  it("stops serving the pre-write snapshot once the write is committed", async () => {
    let docs = new DocsModel();
    docs.install();
    let actionId = await hooks().submitAppend("cleanup-read", "first");
    let cleanup = docs.hold("cleanup");

    let apply = hooks().applyAction("cleanup-read", actionId);
    await cleanup.reached;
    let content = await hooks().readContent("cleanup-read");
    cleanup.release();

    expect(content).toContain("first");
    expect(await apply).toBeNull();
  });

  it("reads a lost-response append once, not once per replay", async () => {
    let docs = new DocsModel();
    docs.ambiguousContentResponses = 1;
    docs.install();
    let actionId = await hooks().submitAppend("lost-response", "first");
    expect(await hooks().applyAction("lost-response", actionId))
      .toMatch(/content response lost/);
    expect(docs.markers.size).toBe(1);

    // Past the snapshot TTL, so the next read refetches the document -- which holds the append
    // the lost response never confirmed, while its action is still pending.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);

    let content = await hooks().readContent("lost-response");

    expect(content.match(/first/g)).toHaveLength(1);
  });
});

describe("Google Doc metadata", () => {
  it("holds the modification time steady while the document is unchanged", async () => {
    let docs = new DocsModel();
    docs.install();

    let first = await hooks().readMetadata("metadata");
    await scheduler.wait(2);
    let second = await hooks().readMetadata("metadata");

    expect(second).toBe(first);

    docs.externalEdit();
    expect(await hooks().readMetadata("metadata")).toBeGreaterThan(first);
  });

  it("reports a pending edit as the latest modification", async () => {
    let docs = new DocsModel();
    docs.install();
    let baseline = await hooks().readMetadata("metadata-pending");
    await scheduler.wait(2);

    await hooks().submitAppend("metadata-pending", "first");

    expect(await hooks().readMetadata("metadata-pending")).toBeGreaterThan(baseline);
  });

  // Without edit access Google reports no revision, so Drive's own timestamp is the only signal
  // that a collaborator changed anything.
  it("reports Drive's modification time when there is no revision", async () => {
    let docs = new DocsModel();
    docs.editable = false;
    docs.install();

    let first = await hooks().readMetadata("metadata-read-only");
    expect(first).toBe(new Date("2026-01-02T03:04:05Z").valueOf());

    await scheduler.wait(2);
    expect(await hooks().readMetadata("metadata-read-only")).toBe(first);

    docs.driveModifiedTime = "2026-01-02T04:00:00Z";
    expect(await hooks().readMetadata("metadata-read-only"))
      .toBe(new Date("2026-01-02T04:00:00Z").valueOf());
  });

  it("holds the modification time steady when Drive metadata is not granted", async () => {
    let docs = new DocsModel();
    docs.editable = false;
    docs.driveFailure = { status: 403, reason: "insufficientPermissions" };
    docs.install();

    let first = await hooks().readMetadata("metadata-no-drive");
    await scheduler.wait(2);

    expect(await hooks().readMetadata("metadata-no-drive")).toBe(first);
    expect(docs.driveFetches).toBe(2);
  });

  // Dating the document from a transient failure would report it unchanged for as long as Drive
  // stayed unhealthy, and the stored observation would outlive the incident.
  it.each([
    ["an outage", "metadata-drive-outage", { status: 500 }],
    ["a quota refusal", "metadata-drive-quota", { status: 403, reason: "userRateLimitExceeded" }],
    ["a malformed reply", "metadata-drive-malformed", "malformed"],
  ] as const)("fails a metadata read rather than dating a document from %s", async (
    _case, facetName, failure,
  ) => {
    let docs = new DocsModel();
    docs.editable = false;
    docs.driveFailure = failure;
    docs.install();

    await expect(Promise.resolve(hooks().readMetadata(facetName))).rejects.toThrow();

    docs.driveFailure = null;
    expect(await hooks().readMetadata(facetName))
      .toBe(new Date("2026-01-02T03:04:05Z").valueOf());
  });
});

// Google withholds revisionId from a caller without edit access, which is the ordinary case for
// a Doc shared read-only.
describe("Google Doc with no revision ID", () => {
  it("reuses its snapshot inside the TTL and refetches once expired", async () => {
    let docs = new DocsModel();
    docs.editable = false;
    docs.install();

    await hooks().readContent("no-revision");
    await hooks().readContent("no-revision");
    expect(docs.documentFetches).toBe(1);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    docs.externalEdit(MAIN_TAB, "collaborator edit");

    expect(await hooks().readContent("no-revision")).toContain("collaborator edit");
    expect(docs.documentFetches).toBe(2);
    // Nothing to compare, so the probe is not worth a request.
    expect(docs.revisionProbes).toBe(0);
  });
});

/** A nested document whose three tabs all hold the same text, so an edit cannot be mistaken. */
function nestedDocs(): DocsModel {
  let docs = new DocsModel();
  docs.setText(MAIN_TAB, "shared");
  docs.addTab("details", "Details", MAIN_TAB, "shared");
  docs.addTab("metrics", "Metrics", "details", "shared");
  docs.install();
  return docs;
}

describe("Google Doc tab isolation", () => {
  it("lists the tab tree and appends only to the tab it names", async () => {
    let docs = nestedDocs();

    expect(await hooks().listTabs("tabs-append")).toEqual([
      { id: MAIN_TAB, title: "Main", index: 0, nestingLevel: 0 },
      { id: "details", title: "Details", parentTabId: MAIN_TAB, index: 0, nestingLevel: 1 },
      { id: "metrics", title: "Metrics", parentTabId: "details", index: 0, nestingLevel: 2 },
    ]);

    let actionId = await hooks().submitAppend("tabs-append", "added", "metrics");
    expect(await hooks().readContent("tabs-append", "metrics")).toContain("added");
    expect(await hooks().readContent("tabs-append", MAIN_TAB)).not.toContain("added");

    expect(await hooks().applyAction("tabs-append", actionId)).toBeNull();

    // The marker must be anchored in the tab that was edited: a marker left in another tab is
    // invisible to the retry lookup, which would re-apply the write after a lost response.
    expect(docs.markerTabIds).toEqual(["metrics"]);
    expect(docs.text("metrics")).toContain("added");
    expect(docs.text(MAIN_TAB)).toBe("shared");
    expect(docs.text("details")).toBe("shared");
  });

  it("replaces identical text in the selected tab only", async () => {
    let docs = nestedDocs();
    let actionId = await hooks().submitReplace("tabs-replace", "shared", "changed", "metrics");

    expect(await hooks().applyAction("tabs-replace", actionId)).toBeNull();

    expect(docs.markerTabIds).toEqual(["metrics"]);
    expect(docs.text("metrics")).toBe("changed");
    expect(docs.text(MAIN_TAB)).toBe("shared");
    expect(docs.text("details")).toBe("shared");
  });

  it("submits nothing for an omitted or unknown tab", async () => {
    let docs = nestedDocs();

    await expect(Promise.resolve(hooks().submitAppend("tabs-selector", "added")))
      .rejects.toThrow(/tabId is required for documents with multiple tabs/);
    await expect(Promise.resolve(
      hooks().submitReplace("tabs-selector", "shared", "changed", "ghost"),
    )).rejects.toThrow(/no tab with ID "ghost"/);

    expect(docs.contentBatches).toBe(0);
    expect(docs.text("metrics")).toBe("shared");
  });

  // A failed edit still tells the caller whether a tab, or the text in it, exists. Leaving the
  // write paths ungated would let a caller ask through appendText what getContent refuses.
  const GENERIC_READ = "Read the content of one tab of the document.";

  it.each([
    ["an omitted tab", () => hooks().submitAppend("tabs-write-oracle", "added"),
      /tabId is required for documents with multiple tabs/],
    ["an unknown tab", () => hooks().submitAppend("tabs-write-oracle", "added", "ghost"),
      /no tab with ID "ghost"/],
    ["unmatched text",
      () => hooks().submitReplace("tabs-write-oracle", "absent", "changed", "metrics"),
      /was not found in the current simulated tab/],
  ] as const)("authorizes a generic observation when an edit fails on %s", async (
    _case, submit, message,
  ) => {
    let docs = nestedDocs();

    await expect(Promise.resolve(submit())).rejects.toThrow(message);

    expect(await hooks().lastObservations).toEqual([GENERIC_READ]);
    expect(docs.contentBatches).toBe(0);
  });

  it("is not suppressed by a same-named write marker in another tab", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("fixed-write-id");
    let docs = nestedDocs();
    docs.addMarker("gadgets-write-fixed-write-id", "other-1", MAIN_TAB);

    let actionId = await hooks().submitAppend("tabs-foreign-marker", "added", "metrics");
    expect(await hooks().applyAction("tabs-foreign-marker", actionId)).toBeNull();

    expect(docs.contentBatches).toBe(1);
    expect(docs.text("metrics")).toContain("added");
    expect(docs.text(MAIN_TAB)).toBe("shared");
  });

  it("refuses an edit whose tab is deleted before approval", async () => {
    let docs = nestedDocs();
    let actionId = await hooks().submitAppend("tabs-deleted", "added", "metrics");

    docs.removeTab("metrics");
    expect(await hooks().applyAction("tabs-deleted", actionId)).toBe(
      'appendText: no tab with ID "metrics" exists in this document. ' +
      "Call listTabs() to refresh the tab list.");

    // Approving it again must not report success for a write that never happened, and must not
    // decay into "unknown action" either — rejecting is the way out.
    let repeated = "Pending Google Doc edit could not be applied: " +
      'appendText: no tab with ID "metrics" exists in this document. ' +
      "Call listTabs() to refresh the tab list.";
    expect(await hooks().applyAction("tabs-deleted", actionId)).toBe(repeated);
    expect(await hooks().applyAction("tabs-deleted", actionId)).toBe(repeated);

    expect(docs.contentBatches).toBe(0);
    expect(docs.text(MAIN_TAB)).toBe("shared");
    expect(docs.text("details")).toBe("shared");
  });

  // Actions are approved in one global order, but each replays against only its own tab, so
  // neither edit may shift or shadow the other.
  it("replays edits queued on different tabs independently", async () => {
    let docs = nestedDocs();
    let metricsId = await hooks().submitAppend("tabs-interleaved", "alpha", "metrics");
    let mainId = await hooks().submitAppend("tabs-interleaved", "beta", MAIN_TAB);

    let metricsPreview = await hooks().readContent("tabs-interleaved", "metrics");
    let mainPreview = await hooks().readContent("tabs-interleaved", MAIN_TAB);
    expect(metricsPreview).toContain("alpha");
    expect(metricsPreview).not.toContain("beta");
    expect(mainPreview).toContain("beta");
    expect(mainPreview).not.toContain("alpha");

    expect(await hooks().applyAction("tabs-interleaved", metricsId)).toBeNull();
    expect(await hooks().applyAction("tabs-interleaved", mainId)).toBeNull();

    expect(docs.text("metrics")).toBe("shared\nalpha");
    expect(docs.text(MAIN_TAB)).toBe("shared\nbeta");
    expect(docs.text("details")).toBe("shared");
  });

  it("invalidates only the edit whose own tab moved", async () => {
    let docs = nestedDocs();
    await hooks().submitReplace("tabs-invalidate", "shared", "changed", "metrics");
    let mainId = await hooks().submitAppend("tabs-invalidate", "beta", MAIN_TAB);

    // A collaborator rewrites Metrics, so the replace no longer matches. The append targets a
    // different tab whose text never moved, so it must survive and stop waiting behind it.
    docs.externalEdit("metrics", "rewritten");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);

    let metricsPreview = await hooks().readContent("tabs-invalidate", "metrics");
    expect(metricsPreview).not.toContain("changed");
    expect(metricsPreview).not.toContain("beta");
    expect(await hooks().readContent("tabs-invalidate", MAIN_TAB)).toContain("beta");

    expect(await hooks().applyAction("tabs-invalidate", mainId)).toBeNull();

    expect(docs.text(MAIN_TAB)).toBe("shared\nbeta");
    expect(docs.text("metrics")).toBe("rewritten");
  });

  // Titles are user-authored, need not be unique and may be empty, so the approval a user
  // consents to has to carry the ID the write actually targets.
  it("names the target tab by ID when two tabs share a title", async () => {
    let docs = new DocsModel();
    docs.setText(MAIN_TAB, "shared");
    docs.addTab("notes-a", "Notes", MAIN_TAB, "shared");
    docs.addTab("notes-b", "Notes", MAIN_TAB, "shared");
    docs.install();

    await hooks().submitAppend("tabs-duplicate-title", "added", "notes-b");

    expect(await hooks().lastActionDescription).toContain('tab "Notes" (notes-b)');
  });
});

// A stored edit with no tab predates tab support. No current write path produces one, so this is
// the only place the migration refusal can be reached.
describe("Google Doc edits stored before tab support", () => {
  function tabSnapshot(tabId: string, title: string) {
    return {
      tabId, title, index: 0, nestingLevel: 0,
      markdown: "shared\n", sourceMap: { blocks: [] }, bodyEndIndex: 8,
      committedWriteIds: [],
    };
  }

  const snapshot = {
    title: "Test document",
    revisionId: "revision-1",
    tabs: [tabSnapshot(MAIN_TAB, "Main")],
    fetchedAt: 0,
  };

  const storedAppend = {
    type: "appendText" as const,
    documentId: "doc-1",
    submittedAt: 0,
    baseRevisionId: "revision-1",
    markdown: "added",
  };

  // The old code refused to read a multi-tab document, so a stored record was approved against
  // the one tab such a document had.
  it("retargets a record naming no tab when the document still has exactly one", () => {
    expect(googleDocActionTab(snapshot, storedAppend).tabId).toBe(MAIN_TAB);
  });

  it("refuses a record naming no tab once the document has gained tabs", () => {
    let grown = { ...snapshot, tabs: [...snapshot.tabs, tabSnapshot("second", "Second")] };
    expect(() => googleDocActionTab(grown, storedAppend)).toThrow(
      "Pending Google Doc edit predates tab support and the document has gained tabs since, " +
      "so the tab it was approved against is unknown. Reject it and retry on a selected tab.");
  });

  it("refuses a vanished tab rather than retargeting to the first", () => {
    expect(() => googleDocActionTab(snapshot, { ...storedAppend, tabId: "ghost" })).toThrow(
      'appendText: no tab with ID "ghost" exists in this document. ' +
      "Call listTabs() to refresh the tab list.");
  });

  it("resolves a record that names a live tab", () => {
    expect(googleDocActionTab(snapshot, { ...storedAppend, tabId: MAIN_TAB }).title).toBe("Main");
  });
});
