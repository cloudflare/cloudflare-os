// Applying and reverting SharePoint actions against a fake Graph at `fetch`: what each kind sends,
// which failures are final, what a crash may replay, and the proofs an apply makes before writing.

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionApplyError, ActionOutcomeUnknownError } from "@gadgets/gatekeeper-kit/actions";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot } from "@gadgets/observability/metrics";
import { ProvisionalIds, type SimulationKv } from "@gadgets/gatekeeper-kit/simulation";
import { GraphApi, GraphApiError } from "../src/graph-api";
import {
  definitions, revert, shownChanges, shownTexts, type FolderTarget, type ItemTarget, type SharePointActionHost, type SharePointActions,
} from "../src/sharepoint-actions";
import { OutsideScopeError, type ItemRef } from "../src/sharepoint-scope";
import { countedCalls } from "./points";

const DRIVE = "b!AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SPECS: FolderTarget = { id: `${DRIVE}/SPECS`, driveId: DRIVE, name: "Specs", location: "Engineering › Documents", path: "" };
const ARCHIVE: FolderTarget = { id: `${DRIVE}/ARCHIVE`, driveId: DRIVE, name: "Archive", location: "Engineering › Documents › Archive", path: "Archive" };
const NOTES: ItemTarget = { ref: { driveId: DRIVE, itemId: "NOTES" }, name: "notes.txt", kind: "file", location: "Engineering › Documents › Specs", path: "notes.txt" };
const FILE = { handle: "h1", size: 9, digest: "d1" };
const MONITOR = "https://contoso.sharepoint.com/_api/v2.0/monitor/copy-1";

/**
 * A scripted reply. A status of -1 is a dropped connection, `after` the milliseconds the answer
 * takes to come, and `stalls` an answer whose body never comes: the reading of it fails once the
 * request's signal aborts.
 */
type Reply = { status: number; body?: unknown; headers?: Record<string, string>; after?: number; stalls?: true };
type Sent = { method: string; path: string; body?: unknown; ifMatch: string | null };

/** The reply of a host that never answers: the request fails once its signal aborts, as `fetch` fails one. */
const unanswered: Reply = { status: -2 };

/** The reply that a copy is still running, which takes `after` milliseconds to come. */
const slowProgress = (after: number): Reply => ({ status: 202, body: { status: "inProgress" }, after });

/** Fails once `signal` aborts, with the reason of the abort. */
function untilAborted(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
}

/**
 * A Graph that answers each request with the next scripted reply, recording what was sent, and when.
 * A request whose signal has aborted is failed unsent, as `fetch` fails one. `reaching` is the
 * milliseconds the host takes to reach Graph, as one that loads a credential first does.
 */
function harness(replies: Reply[] = [], options: { outside?: string[]; reaching?: number } = {}) {
  const sent: Sent[] = [];
  const sentAt: number[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    const url = new URL(String(input));
    sent.push({
      method: init?.method ?? "GET", path: `${url.pathname.replace(/^\/v1\.0/, "")}${url.search}`,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body, ifMatch: new Headers(init?.headers).get("if-match"),
    });
    sentAt.push(Date.now());
    const reply = replies.shift() ?? { status: 204 };
    if (reply.status === -1) throw new Error("the connection dropped");
    if (reply === unanswered) return await untilAborted(init?.signal);
    const { after } = reply;
    if (after !== undefined) await Promise.race([new Promise(resolve => setTimeout(resolve, after)), untilAborted(init?.signal)]);
    const stalled = new ReadableStream({
      start: controller => init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason)),
    });
    return new Response(reply.status === 204 ? null : reply.stalls ? stalled : JSON.stringify(reply.body ?? {}), {
      status: reply.status, headers: { "content-type": "application/json", ...reply.headers },
    });
  };
  const api = new GraphApi("token", { fetch });
  const store = new Map<string, unknown>();
  const kv = {
    get: (key: string) => store.get(key), put: (key: string, value: unknown) => { store.set(key, value); },
    delete: (key: string) => store.delete(key), list: () => store.entries(),
  } as unknown as SimulationKv;
  const released: string[] = [];
  const host: SharePointActionHost = {
    refs: new ProvisionalIds<string>(kv, { namespace: "refs:", isProvisional: id => id.startsWith("~") }),
    graph: op => {
      const { reaching } = options;
      if (reaching === undefined) return op(api);
      return new Promise(resolve => setTimeout(resolve, reaching)).then(() => op(api));
    },
    inScope: async (ref: ItemRef) => {
      if (options.outside?.includes(ref.itemId)) throw new OutsideScopeError();
    },
    readFile: async () => new TextEncoder().encode("new text\n"),
    releaseFile: file => { released.push(file.handle); },
    invalidate: async () => {},
  };
  return { host, sent, sentAt, released };
}

/** Makes `AbortSignal.timeout` run on the fake clock, which does not reach the platform's own. */
function fakeTimeouts() {
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
    return controller.signal;
  });
}

/** The dataset the metrics write to, and the switch that has subservice calls written to it. */
const ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };

/** Has every call to Graph written as a point, and returns the points as they are written. */
function recordedPoints(): AnalyticsEngineDataPoint[] {
  const points: AnalyticsEngineDataPoint[] = [];
  ambient.METRICS = { writeDataPoint: point => { if (point) points.push(point); } };
  ambient.SUBSERVICE_METRICS = "true";
  return points;
}

/** A written point's value in one column. */
function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

/** The operation a written point counts. */
const operationOf = (point: AnalyticsEngineDataPoint) => column(point, SUBSERVICE_V1_SLOTS.operation);

const item = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, webUrl: `https://contoso.sharepoint.com/${id}`, parentReference: { driveId: DRIVE, id: "SPECS" }, eTag: `"{${id}},2"`, cTag: `"c:{${id}},2"`, ...extra });
const nameTaken = { status: 409, body: { error: { code: "nameAlreadyExists", message: "The specified item name already exists." } } };
const versions = { status: 200, body: { value: [{ id: "3.0" }, { id: "2.0" }] } };
const named = (name: string) => ({ status: 200, body: { name } });

