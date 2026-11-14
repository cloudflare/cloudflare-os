// Applying and reverting SharePoint actions against a fake Graph at `fetch`: what each kind sends,
// which failures are final, what a crash may replay, and the proofs an apply makes before writing.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionApplyError, ActionOutcomeUnknownError } from "@gadgets/gatekeeper-kit/actions";
import { ProvisionalIds, type SimulationKv } from "@gadgets/gatekeeper-kit/simulation";
import { GraphApi } from "../src/graph-api";
import {
  definitions, revert, shownChanges, shownTexts, type FolderTarget, type ItemTarget, type SharePointActionHost, type SharePointActions,
} from "../src/sharepoint-actions";
import { OutsideScopeError, type ItemRef } from "../src/sharepoint-scope";

const DRIVE = "b!AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SPECS: FolderTarget = { id: `${DRIVE}/SPECS`, driveId: DRIVE, name: "Specs", location: "Engineering › Documents", path: "" };
const ARCHIVE: FolderTarget = { id: `${DRIVE}/ARCHIVE`, driveId: DRIVE, name: "Archive", location: "Engineering › Documents › Archive", path: "Archive" };
const NOTES: ItemTarget = { ref: { driveId: DRIVE, itemId: "NOTES" }, name: "notes.txt", kind: "file", location: "Engineering › Documents › Specs", path: "notes.txt" };
const FILE = { handle: "h1", size: 9, digest: "d1" };
const MONITOR = "https://contoso.sharepoint.com/_api/v2.0/monitor/copy-1";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Sent = { method: string; path: string; body?: unknown; ifMatch: string | null };

/** A Graph that answers each request with the next scripted reply, recording what was sent. */
function harness(replies: Reply[] = [], options: { outside?: string[] } = {}) {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    sent.push({
      method: init?.method ?? "GET", path: `${url.pathname.replace(/^\/v1\.0/, "")}${url.search}`,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body, ifMatch: new Headers(init?.headers).get("if-match"),
    });
    const reply = replies.shift() ?? { status: 204 };
    if (reply.status === -1) throw new Error("the connection dropped");
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), {
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
    graph: op => op(api),
    inScope: async (ref: ItemRef) => {
      if (options.outside?.includes(ref.itemId)) throw new OutsideScopeError();
    },
    readFile: async () => new TextEncoder().encode("new text\n"),
    releaseFile: file => { released.push(file.handle); },
    invalidate: async () => {},
  };
  return { host, sent, released };
}

const item = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, webUrl: `https://contoso.sharepoint.com/${id}`, parentReference: { driveId: DRIVE, id: "SPECS" }, eTag: `"{${id}},2"`, cTag: `"c:{${id}},2"`, ...extra });
const nameTaken = { status: 409, body: { error: { code: "nameAlreadyExists", message: "The specified item name already exists." } } };
const versions = { status: 200, body: { value: [{ id: "3.0" }, { id: "2.0" }] } };
const named = (name: string) => ({ status: 200, body: { name } });

afterEach(() => {
  vi.useRealTimers();
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
    const { host, released } = harness([{ status: 201, body: item("NEW", { file: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, size: 9, cTag: "c-up" }) }, { status: 204 }, { status: -1 }]);
    const { action } = await definitions.uploadFile.apply(upload, host);
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
    const { host, sent } = harness([named("notes.txt"), started, { status: -1 }]);
    await expect(definitions.copyFile.apply(payload, host)).rejects.toThrow(ActionOutcomeUnknownError);
    expect(sent.map(request => request.method)).toEqual(["GET", "POST", "GET"]);
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
