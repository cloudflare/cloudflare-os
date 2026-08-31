import { abortAllDurableObjects, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

type BatchRequest = {
  createNamedRange?: { name: string };
  deleteNamedRange?: { namedRangeId: string };
  insertText?: { location: { index: number }; text: string };
};

/** A batch either carries the edit and its marker, or deletes a marker on its own. */
type BatchKind = "content" | "cleanup";

class DocsModel {
  content = "";
  cleanupFailures = 0;
  ambiguousContentResponses = 0;
  contentBatches = 0;
  maxMarkerCount = 0;
  readonly deletedMarkerIds: string[] = [];
  readonly markers = new Map<string, string>();
  #revision = 1;
  #nextMarkerId = 1;
  readonly #held = new Map<BatchKind, { reach: () => void; released: Promise<void> }>();

  install(): void {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) =>
      this.fetch(input, init)));
  }

  addMarker(name: string, id: string): void {
    this.markers.set(id, name);
    this.#recordMarkerCount();
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
  externalEdit(): void {
    this.content += "collaborator";
    this.#revision++;
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    let url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname !== "docs.googleapis.com") {
      throw new Error(`Unexpected provider request: ${url}`);
    }
    if (!url.pathname.endsWith(":batchUpdate")) return Response.json(this.#document());

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
      if (request.createNamedRange) {
        let id = `marker-${this.#nextMarkerId++}`;
        this.addMarker(request.createNamedRange.name, id);
        replies.push({ createNamedRange: { namedRangeId: id } });
      } else if (request.deleteNamedRange) {
        this.markers.delete(request.deleteNamedRange.namedRangeId);
        this.deletedMarkerIds.push(request.deleteNamedRange.namedRangeId);
        replies.push({});
      } else {
        hasContent = true;
        if (request.insertText) {
          let offset = request.insertText.location.index - 1;
          this.content = this.content.slice(0, offset) + request.insertText.text +
            this.content.slice(offset);
        }
        replies.push({});
      }
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

  #document() {
    let text = `${this.content}\n`;
    let grouped: Record<string, { namedRanges: { namedRangeId: string; name: string }[] }> = {};
    for (const [namedRangeId, name] of this.markers) {
      (grouped[name] ??= { namedRanges: [] }).namedRanges.push({ namedRangeId, name });
    }
    return {
      documentId: "doc-1",
      title: "Test document",
      revisionId: `revision-${this.#revision}`,
      tabs: [{
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
          namedRanges: grouped,
        },
        childTabs: [],
      }],
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

    expect(docs.content).toContain("first");
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

    expect(docs.content).toContain("first");
    expect(docs.content).toContain("second");
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
    expect(docs.content.match(/first/g)).toHaveLength(1);
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
});
