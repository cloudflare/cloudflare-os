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

describe("replacing content", () => {
  const payload: SharePointActions["replaceFile"] = { target: NOTES, file: FILE, mimeType: "text/plain", ifMatch: `"c:{NOTES},2"`, submittedAt: 1 };

  it("records the version it supersedes, writes under the content fence, and releases the bytes", async () => {
    const { host, sent, released } = harness([versions, { status: 200, body: item("NOTES") }]);
    const { action } = await definitions.replaceFile.apply(payload, host);
    expect(sent.map(request => [request.method, request.path, request.ifMatch])).toEqual([
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
    const { host, released } = harness([versions, { status: 412, body: { error: { code: "notAllowed", message: "ETag mismatch" } } }]);
    await expect(definitions.replaceFile.apply(payload, host)).rejects.toThrow(/changed after this was proposed/);
    expect(released).toEqual([]);
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

  it("fails finally when the workbook's tag moved", async () => {
    const { host, sent } = harness([{ status: 200, body: item("NOTES", { cTag: `"c:{NOTES},3"` }) }]);
    await expect(definitions.updateCells.apply(payload, host)).rejects.toThrow(/changed after this was proposed/);
    expect(sent).toHaveLength(1);
  });
});

describe("copying", () => {
  const payload: SharePointActions["copyFile"] = { ref: "~2", source: NOTES, parent: ARCHIVE, name: "notes (copy).txt", submittedAt: 1 };
  const started = { status: 202, headers: { location: MONITOR } };

  it("starts the copy with conflicts refused, waits for it, and binds the temporary ID", async () => {
    const { host, sent } = harness([started, { status: 202, body: { status: "inProgress" } }, { status: 200, body: { status: "completed", resourceId: "COPY" } }]);
    vi.useFakeTimers();
    const applied = definitions.copyFile.apply(payload, host);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await applied).action).toMatchObject({ createdId: "COPY" });
    expect(sent[0]).toMatchObject({ method: "POST", path: `/drives/${DRIVE}/items/NOTES/copy?%40microsoft.graph.conflictBehavior=fail` });
    expect(host.refs.resolve("~2")).toBe(`${DRIVE}/COPY`);
  });

  it("gives up waiting as an unknown outcome, not a failure: the copy still lands", async () => {
    const progress = { status: 202, body: { status: "inProgress" } };
    const { host } = harness([started, ...Array.from({ length: 40 }, () => progress)]);
    vi.useFakeTimers();
    const applied = definitions.copyFile.apply(payload, host);
    applied.catch(() => {});
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(applied).rejects.toThrow(ActionOutcomeUnknownError);
    expect(definitions.copyFile.claimBeforeApply).toBe(true);
  });

  it("fails finally when SharePoint reports the copy failed", async () => {
    const { host } = harness([started, { status: 200, body: { status: "failed", error: { message: "Quota exceeded" } } }]);
    await expect(definitions.copyFile.apply(payload, host)).rejects.toThrow(ActionApplyError);
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