afterEach(() => {
  delete ambient.METRICS;
  delete ambient.SUBSERVICE_METRICS;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("creating", () => {
  const payload: SharePointActions["createFolder"] = { ref: "~1", parent: SPECS, name: "Drafts", submittedAt: 1 };

  it("posts the folder with conflicts refused, and binds the temporary ID to the new item", async () => {
    const { host, sent } = harness([{ status: 201, body: item("NEW", { folder: {} }) }]);
    const { action } = await definitions.createFolder.apply(payload, host);
    expect(sent).toEqual([{
      method: "POST", path: `/drives/${DRIVE}/items/SPECS/children`, ifMatch: null,
      body: { name: "Drafts", folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
    }]);
    expect(action).toMatchObject({ createdId: "NEW" });
    expect(host.refs.resolve("~1")).toBe(`${DRIVE}/NEW`);
  });

  it("is claimed, and fails finally on a name taken rather than adopting whatever holds it", async () => {
    const { host, sent } = harness([nameTaken]);
    expect(definitions.createFolder.claimBeforeApply).toBe(true);
    await expect(definitions.createFolder.apply(payload, host)).rejects.toThrow(ActionApplyError);
    expect(sent).toHaveLength(1);
    expect(host.refs.isResolved("~1")).toBe(false);
  });

  it("keeps an upload whose content tag couldn't be read afterwards, and won't undo it blind", async () => {
    const upload = { ...payload, file: FILE, name: "book.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", writing: { as: "excel" as const } };
    // The read of the content tag is a GET, so it is sent three times before it is given up.
    const dropped = { status: -1 };
    const { host, released } = harness([{ status: 201, body: item("NEW", { file: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, size: 9, cTag: "c-up" }) }, { status: 204 }, dropped, dropped, dropped]);
    vi.useFakeTimers();
    const applying = definitions.uploadFile.apply(upload, host);
    await vi.advanceTimersByTimeAsync(2_000);
    const { action } = await applying;
    expect(action).toMatchObject({ createdId: "NEW" });
    expect(action.cTag).toBeUndefined();
    expect(released).toEqual([FILE.handle]);
    const undone = harness();
    expect(await revert({ kind: "uploadFile", payload: action }, undone.host)).toMatchObject({ canRetry: false, message: expect.stringMatching(/didn't say which version/) });
    expect(undone.sent).toEqual([]);
  });

  it("undoes an upload only while the file still holds what it uploaded", async () => {
    const upload = { ...payload, file: FILE, mimeType: "text/plain" };
    const { host } = harness([{ status: 201, body: item("NEW", { file: { mimeType: "text/plain" }, size: 9, cTag: "c-up" }) }]);
    const { action } = await definitions.uploadFile.apply(upload, host);
    expect(action).toMatchObject({ createdId: "NEW", cTag: "c-up" });
    const edited = harness([{ status: 200, body: { cTag: "c-edited" } }]);
    expect(await revert({ kind: "uploadFile", payload: action }, edited.host)).toMatchObject({ canRetry: false, message: expect.stringMatching(/changed since it was created/) });
    expect(edited.sent.map(request => request.method)).toEqual(["GET"]);
    const same = harness([{ status: 200, body: { cTag: "c-up" } }, { status: 204 }]);
    expect(await revert({ kind: "uploadFile", payload: action }, same.host)).toBeUndefined();
    expect(same.sent.map(request => request.method)).toEqual(["GET", "DELETE"]);
  });

  it("refuses, finally, a parent that has since left the binding, before anything is sent", async () => {
    const { host, sent } = harness([], { outside: ["SPECS"] });
    await expect(definitions.createFolder.apply(payload, host)).rejects.toThrow(/no longer inside what this connection covers/);
    await expect(definitions.uploadFile.apply({ ...payload, file: FILE, mimeType: "text/plain" }, host)).rejects.toThrow(ActionApplyError);
    expect(sent).toEqual([]);
  });

  it("reverts a creation by deleting what it made, and nothing when nothing was made", async () => {
    const { host, sent } = harness([{ status: 200, body: { folder: { childCount: 0 } } }]);
    await revert({ kind: "createFolder", payload: { ...payload, createdId: "NEW" } }, host);
    expect(sent.map(request => `${request.method} ${request.path}`)).toEqual([`GET /drives/${DRIVE}/items/NEW?%24select=folder`, `DELETE /drives/${DRIVE}/items/NEW`]);
    expect(await revert({ kind: "createFolder", payload }, host)).toMatchObject({ canRetry: false });
  });

  it("leaves a created folder that has gained contents since, which were never part of the action", async () => {
    const { host, sent } = harness([{ status: 200, body: { folder: { childCount: 2 } } }]);
    expect(await revert({ kind: "createFolder", payload: { ...payload, createdId: "NEW" } }, host))
      .toEqual({ message: expect.stringContaining("isn't empty anymore"), canRetry: true });
    expect(sent.map(request => request.method)).toEqual(["GET"]);
    const gone = harness([{ status: 404, body: { error: { code: "itemNotFound", message: "x" } } }]);
    expect(await revert({ kind: "createFolder", payload: { ...payload, createdId: "NEW" } }, gone.host)).toBeUndefined();
    expect(gone.sent.map(request => request.method)).toEqual(["GET"]);
  });

  it("won't undo a creation once what it made has been moved out of the binding", async () => {
    const { host, sent } = harness([], { outside: ["NEW"] });
    expect(await revert({ kind: "createFolder", payload: { ...payload, createdId: "NEW" } }, host))
      .toEqual({ message: expect.stringContaining("no longer inside what this connection covers"), canRetry: false });
    expect(sent).toEqual([]);
  });
});

describe("adding a list item", () => {
  const payload: SharePointActions["createListItem"] = {
    ref: "~1", list: { siteId: "contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,33333333-3333-3333-3333-333333333333", listId: "44444444-4444-4444-4444-444444444444", name: "Tasks" },
    fields: { Title: "Ship it" }, labels: { Title: "Title" }, submittedAt: 1,
  };

  it("undoes a field change fenced on the version the change left, so later edits stay", async () => {
    const change: SharePointActions["updateListItem"] = {
      list: payload.list, itemId: "7", fields: { Title: "Agent title" }, labels: { Title: "Title" }, before: { Title: "Original" }, ifMatch: '"e1"', submittedAt: 1,
    };
    const { host, sent } = harness([{ status: 200, body: { "@odata.etag": '"e2"', Title: "Agent title" } }]);
    const { action } = await definitions.updateListItem.apply(change, host);
    expect(sent[0]).toMatchObject({ method: "PATCH", ifMatch: '"e1"' });
    expect(action.appliedETag).toBe('"e2"');
    const back = harness([{ status: 200, body: {} }]);
    expect(await revert({ kind: "updateListItem", payload: action }, back.host)).toBeUndefined();
    expect(back.sent[0]).toMatchObject({ method: "PATCH", ifMatch: '"e2"', body: { Title: "Original" } });
    const edited = harness([{ status: 412, body: { error: { code: "resourceModified", message: "ETag mismatch" } } }]);
    expect(await revert({ kind: "updateListItem", payload: action }, edited.host)).toMatchObject({ message: expect.stringContaining("changed since"), canRetry: false });
    const unknown = harness([]);
    expect(await revert({ kind: "updateListItem", payload: change }, unknown.host)).toMatchObject({ message: expect.stringContaining("which version"), canRetry: false });
    expect(unknown.sent).toEqual([]);
  });

  it("undoes adding an item only while it is still as created, since later edits were never part of the action", async () => {
    const { host } = harness([{ status: 201, body: { id: "9", eTag: '"e1"', fields: { Title: "Ship it" } } }]);
    const { action } = await definitions.createListItem.apply(payload, host);
    expect(action).toMatchObject({ createdId: "9", createdETag: '"e1"' });
    const same = harness([{ status: 200, body: { id: "9", eTag: '"e1"' } }, { status: 204 }]);
    expect(await revert({ kind: "createListItem", payload: action }, same.host)).toBeUndefined();
    expect(same.sent.map(request => request.method)).toEqual(["GET", "DELETE"]);
    const edited = harness([{ status: 200, body: { id: "9", "@odata.etag": '"e2"' } }]);
    expect(await revert({ kind: "createListItem", payload: action }, edited.host)).toMatchObject({ canRetry: false, message: expect.stringMatching(/changed since it was created/) });
    expect(edited.sent.map(request => request.method)).toEqual(["GET"]);
    const unknown = harness([]);
    expect(await revert({ kind: "createListItem", payload: { ...action, createdETag: undefined } }, unknown.host)).toMatchObject({ canRetry: false, message: expect.stringMatching(/which version/) });
    expect(unknown.sent).toEqual([]);
  });

  it("won't add the item again when SharePoint's answer to adding it was lost, since nothing would find the first", async () => {
    const { host } = harness([{ status: -1 }]);
    await expect(definitions.createListItem.apply(payload, host)).rejects.toBeInstanceOf(ActionOutcomeUnknownError);
    const refused = harness([{ status: 400, body: { error: { code: "invalidRequest", message: "bad field" } } }]);
    await expect(definitions.createListItem.apply(payload, refused.host)).rejects.toBeInstanceOf(ActionApplyError);
  });
});

describe("replacing content", () => {
  const payload: SharePointActions["replaceFile"] = { target: NOTES, file: FILE, mimeType: "text/plain", ifMatch: `"c:{NOTES},2"`, submittedAt: 1 };

  it("restores the earlier version only over the content it wrote, since restoring replaces the whole file", async () => {
    const { host } = harness([named("notes.txt"), versions, { status: 200, body: item("NOTES", { cTag: "c-written" }) }]);
    const { action } = await definitions.replaceFile.apply(payload, host);
    expect(action.cTag).toBe("c-written");
    const same = harness([{ status: 200, body: { cTag: "c-written" } }, { status: 204 }]);
    expect(await revert({ kind: "replaceFile", payload: action }, same.host)).toBeUndefined();
    expect(same.sent.map(request => request.method)).toEqual(["GET", "POST"]);
    const changed = harness([{ status: 200, body: { cTag: "c-later" } }]);
    expect(await revert({ kind: "replaceFile", payload: action }, changed.host)).toMatchObject({ canRetry: false, message: expect.stringMatching(/has changed since this edit/) });
    expect(changed.sent.map(request => request.method)).toEqual(["GET"]);
  });

  it("says an in-place edit's description is incomplete once changes are left out of it", () => {
    const change = { before: "old", after: "new" };
    const shown = definitions.replaceFile.describe({ ...payload, edit: { kind: "document", changes: [change] } });
    expect(shown.descriptionIsComplete).toBe(true);
    const more = definitions.replaceFile.describe({ ...payload, edit: { kind: "document", changes: [change], more: 3 } });
    expect(more.descriptionIsComplete).toBeUndefined();
  });

  it("records the version it supersedes, writes under the content fence, and releases the bytes", async () => {
    const { host, sent, released } = harness([named("notes.txt"), versions, { status: 200, body: item("NOTES") }]);
    const { action } = await definitions.replaceFile.apply(payload, host);
    expect(sent.map(request => [request.method, request.path, request.ifMatch])).toEqual([
      ["GET", `/drives/${DRIVE}/items/NOTES?%24select=name`, null],
      ["GET", `/drives/${DRIVE}/items/NOTES/versions?%24top=1`, null],
      ["PUT", `/drives/${DRIVE}/items/NOTES/content`, `"c:{NOTES},2"`],
    ]);
    expect(action).toMatchObject({ previousVersionId: "3.0" });
    expect(released).toEqual(["h1"]);
  });

  it("is claimed, since its own write moves the tag a replay would fence on", () => {
    expect(definitions.replaceFile.claimBeforeApply).toBe(true);
    expect(definitions.updateCells.claimBeforeApply).toBe(true);
  });

  it("fails finally when the file changed since it was proposed", async () => {
    const { host, released } = harness([named("notes.txt"), versions, { status: 412, body: { error: { code: "notAllowed", message: "ETag mismatch" } } }]);
    await expect(definitions.replaceFile.apply(payload, host)).rejects.toThrow(/changed after this was proposed/);
    expect(released).toEqual([]);
  });

  it("refuses bytes checked as one format for a file since renamed into another, which a rename's unchanged content tag wouldn't catch", async () => {
    const { host, sent } = harness([named("report.xlsx")]);
    await expect(definitions.replaceFile.apply({ ...payload, target: { ...NOTES, name: "report.zip" } }, host)).rejects.toThrow(/renamed into another format/);
    expect(sent.map(request => request.method)).toEqual(["GET"]);
    const same = harness([named("Report.ZIP"), versions, { status: 200, body: item("NOTES") }]);
    await definitions.replaceFile.apply({ ...payload, target: { ...NOTES, name: "report.zip" } }, same.host);
    expect(same.sent.map(request => request.method)).toEqual(["GET", "GET", "PUT"]);
  });

  it("refuses a file that has since left the binding without reading its bytes", async () => {
    const { host, sent } = harness([], { outside: ["NOTES"] });
    await expect(definitions.replaceFile.apply(payload, host)).rejects.toThrow(ActionApplyError);
    await expect(definitions.deleteItem.apply({ target: NOTES, submittedAt: 1 }, host)).rejects.toThrow(ActionApplyError);
    await expect(definitions.rename.apply({ target: NOTES, name: "n.txt", submittedAt: 1 }, host)).rejects.toThrow(ActionApplyError);
    expect(sent).toEqual([]);
  });
});

describe("moving", () => {
  const payload: SharePointActions["move"] = { target: NOTES, from: { id: SPECS.id, location: SPECS.location }, to: ARCHIVE, submittedAt: 1 };

  it("re-proves the file and the destination are inside the binding, since a move leaves the fence intact", async () => {
    const { host, sent } = harness([], { outside: ["ARCHIVE"] });
    await expect(definitions.move.apply(payload, host)).rejects.toThrow(/no longer inside what this connection covers/);
    expect(sent).toEqual([]);
    const fine = harness([{ status: 200, body: item("NOTES") }]);
    await definitions.move.apply(payload, fine.host);
    expect(fine.sent[0]).toMatchObject({ method: "PATCH", body: { parentReference: { id: "ARCHIVE" } } });
  });
});

describe("updating cells", () => {
  const payload: SharePointActions["updateCells"] = {
    target: NOTES, worksheet: "Costs", sheetId: "{00000000-0001-0000-0000-000000000000}", address: "B2:C2",
    values: [["=SUM(B3:B9)", null]], before: [[1, 2]], ifMatch: `"c:{NOTES},2"`, submittedAt: 1,
  };

  it("checks the fence itself, then writes the range by worksheet ID, nulls as empty", async () => {
    const { host, sent } = harness([{ status: 200, body: item("NOTES") }, versions, { status: 200, body: {} }]);
    const { action } = await definitions.updateCells.apply(payload, host);
    expect(sent[2]).toMatchObject({
      method: "PATCH",
      path: `/drives/${DRIVE}/items/NOTES/workbook/worksheets/%7B00000000-0001-0000-0000-000000000000%7D/range(address='B2:C2')`,
      body: { formulas: [["=SUM(B3:B9)", ""]] },
    });
    expect(action).toMatchObject({ previousVersionId: "3.0" });
  });

  it("undoes a write over what Excel made of it, since a date typed as text comes back a number and a formula uppercased", async () => {
    const typed = { ...payload, values: [["=sum(b3:b9)", "2026-01-02"]] };
    const { host } = harness([{ status: 200, body: item("NOTES") }, versions, { status: 200, body: { formulas: [["=SUM(B3:B9)", 46024]] } }]);
    const { action } = await definitions.updateCells.apply(typed, host);
    expect(action.applied).toEqual([["=SUM(B3:B9)", 46024]]);
    const same = harness([{ status: 200, body: { formulas: [["=SUM(B3:B9)", 46024]] } }, { status: 200, body: {} }]);
    expect(await revert({ kind: "updateCells", payload: action }, same.host)).toBeUndefined();
    expect(same.sent.map(request => request.method)).toEqual(["GET", "PATCH"]);
    const changed = harness([{ status: 200, body: { formulas: [["=SUM(B3:B10)", 46024]] } }]);
    expect(await revert({ kind: "updateCells", payload: action }, changed.host)).toMatchObject({ canRetry: false, message: expect.stringMatching(/has changed since this edit/) });
    // Excel answering in another shape leaves the write as proposed to compare against.
    const odd = harness([{ status: 200, body: item("NOTES") }, versions, { status: 200, body: { formulas: [["=SUM(B3:B9)"]] } }]);
    expect((await definitions.updateCells.apply(typed, odd.host)).action.applied).toBeUndefined();
  });

  it("fails finally when the workbook's tag moved", async () => {
    const { host, sent } = harness([{ status: 200, body: item("NOTES", { cTag: `"c:{NOTES},3"` }) }]);
    await expect(definitions.updateCells.apply(payload, host)).rejects.toThrow(/changed after this was proposed/);
    expect(sent).toHaveLength(1);
  });

  it("undoes only the range, and only while it still holds what was written, rather than restoring the whole workbook", async () => {
    const applied = { kind: "updateCells" as const, payload: { ...payload, previousVersionId: "3.0", appliedAt: 2 } };
    const { host, sent } = harness([{ status: 200, body: { formulas: [["=SUM(B3:B9)", ""]] } }, { status: 200, body: {} }]);
    expect(await revert(applied, host)).toBeUndefined();
    expect(sent.map(request => request.method)).toEqual(["GET", "PATCH"]);
    expect(sent[1]).toMatchObject({ path: expect.stringContaining("range(address='B2:C2')"), body: { formulas: [[1, 2]] } });
    const changed = harness([{ status: 200, body: { formulas: [["=SUM(B3:B9)", "later"]] } }]);
    expect(await revert(applied, changed.host)).toMatchObject({ canRetry: false, message: expect.stringMatching(/has changed since this edit/) });
    expect(changed.sent.map(request => request.method)).toEqual(["GET"]);
  });

  it("lists at most 200 changed cells, and says the description is incomplete past that", () => {
    const wide = (value: number) => [Array.from({ length: 201 }, () => value)];
    const many = definitions.updateCells.describe({ ...payload, address: "A1:GS1", values: wide(1), before: wide(0) });
    expect(many.descriptionIsComplete).toBeUndefined();
    expect(JSON.stringify(many.fields?.find(field => field.label.endsWith("change")))).toContain("… and 1 more");
    expect(definitions.updateCells.describe(payload).descriptionIsComplete).toBe(true);
  });
});

describe("copying", () => {
  const payload: SharePointActions["copyFile"] = { ref: "~2", source: NOTES, parent: ARCHIVE, name: "notes (copy).txt", submittedAt: 1 };
  const started = { status: 202, headers: { location: MONITOR } };

  it("starts the copy with conflicts refused, waits for it, and binds the temporary ID", async () => {
    const { host, sent } = harness([named("notes.txt"), started, { status: 202, body: { status: "inProgress" } }, { status: 200, body: { status: "completed", resourceId: "COPY" } }]);
    vi.useFakeTimers();
    const applied = definitions.copyFile.apply(payload, host);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await applied).action).toMatchObject({ createdId: "COPY" });
    expect(sent[1]).toMatchObject({ method: "POST", path: `/drives/${DRIVE}/items/NOTES/copy?%40microsoft.graph.conflictBehavior=fail` });
    expect(host.refs.resolve("~2")).toBe(`${DRIVE}/COPY`);
  });

  it("gives up waiting as an unknown outcome, not a failure: the copy still lands", async () => {
    const progress = { status: 202, body: { status: "inProgress" } };
    const { host } = harness([named("notes.txt"), started, ...Array.from({ length: 40 }, () => progress)]);
    vi.useFakeTimers();
    const applied = definitions.copyFile.apply(payload, host);
    applied.catch(() => {});
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(applied).rejects.toThrow(ActionOutcomeUnknownError);
    expect(definitions.copyFile.claimBeforeApply).toBe(true);
  });

  it("finds a finished copy by its name when SharePoint says it finished without saying where", async () => {
    const { host, sent } = harness([named("notes.txt"), started, { status: 200, body: { status: "completed" } }, { status: 200, body: { id: "COPY" } }]);
    vi.useFakeTimers();
    const applied = definitions.copyFile.apply(payload, host);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await applied).action).toMatchObject({ createdId: "COPY" });
    expect(sent[3]).toMatchObject({ method: "GET", path: expect.stringContaining(`/drives/${DRIVE}/items/ARCHIVE:/notes%20(copy).txt`) });
  });

  it("treats a progress check that fails after SharePoint accepted the copy as an unknown outcome, not a failure to retry", async () => {
    // The progress check is a GET, so it is sent three times before it is given up.
    const dropped = { status: -1 };
    const { host, sent } = harness([named("notes.txt"), started, dropped, dropped, dropped]);
    vi.useFakeTimers();
    const applied = expect(definitions.copyFile.apply(payload, host)).rejects.toThrow(ActionOutcomeUnknownError);
    await vi.advanceTimersByTimeAsync(2_000);
    await applied;
    expect(sent.map(request => request.method)).toEqual(["GET", "POST", "GET", "GET", "GET"]);
  });

  /**
   * Starts a copy on the test's clock, with the timeout of each request on that clock too and the
   * wait before a request is sent again fixed at half its ceiling: 250 ms after a first send.
   * `outcome` is the applied action or what the copy threw, `ended.after` the milliseconds the
   * copy took, `sentAfter()` the milliseconds into the copy at which each request was sent, and
   * `asksCounted()` how the asks of the copy's progress are counted once the copy has ended: the
   * outcome, reason and HTTP status of each kind, and how many asks were of it. `lookupsCounted()`
   * is the same of the reads of an item made once the copy has started: the lookups of a finished
   * copy by its name and, where the copy landed, the read of its content tag.
   */
  function copying(progress: Reply[], options: { reaching?: number } = {}) {
    const { host, sent, sentAt } = harness([named("notes.txt"), started, ...progress], options);
    const points = recordedPoints();
    const countedAs = (operation: string, counted = points) => counted
      .filter(point => operationOf(point) === operation)
      .map(point => [COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.httpStatus, SUBSERVICE_V1_SLOTS.calls].map(slot => column(point, slot)));
    const asksCounted = () => countedAs("copy.progress");
    const lookupsCounted = () => countedAs("items.get", points.slice(points.findIndex(point => operationOf(point) === "items.copy") + 1));
    vi.useFakeTimers();
    fakeTimeouts();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const startedAt = Date.now();
    const ended: { after?: number } = {};
    const outcome = definitions.copyFile.apply(payload, host)
      .then(applied => applied.action, (error: unknown) => error)
      .finally(() => { ended.after = Date.now() - startedAt; });
    return { sent, outcome, ended, asksCounted, lookupsCounted, sentAfter: () => sentAt.map(at => at - startedAt) };
  }

  /** The reply that a copy finished, which does not say where the copy is. */
  const finishedSomewhere: Reply = { status: 200, body: { status: "completed" } };

  it("stops waiting 45 seconds in for a copy whose progress link never answers, having asked the twice that fit", async () => {
    const { sent, outcome, ended, asksCounted, sentAfter } = copying([unanswered, unanswered, unanswered]);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(ended.after).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(ended.after).toBe(45_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(ActionOutcomeUnknownError);
    expect(error).toMatchObject({ message: expect.stringMatching(/whether it has finished couldn't be checked/) });
    // The first ask has the 30 seconds of any request, and the second what is left of the wait.
    expect(sent.map(request => request.method)).toEqual(["GET", "POST", "GET", "GET"]);
    expect(sentAfter().slice(2)).toEqual([0, 30_250]);
    // The ask that the end of the wait cut off is SharePoint not answering, as the first is.
    expect(asksCounted()).toEqual([["error", "timeout", 0, 2]]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(4);
  });

  it("gives a progress link that stops answering what is left of the wait, not a wait of its own", async () => {
    const progress = { status: 202, body: { status: "inProgress" } };
    const { outcome, ended, sentAfter } = copying([progress, progress, unanswered, unanswered, unanswered]);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(ended.after).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(ended.after).toBe(45_000);
    expect(await outcome).toBeInstanceOf(ActionOutcomeUnknownError);
    expect(sentAfter().slice(2)).toEqual([0, 500, 1_500, 31_750]);
  });

  it("lands a copy whose progress link answers the second time it is asked, within the wait", async () => {
    const { outcome, ended, sentAfter } = copying([unanswered, { status: 200, body: { status: "completed", resourceId: "COPY" } }]);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(ended.after).toBe(30_250);
    expect(await outcome).toMatchObject({ createdId: "COPY" });
    expect(sentAfter().slice(2, 4)).toEqual([0, 30_250]);
  });

  it("sends no ask that falls due as the wait ends, which leaves it no time, and counts none", async () => {
    // The host reaches Graph 5 ms after it is asked to, so the copy starts 10 ms in and its wait
    // ends 45 010 ms in. The second ask is answered a second before that, so that the third falls
    // due as the wait ends: the wait's signal has aborted by the time the host reaches Graph.
    const { sent, outcome, ended, asksCounted, sentAfter } = copying(
      [slowProgress(29_000), slowProgress(14_490), { status: 200, body: { status: "completed", resourceId: "COPY" } }], { reaching: 5 });
    await vi.advanceTimersByTimeAsync(120_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(ActionOutcomeUnknownError);
    expect(error).toMatchObject({ message: expect.stringMatching(/whether it has finished couldn't be checked/) });
    expect(ended.after).toBe(45_015);
    expect(sent.map(request => request.method)).toEqual(["GET", "POST", "GET", "GET"]);
    expect(sentAfter().slice(2)).toEqual([15, 29_520]);
    expect(asksCounted()).toEqual([["success", "", 202, 2]]);
  });

  it("stops waiting as the wait ends for an ask made just before that gets no answer", async () => {
    // Answered 29 and 43.99 seconds in, so that the next ask is made 10 ms before the 45 seconds end.
    const { sent, outcome, ended, asksCounted, sentAfter } = copying([slowProgress(29_000), slowProgress(14_490), unanswered, unanswered]);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(ended.after).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(ended.after).toBe(45_000);
    expect(await outcome).toBeInstanceOf(ActionOutcomeUnknownError);
    expect(sentAfter().slice(2)).toEqual([0, 29_500, 44_990]);
    expect(asksCounted()).toEqual([["success", "", 202, 2], ["error", "timeout", 0, 1]]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(5);
  });

  it("stops at a progress link that answers without a status as an unknown outcome, the ask counted an answer that cannot be read", async () => {
    const { sent, outcome, asksCounted } = copying([{ status: 202, body: { status: "inProgress" } }, { status: 200, body: {} }]);
    await vi.advanceTimersByTimeAsync(2_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(ActionOutcomeUnknownError);
    expect(error).toMatchObject({ message: expect.stringMatching(/whether it has finished couldn't be checked/) });
    expect(sent.map(request => request.method)).toEqual(["GET", "POST", "GET", "GET"]);
    expect(asksCounted()).toEqual([["success", "", 202, 1], ["error", "parse", 200, 1]]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(4);
  });

  it("stops waiting 45 seconds in for a finished copy whose lookup by name never answers, having looked the twice that fit", async () => {
    const { sent, outcome, ended, lookupsCounted, sentAfter } = copying([finishedSomewhere, unanswered, unanswered, unanswered]);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(ended.after).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(ended.after).toBe(45_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(ActionOutcomeUnknownError);
    expect(error).toMatchObject({ message: expect.stringMatching(/whether it has finished couldn't be checked/) });
    // The first lookup has the 30 seconds of any request, and the second what is left of the wait.
    expect(sent.map(request => request.method)).toEqual(["GET", "POST", "GET", "GET", "GET"]);
    const lookup = `/drives/${DRIVE}/items/ARCHIVE:/notes%20(copy).txt?%24select=id`;
    expect(sent.slice(3).map(request => request.path)).toEqual([lookup, lookup]);
    expect(sentAfter().slice(2)).toEqual([0, 0, 30_250]);
    // The lookup that the end of the wait cut off is Graph not answering, as the first is.
    expect(lookupsCounted()).toEqual([["error", "timeout", 0, 2]]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(5);
  });

  it("gives the lookup of a copy that finished late what is left of the wait, not a wait of its own", async () => {
    const { sent, outcome, ended, lookupsCounted, sentAfter } = copying([{ ...finishedSomewhere, after: 29_000 }, unanswered, unanswered]);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(ended.after).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(ended.after).toBe(45_000);
    expect(await outcome).toBeInstanceOf(ActionOutcomeUnknownError);
    expect(sentAfter().slice(2)).toEqual([0, 29_000]);
    expect(lookupsCounted()).toEqual([["error", "timeout", 0, 1]]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(4);
  });

  it("lands a finished copy whose lookup by name answers the second time it is sent, within the wait", async () => {
    const { outcome, ended, lookupsCounted, sentAfter } = copying([finishedSomewhere, unanswered, { status: 200, body: { id: "COPY" } }]);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(ended.after).toBe(30_250);
    expect(await outcome).toMatchObject({ createdId: "COPY" });
    expect(sentAfter().slice(2, 5)).toEqual([0, 0, 30_250]);
    // The two lookups, and the read of the landed copy's content tag after them.
    expect(lookupsCounted()).toEqual([["error", "timeout", 0, 1], ["success", "", 200, 1], ["success", "", 204, 1]]);
  });

  it("sends no lookup that falls due as the wait ends, which leaves it no time, and counts none", async () => {
    // The host reaches Graph 5 ms after it is asked to, so the copy starts 10 ms in and its wait
    // ends 45 010 ms in. The copy is reported finished 2 ms before that: the wait's signal has
    // aborted by the time the host reaches Graph for the lookup.
    const { sent, outcome, ended, lookupsCounted, sentAfter } = copying(
      [slowProgress(29_000), { ...finishedSomewhere, after: 15_488 }, { status: 200, body: { id: "COPY" } }], { reaching: 5 });
    await vi.advanceTimersByTimeAsync(120_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(ActionOutcomeUnknownError);
    expect(error).toMatchObject({ message: expect.stringMatching(/whether it has finished couldn't be checked/) });
    expect(ended.after).toBe(45_013);
    expect(sent.map(request => request.method)).toEqual(["GET", "POST", "GET", "GET"]);
    expect(sentAfter().slice(2)).toEqual([15, 29_520]);
    expect(lookupsCounted()).toEqual([]);
  });

  it.each<[answered: string, reply: Reply, counted: unknown[]]>([
    ["a 503 that names no wait", { status: 503 }, ["error", "http", 503, 1]],
    ["a 504", { status: 504 }, ["error", "http", 504, 1]],
    ["a 429 that asks for 5 seconds", { status: 429, headers: { "retry-after": "5" } }, ["refused", "rate", 429, 1]],
    ["a 503 that asks for 2 seconds", { status: 503, headers: { "retry-after": "2" } }, ["refused", "rate", 503, 1]],
    ["a dropped connection", { status: -1 }, ["error", "network", 0, 1]],
  ])("stops waiting 45 seconds in for a finished copy whose lookup, answered %s, would be sent again after that", async (_, reply, counted) => {
    // The copy is reported finished 100 ms before the wait ends, and the pause before the lookup
    // is sent again is longer than that: 250 ms after a dropped connection, a second or more after an answer.
    const { sent, outcome, ended, lookupsCounted, sentAfter } = copying(
      [slowProgress(29_000), { ...finishedSomewhere, after: 15_400 }, reply, { status: 200, body: { id: "COPY" } }]);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(ended.after).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(ended.after).toBe(45_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(ActionOutcomeUnknownError);
    expect(error).toMatchObject({ message: expect.stringMatching(/whether it has finished couldn't be checked/) });
    expect(sentAfter().slice(2)).toEqual([0, 29_500, 44_900]);
    expect(lookupsCounted()).toEqual([counted]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(5);
  });

  it("stops waiting 45 seconds in for a finished copy whose lookup is answered and never read to its end, having looked the twice that fit", async () => {
    const stalled: Reply = { status: 200, stalls: true };
    const { sent, outcome, ended, lookupsCounted, sentAfter } = copying([finishedSomewhere, stalled, stalled, { status: 200, body: { id: "COPY" } }]);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(ended.after).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(ended.after).toBe(45_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(ActionOutcomeUnknownError);
    expect(error).toMatchObject({ message: expect.stringMatching(/whether it has finished couldn't be checked/) });
    // The first answer has the 30 seconds of any request to be read in, and the second what is left of the wait.
    expect(sentAfter().slice(2)).toEqual([0, 0, 30_250]);
    expect(lookupsCounted()).toEqual([["error", "timeout", 200, 2]]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(5);
  });

  it("undoes a copy only while it still holds what was copied", async () => {
    const applied = { ...payload, createdId: "COPY", cTag: "c-copy", appliedAt: 2 };
    const edited = harness([{ status: 200, body: { cTag: "c-edited" } }]);
    expect(await revert({ kind: "copyFile", payload: applied }, edited.host)).toMatchObject({ canRetry: false, message: expect.stringMatching(/changed since/) });
    expect(edited.sent.map(request => request.method)).toEqual(["GET"]);
    const same = harness([{ status: 200, body: { cTag: "c-copy" } }, { status: 204 }]);
    expect(await revert({ kind: "copyFile", payload: applied }, same.host)).toBeUndefined();
    expect(same.sent.map(request => request.method)).toEqual(["GET", "DELETE"]);
  });

  it("fails finally when SharePoint reports the copy failed", async () => {
    const { host } = harness([named("notes.txt"), started, { status: 200, body: { status: "failed", error: { message: "Quota exceeded" } } }]);
    await expect(definitions.copyFile.apply(payload, host)).rejects.toThrow(ActionApplyError);
  });

  it("refuses renaming a file since renamed into another format, which its new name was never checked against", async () => {
    const target = { ...NOTES, name: "report.xlsx" };
    const { host, sent } = harness([named("report.zip")]);
    await expect(definitions.rename.apply({ target, name: "approved.xlsx", submittedAt: 1 }, host)).rejects.toThrow(/renamed into another format/);
    expect(sent.map(request => request.method)).toEqual(["GET"]);
    const same = harness([named("Report.XLSX"), { status: 200, body: item("NOTES") }]);
    await definitions.rename.apply({ target, name: "approved.xlsx", submittedAt: 1 }, same.host);
    expect(same.sent.map(request => request.method)).toEqual(["GET", "PATCH"]);
  });

  it("restores a name in another format only to the content the file had when renamed", async () => {
    const target = { ...NOTES, name: "report.xlsx" };
    const { host } = harness([named("report.xlsx"), { status: 200, body: item("NOTES", { cTag: "c-renamed" }) }]);
    const applied = await definitions.rename.apply({ target, name: "report.zip", submittedAt: 1 }, host);
    expect(applied.action.cTag).toBe("c-renamed");
    const changed = harness([{ status: 200, body: { cTag: "c-replaced" } }]);
    expect(await revert({ kind: "rename", payload: applied.action }, changed.host)).toMatchObject({ canRetry: false, message: expect.stringMatching(/content of "report.zip" has changed/) });
    expect(changed.sent.map(request => request.method)).toEqual(["GET"]);
    const same = harness([{ status: 200, body: { cTag: "c-renamed" } }, { status: 200, body: item("NOTES") }]);
    expect(await revert({ kind: "rename", payload: applied.action }, same.host)).toBeUndefined();
    expect(same.sent.map(request => request.method)).toEqual(["GET", "PATCH"]);
    // Within one format the name is simply restored.
    const plain = harness([{ status: 200, body: item("NOTES") }]);
    expect(await revert({ kind: "rename", payload: { target: NOTES, name: "n.txt", submittedAt: 1, appliedAt: 2 } }, plain.host)).toBeUndefined();
    expect(plain.sent.map(request => request.method)).toEqual(["PATCH"]);
  });

  it("refuses a source since renamed into another format, whose bytes the copy's name was never checked as", async () => {
    const { host, sent } = harness([named("report.zip")]);
    await expect(definitions.copyFile.apply({ ...payload, source: { ...NOTES, name: "report.xlsx" }, name: "copy.xlsx" }, host)).rejects.toThrow(/renamed into another format/);
    expect(sent.map(request => request.method)).toEqual(["GET"]);
  });
});

/** What an action throws: its class and message. */
type Thrown = { type: abstract new (...args: never[]) => Error; message: string };

/** What an action throws for a success that is not the shape it asked for. */
const malformed = (what: string): Thrown => ({ type: GraphApiError, message: `Microsoft Graph sent a malformed ${what}.` });

/** What an action throws for a file whose format it cannot tell is the one it was proposed for. */
const reformatted = (done: string): Thrown => ({
  type: ActionApplyError, message: `The file has been renamed into another format since this was proposed, so it wasn't ${done}. Ask the agent to read it again.`,
});

describe("how a success that is not what its request was sent for is counted", () => {
  const counted = countedCalls();
  const folder: SharePointActions["createFolder"] = { ref: "~1", parent: SPECS, name: "Drafts", submittedAt: 1 };
  const listItem: SharePointActions["createListItem"] = {
    ref: "~1", list: { siteId: "contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,33333333-3333-3333-3333-333333333333", listId: "44444444-4444-4444-4444-444444444444", name: "Tasks" },
    fields: { Title: "Ship it" }, labels: { Title: "Title" }, submittedAt: 1,
  };
  const replace: SharePointActions["replaceFile"] = { target: NOTES, file: FILE, mimeType: "text/plain", ifMatch: `"c:{NOTES},2"`, submittedAt: 1 };
  const cells: SharePointActions["updateCells"] = {
    target: NOTES, worksheet: "Costs", sheetId: "{00000000-0001-0000-0000-000000000000}", address: "B2:C2",
    values: [["=SUM(B3:B9)", null]], before: [[1, 2]], ifMatch: `"c:{NOTES},2"`, submittedAt: 1,
  };

  // Each write and read an action makes whose answer it checks: the replies that lead to it, the
  // success it refuses, the request that answer is to, the name it is counted under and what the
  // action throws.
  it.each<[string, (host: SharePointActionHost) => Promise<unknown>, Reply[], Reply, string, string, Thrown]>([
    ["a folder created with no ID", host => definitions.createFolder.apply(folder, host), [], { status: 201, body: { name: "Drafts" } },
      "POST", "children.create", malformed("file")],
    ["a file uploaded with no ID", host => definitions.uploadFile.apply({ ...folder, file: FILE, mimeType: "text/plain" }, host), [],
      { status: 201, body: { name: "Drafts" } }, "PUT", "content.update", malformed("file")],
    ["the versions a replaced file supersedes that hold no list", host => definitions.replaceFile.apply(replace, host), [named("notes.txt")],
      { status: 200, body: {} }, "GET", "versions.list", malformed("version list")],
    ["the workbook whose cells are written that names no drive", host => definitions.updateCells.apply(cells, host), [],
      { status: 200, body: { id: "NOTES" } }, "GET", "items.get", malformed("file")],
    ["the versions a write of cells supersedes that hold no list", host => definitions.updateCells.apply(cells, host), [{ status: 200, body: item("NOTES") }],
      { status: 200, body: { value: {} } }, "GET", "versions.list", malformed("version list")],
    ["the file a replacement is fenced on that has no name", host => definitions.replaceFile.apply(replace, host), [], { status: 200, body: { id: "NOTES" } },
      "GET", "items.get", reformatted("replaced")],
    ["the file a rename is fenced on that has no name", host => definitions.rename.apply({ target: NOTES, name: "n.txt", submittedAt: 1 }, host), [], { status: 200, body: { id: "NOTES" } },
      "GET", "items.get", reformatted("renamed")],
    ["the file a copy is fenced on that has no name", host => definitions.copyFile.apply({ ref: "~2", source: NOTES, parent: ARCHIVE, name: "notes (copy).txt", submittedAt: 1 }, host), [],
      { status: 200, body: { id: "NOTES" } }, "GET", "items.get", reformatted("copied")],
    ["a list item added with no ID", host => definitions.createListItem.apply(listItem, host), [], { status: 201, body: { fields: {} } },
      "POST", "items.create", { type: ActionOutcomeUnknownError, message: "SharePoint may have added the item before the connection dropped. Check the list before trying again." }],
    ["the list item an undo is to delete that has no ID", host => revert({ kind: "createListItem", payload: { ...listItem, createdId: "9", createdETag: '"e1"', appliedAt: 2 } }, host), [],
      { status: 200, body: { eTag: '"e1"' } }, "GET", "items.get", malformed("list item")],
  ])("counts %s as an error of the API, by the status of the answer, and sends nothing after it", async (_what, act, before, refused, method, operation, thrown) => {
    const { host, sent } = harness([...before, refused, { status: 200, body: item("NOTES") }]);
    const error = await act(host).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(thrown.type);
    expect(error).toMatchObject({ message: thrown.message });
    expect(sent).toHaveLength(before.length + 1);
    expect(sent.at(-1)?.method).toBe(method);
    expect(counted().at(-1)).toEqual([operation, "error", "api", refused.status]);
    expect(counted().slice(0, -1).map(([, outcome]) => outcome)).toEqual(before.map(() => "success"));
  });

  it("counts the read of a file since renamed into another format as the success it is, and refuses the change as it does a file with no name", async () => {
    for (const [act, done] of [
      [(host: SharePointActionHost) => definitions.replaceFile.apply(replace, host), "replaced"],
      [(host: SharePointActionHost) => definitions.rename.apply({ target: NOTES, name: "n.txt", submittedAt: 1 }, host), "renamed"],
      [(host: SharePointActionHost) => definitions.copyFile.apply({ ref: "~2", source: NOTES, parent: ARCHIVE, name: "notes (copy).txt", submittedAt: 1 }, host), "copied"],
    ] as const) {
      const { host, sent } = harness([named("notes.docx"), { status: 200, body: item("NOTES") }]);
      const error = await act(host).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ActionApplyError);
      expect(error).toMatchObject({ message: reformatted(done).message });
      expect(sent).toHaveLength(1);
      expect(counted().at(-1)).toEqual(["items.get", "success", "", 200]);
    }
  });

  it("counts the lookup of a finished copy that names no item as an error of the API, and one that finds none by its status", async () => {
    const copy: SharePointActions["copyFile"] = { ref: "~2", source: NOTES, parent: ARCHIVE, name: "notes (copy).txt", submittedAt: 1 };
    const started = { status: 202, headers: { location: MONITOR } };
    const nowhere = { message: "SharePoint says the copy finished, but it couldn't be found in the folder. Check there before asking for it again." };
    for (const [found, count] of [
      [{ status: 200, body: { name: "notes (copy).txt" } }, ["items.get", "error", "api", 200]],
      [{ status: 404, body: { error: { code: "itemNotFound" } } }, ["items.get", "error", "http", 404]],
    ] as const) {
      const { host, sent } = harness([named("notes.txt"), started, { status: 200, body: { status: "completed" } }, found]);
      const error = await definitions.copyFile.apply(copy, host).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ActionOutcomeUnknownError);
      expect(error).toMatchObject(nowhere);
      expect(sent).toHaveLength(4);
      expect(counted().at(-1)).toEqual(count);
    }
  });
});

describe("what the approver is shown", () => {
  const kib = (n: number) => "x".repeat(n * 1024);

  it("keeps a diff's two sides only while they fit one record together, the new text alone next, else neither", () => {
    expect(shownTexts(kib(20), kib(20))).toEqual({ text: kib(20), previousText: kib(20) });
    expect(shownTexts(kib(40), kib(40))).toEqual({ text: kib(40) });
    expect(shownTexts(kib(70), kib(1))).toEqual({});
    expect(shownTexts(undefined, kib(1))).toEqual({});
    expect(shownTexts("é".repeat(60 * 1024), undefined)).toEqual({});
  });

  it("keeps the leading edit changes that fit, counting the rest", () => {
    const changes = Array.from({ length: 10 }, (_, n) => ({ before: kib(10), after: `after ${n}` }));
    expect(shownChanges(changes)).toMatchObject({ more: 4 });
    expect(shownChanges(changes).changes).toHaveLength(6);
    expect(shownChanges(changes.slice(0, 2))).toEqual({ changes: changes.slice(0, 2) });
    const shown = JSON.stringify(definitions.replaceFile.describe({
      target: NOTES, file: FILE, mimeType: "text/plain", submittedAt: 1,
      edit: { kind: "document", changes: changes.slice(0, 6).map(change => ({ ...change, before: "old" })), more: 4 },
    }));
    expect(shown).toContain("Changes 10 paragraphs in place");
    expect(shown).toContain("… and 4 more");
  });
});
