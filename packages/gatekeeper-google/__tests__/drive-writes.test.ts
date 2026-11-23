import { ActionApplyError, ActionOutcomeUnknownError } from "@gadgets/gatekeeper-kit/actions";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  DriveApiDisabledError, DriveApiRequestError, FOLDER_MIME_TYPE, type DriveApi,
  type DriveScopeNode,
} from "../src/drive-api";
import type { DriveBindingScope } from "../src/drive-session";
import {
  actorFence, addressDomain, CREDENTIALS_NOT_ACCEPTED, DEPLOYMENT_READ_ONLY, driveAccessCap,
  driveRefusal, isLiftable, isPendingId, PENDING_PREFIX, pendingId, provePath, proveTarget,
  readOnlyRefusal, requireWritable, sendOnce, shownFileName, WRITE_ATTEMPT_PREFIX, writeAttempts,
  writeRefusal, WRITES_GRANT_MISSING, type DriveWritesHost, type WriteAttempt, type WriteStep,
} from "../src/drive-writes";
import { obsContext } from "../src/observability";

const UNCONFIRMED = "Google Drive did not confirm whether this was made.";
const REFUSED = "Google Drive refused this.";
const RATE_LIMITED =
  "Google Drive is limiting requests from this account. Approve it again in a minute.";

/** A live folder the account can list, as a scope proof reads it. */
function folder(id: string, parent: string): DriveScopeNode {
  return {
    id, mimeType: FOLDER_MIME_TYPE, parents: [parent], trashed: false, canListChildren: true,
  };
}

/** A live file, as a scope proof reads it. */
function file(id: string, parent: string): DriveScopeNode {
  return { id, mimeType: "application/pdf", parents: [parent], trashed: false };
}

/** Folder `R` holds folder `A`, which holds folder `B` and file `F`. */
function tree(): Record<"R" | "A" | "B" | "F", DriveScopeNode> {
  return { R: folder("R", "above"), A: folder("A", "R"), B: folder("B", "A"), F: file("F", "A") };
}

const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected call");
};

/** A host of `scope` whose batch read answers from `nodes`: an ID it lacks reads as invisible. */
function scoped(scope: DriveBindingScope, nodes: Partial<Record<string, DriveScopeNode>>) {
  let getScopeNodes = vi.fn<DriveApi["getScopeNodes"]>(async ids => ids.map(id => nodes[id]));
  let host: Pick<DriveWritesHost, "api" | "scope"> = {
    api: {
      getScopeNodes,
      getComment: vi.fn<DriveApi["getComment"]>(unexpected),
      listComments: vi.fn<DriveApi["listComments"]>(unexpected),
      listReplies: vi.fn<DriveApi["listReplies"]>(unexpected),
      createComment: vi.fn<DriveApi["createComment"]>(unexpected),
      createReply: vi.fn<DriveApi["createReply"]>(unexpected),
      listPermissions: vi.fn<DriveApi["listPermissions"]>(unexpected),
      createPermission: vi.fn<DriveApi["createPermission"]>(unexpected),
      updatePermission: vi.fn<DriveApi["updatePermission"]>(unexpected),
      deletePermission: vi.fn<DriveApi["deletePermission"]>(unexpected),
      swapParent: vi.fn<DriveApi["swapParent"]>(unexpected),
    },
    scope: () => scope,
  };
  return { host, getScopeNodes };
}

const ACCOUNT: DriveBindingScope = { kind: "account" };
const AT_R: DriveBindingScope = { kind: "folder", folderId: "R" };

describe("Drive write scope proofs at apply", () => {
  it("proves a file binding's own file and no other", async () => {
    let nodes = tree();
    let { host, getScopeNodes } = scoped({ kind: "file", fileId: "F" }, nodes);
    expect(await proveTarget(host, { fileId: "F" })).toBe(nodes.F);
    expect(getScopeNodes.mock.calls).toEqual([[["F"]]]);

    // Another file, and the bound file named as a positioned folder: Drive is not asked.
    expect(await proveTarget(host, { fileId: "B" })).toBeUndefined();
    expect(await proveTarget(host, { fileId: "F", folderIds: ["F"], self: true })).toBeUndefined();
    expect(getScopeNodes).toHaveBeenCalledTimes(1);

    let invisible = scoped({ kind: "file", fileId: "F" }, {});
    expect(await proveTarget(invisible.host, { fileId: "F" })).toBeUndefined();
    expect(invisible.getScopeNodes).toHaveBeenCalledTimes(1);
  });

  it("proves an account binding's visible file", async () => {
    let nodes = tree();
    let { host, getScopeNodes } = scoped(ACCOUNT, nodes);
    expect(await proveTarget(host, { fileId: "F" })).toBe(nodes.F);
    // A path is a folder binding's: an account binding reads the file alone.
    expect(await proveTarget(host, { fileId: "F", folderIds: ["elsewhere"] })).toBe(nodes.F);
    expect(getScopeNodes.mock.calls).toEqual([[["F"]], [["F"]]]);

    expect(await proveTarget(host, { fileId: "gone" })).toBeUndefined();
    expect(getScopeNodes).toHaveBeenCalledTimes(3);
    expect(await proveTarget(host, { fileId: "A", folderIds: ["R", "A"], self: true }))
      .toBeUndefined();
    expect(getScopeNodes).toHaveBeenCalledTimes(3);
  });

  it("proves a folder binding's direct child along its saved path", async () => {
    let nodes = tree();
    let { host, getScopeNodes } = scoped(AT_R, nodes);
    expect(await proveTarget(host, { fileId: "F", folderIds: ["R", "A"] })).toBe(nodes.F);
    expect(getScopeNodes.mock.calls).toEqual([[["R", "A", "F"]]]);

    // A path that is missing, empty or starts elsewhere than the bound root: Drive is not asked.
    for (let folderIds of [undefined, [], ["A"], ["above", "R", "A"]]) {
      expect(await proveTarget(host, { fileId: "F", ...(folderIds ? { folderIds } : {}) }))
        .toBeUndefined();
    }
    expect(getScopeNodes).toHaveBeenCalledTimes(1);

    let path = ["R", "A"];
    let refused: [string, Partial<Record<string, DriveScopeNode>>, string[]][] = [
      ["a link that no longer holds", { ...nodes, A: folder("A", "elsewhere") }, path],
      ["a folder of the path in the trash", { ...nodes, A: { ...nodes.A, trashed: true } }, path],
      ["a file whose parent is not the last folder", nodes, ["R"]],
      ["a file with a second parent", { ...nodes, F: { ...nodes.F, parents: ["A", "R"] } }, path],
      ["a file in the trash", { ...nodes, F: { ...nodes.F, trashed: true } }, path],
      ["an invisible file", { R: nodes.R, A: nodes.A }, path],
      ["an invisible folder", { R: nodes.R, F: nodes.F }, path],
    ];
    for (let [what, now, folderIds] of refused) {
      let moved = scoped(AT_R, now);
      expect(await proveTarget(moved.host, { fileId: "F", folderIds }), what).toBeUndefined();
      expect(moved.getScopeNodes, what).toHaveBeenCalledTimes(1);
    }
  });

  it("proves a saved path with whatever else is asked, in one batch", async () => {
    let nodes = tree();
    let { host, getScopeNodes } = scoped(AT_R, { R: nodes.R, A: nodes.A, F: nodes.F });
    expect(await provePath(host, ["R", "A"], ["F", "B"]))
      .toEqual({ path: [nodes.R, nodes.A], extras: [nodes.F, undefined] });
    expect(getScopeNodes.mock.calls).toEqual([[["R", "A", "F", "B"]]]);
    expect(await provePath(host, ["R"], [])).toEqual({ path: [nodes.R], extras: [] });

    getScopeNodes.mockClear();
    for (let folderIds of [undefined, [], ["A"]]) {
      expect(await provePath(host, folderIds, ["F"])).toBeUndefined();
    }
    expect(getScopeNodes).not.toHaveBeenCalled();

    let moved = scoped(AT_R, { ...nodes, A: folder("A", "elsewhere") });
    expect(await provePath(moved.host, ["R", "A"], ["F"])).toBeUndefined();
    expect(moved.getScopeNodes).toHaveBeenCalledTimes(1);

    // Only a folder binding saves a path.
    for (let scope of [ACCOUNT, { kind: "file", fileId: "F" }] satisfies DriveBindingScope[]) {
      let other = scoped(scope, nodes);
      expect(await provePath(other.host, ["R", "A"], ["F"]), scope.kind).toBeUndefined();
      expect(other.getScopeNodes, scope.kind).not.toHaveBeenCalled();
    }
  });

  it("proves the positioned folder itself", async () => {
    let nodes = tree();
    let { host, getScopeNodes } = scoped(AT_R, nodes);
    expect(await proveTarget(host, { fileId: "A", folderIds: ["R", "A"], self: true }))
      .toBe(nodes.A);
    // The target is the path's last node, so no ID beyond the path is read.
    expect(getScopeNodes.mock.calls).toEqual([[["R", "A"]]]);
    expect(await proveTarget(host, { fileId: "R", folderIds: ["R"], self: true })).toBe(nodes.R);

    getScopeNodes.mockClear();
    // A path that ends elsewhere than the target, or is missing: Drive is not asked.
    expect(await proveTarget(host, { fileId: "A", folderIds: ["R"], self: true })).toBeUndefined();
    expect(await proveTarget(host, { fileId: "B", folderIds: ["R", "A"], self: true }))
      .toBeUndefined();
    expect(await proveTarget(host, { fileId: "A", self: true })).toBeUndefined();
    expect(getScopeNodes).not.toHaveBeenCalled();

    let refused: [string, DriveScopeNode][] = [
      ["no longer under the bound root", folder("A", "elsewhere")],
      ["in the trash", { ...nodes.A, trashed: true }],
      ["unlistable", { ...nodes.A, canListChildren: false }],
    ];
    let positioned = { fileId: "A", folderIds: ["R", "A"], self: true as const };
    for (let [what, now] of refused) {
      let changed = scoped(AT_R, { ...nodes, A: now });
      expect(await proveTarget(changed.host, positioned), what).toBeUndefined();
      expect(changed.getScopeNodes, what).toHaveBeenCalledTimes(1);
    }
  });
});

const logger = obsContext
  .createLogger({ component: "gatekeeper.google.drive.test", vendorId: "google" })
  .with({ actionId: 7, actionKind: "test", fileId: "F" });

/** A send's markers over a `Map`, which is all a handler's host asks of the store. */
function markerStore(prior?: WriteAttempt) {
  let markers = new Map<number, WriteAttempt>(prior ? [[7, prior]] : []);
  let host: Pick<DriveWritesHost, "attempts"> = {
    attempts: {
      get: id => markers.get(id),
      put: (id, attempt) => { markers.set(id, attempt); },
      delete: id => { markers.delete(id); },
    },
  };
  return { markers, host };
}

/**
 * A write that can be repeated, whose look proves an earlier send empty, whose checks pass and
 * whose send works, but for what `overrides` says. Its four calls are recorded.
 */
function fakeStep(overrides: Partial<Omit<WriteStep<string>, "log" | "refusal">> = {}) {
  let look = vi.fn<WriteStep<string>["look"]>(
    overrides.look ?? (async () => ({ conclusive: true })));
  let check = vi.fn<WriteStep<string>["check"]>(overrides.check ?? (async () => ({})));
  let send = vi.fn<WriteStep<string>["send"]>(overrides.send ?? (async () => "made"));
  let refusal = vi.fn<WriteStep<string>["refusal"]>(() => REFUSED);
  let step: WriteStep<string> = {
    events: "drive.test", repeatable: true, unconfirmed: UNCONFIRMED, ...overrides,
    log: logger, look, check, send, refusal,
  };
  return { step, look, check, send, refusal };
}

/** The error `attempt` rejects with. */
async function failureOf(attempt: Promise<unknown>): Promise<Error> {
  let failure = await attempt.then(() => undefined, (error: unknown) => error);
  if (!(failure instanceof Error)) throw new Error("the write did not fail");
  return failure;
}

/** A Durable Object's synchronous storage over a `Map`. */
class MemoryKv {
  entries = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.entries.get(key) as T | undefined;
  }
  put<T>(key: string, value: T): void {
    this.entries.set(key, value);
  }
  delete(key: string): boolean {
    return this.entries.delete(key);
  }
  list<T>(options?: { prefix?: string }): Iterable<[string, T]> {
    return [...this.entries]
      .filter(([key]) => key.startsWith(options?.prefix ?? ""))
      .map(([key, value]): [string, T] => [key, value as T]);
  }
}

describe("Drive write sends and their markers", () => {
  let info: MockInstance<typeof console.info>;
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("binds what an earlier send made without sending again", async () => {
    let { markers, host } = markerStore({ at: 1000 });
    let { step, look, check, send } = fakeStep({
      look: async () => ({ found: "earlier" }), logFields: commentId => ({ commentId }),
    });
    expect(await sendOnce(host, 7, step)).toBe("earlier");
    expect(look.mock.calls).toEqual([[{ at: 1000 }]]);
    expect(check).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(markers.get(7)).toEqual({ at: 1000 });
    expect(info.mock.calls.map(([line]) => line)).toEqual([expect.objectContaining({
      event: "drive.test.reconciled", outcome: "found", actionId: 7, actionKind: "test",
      fileId: "F", commentId: "earlier",
    })]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("writes the marker before it sends, dated when the checks pass, and logs what it made", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    let { markers, host } = markerStore();
    let atSend: WriteAttempt | undefined;
    let { step, look } = fakeStep({
      check: async () => {
        vi.setSystemTime(5000);
        return { existing: ["reply-1"] };
      },
      send: async () => {
        atSend = markers.get(7);
        vi.setSystemTime(9000);
        return "made";
      },
    });
    expect(await sendOnce(host, 7, step)).toBe("made");
    // No marker, so no look.
    expect(look).not.toHaveBeenCalled();
    expect(atSend).toEqual({ at: 5000, existing: ["reply-1"] });
    // The marker of a send that worked stays, for the gatekeeper to drop.
    expect(markers.get(7)).toEqual({ at: 5000, existing: ["reply-1"] });
    expect(info.mock.calls.map(([line]) => line)).toEqual([
      expect.objectContaining({ event: "drive.test.applied", outcome: "applied", actionId: 7 }),
    ]);

    // Nothing noted of what is already there leaves the marker its time alone.
    for (let noted of [{}, { existing: [] }]) {
      let plain = markerStore();
      await sendOnce(plain.host, 7, fakeStep({ check: async () => noted }).step);
      expect(plain.markers.get(7)).toStrictEqual({ at: expect.any(Number) });
    }

    // A kind can name its own event and outcome, and add a field to the line.
    info.mockClear();
    await sendOnce(markerStore().host, 7, fakeStep({
      events: "drive.comments", applied: { event: "posted", outcome: "posted" },
      logFields: commentId => ({ commentId }),
    }).step);
    expect(info.mock.calls.map(([line]) => line)).toEqual([expect.objectContaining({
      event: "drive.comments.posted", outcome: "posted", commentId: "made",
    })]);
  });

  it("sends again once a look proves the earlier send empty, however often", async () => {
    let { markers, host } = markerStore({ at: 1000 });
    let ran: string[] = [];
    let { step } = fakeStep({
      look: async () => {
        ran.push("look");
        return { conclusive: true };
      },
      check: async () => {
        ran.push("check");
        return {};
      },
      send: async () => {
        ran.push("send");
        throw new DriveApiRequestError(503, "backendError");
      },
    });
    for (let round = 1; round <= 4; round++) {
      ran.length = 0;
      expect((await failureOf(sendOnce(host, 7, step))).message, String(round)).toBe(UNCONFIRMED);
      expect(ran, String(round)).toEqual(["look", "check", "send"]);
      expect(markers.get(7), String(round)).toEqual({ at: expect.any(Number) });
    }
  });

  it("keeps a marker proved empty through a check that fails, so the send is counted once", async () => {
    let later = new Error("Not yet.");
    for (let repeatable of [false, true]) {
      let { markers, host } = markerStore({ at: 1000, existing: ["reply-1"] });
      let { step, send } = fakeStep({ repeatable, check: async () => { throw later; } });
      expect(await failureOf(sendOnce(host, 7, step)), String(repeatable)).toBe(later);
      expect(await failureOf(sendOnce(host, 7, step)), String(repeatable)).toBe(later);
      expect(send, String(repeatable)).not.toHaveBeenCalled();
      expect(markers.get(7), String(repeatable)).toEqual({ at: 1000, existing: ["reply-1"] });
    }
  });

  it("stops a write with a limit once that many sends are each found to have made nothing", async () => {
    const EXHAUSTED = "None of three tries made this.";
    let exhausted = { sends: 3, message: EXHAUSTED };
    let { markers, host } = markerStore();
    let { step, send } = fakeStep({
      repeatable: false, exhausted, send: async () => { throw new Error("no answer"); },
    });
    for (let sends = 1; sends <= 3; sends++) {
      expect((await failureOf(sendOnce(host, 7, step))).message).toBe(UNCONFIRMED);
      expect(send).toHaveBeenCalledTimes(sends);
      expect(markers.get(7)).toEqual(
        { at: expect.any(Number), ...(sends > 1 ? { failedSends: sends - 1 } : {}) });
    }
    // The look finds the third send empty too: failed for good, unsent, with no marker left.
    let failure = await failureOf(sendOnce(host, 7, step));
    expect(failure).toBeInstanceOf(ActionApplyError);
    expect(failure.message).toBe(EXHAUSTED);
    expect(send).toHaveBeenCalledTimes(3);
    expect(markers.has(7)).toBe(false);

    // A write with no limit is sent as often as it is approved, and counts nothing.
    let free = markerStore({ at: 1000 });
    let unlimited = fakeStep({ send: async () => { throw new Error("no answer"); } });
    for (let sends = 1; sends <= 5; sends++) {
      expect((await failureOf(sendOnce(free.host, 7, unlimited.step))).message).toBe(UNCONFIRMED);
      expect(free.markers.get(7)).toEqual({ at: expect.any(Number) });
    }
    expect(unlimited.send).toHaveBeenCalledTimes(5);
  });

  it("leaves a write pending while a look cannot yet tell", async () => {
    let retry = new Error("Google Drive may still be making this.");
    for (let repeatable of [false, true]) {
      let { markers, host } = markerStore({ at: 1000 });
      let { step, check, send } = fakeStep({
        repeatable, look: async () => ({ conclusive: false, retry }),
      });
      expect(await failureOf(sendOnce(host, 7, step)), String(repeatable)).toBe(retry);
      expect(check, String(repeatable)).not.toHaveBeenCalled();
      expect(send, String(repeatable)).not.toHaveBeenCalled();
      expect(markers.get(7), String(repeatable)).toEqual({ at: 1000 });
    }

    // A look that proves nothing and names no reason says what an unconfirmed send says.
    let { markers, host } = markerStore({ at: 1000 });
    let { step, send } = fakeStep({ look: async () => ({ conclusive: false }) });
    let failure = await failureOf(sendOnce(host, 7, step));
    expect(failure.message).toBe(UNCONFIRMED);
    expect(failure).not.toBeInstanceOf(ActionApplyError);
    expect(send).not.toHaveBeenCalled();
    expect(markers.get(7)).toEqual({ at: 1000 });
  });

  it("keeps the marker of a look that cannot judge", async () => {
    let unknown = new ActionOutcomeUnknownError("This was changed again on Google Drive.");
    for (let repeatable of [false, true]) {
      let { markers, host } = markerStore({ at: 1000 });
      let { step, check, send } = fakeStep({ repeatable, look: async () => { throw unknown; } });
      expect(await failureOf(sendOnce(host, 7, step)), String(repeatable)).toBe(unknown);
      expect(check, String(repeatable)).not.toHaveBeenCalled();
      expect(send, String(repeatable)).not.toHaveBeenCalled();
      expect(markers.get(7), String(repeatable)).toEqual({ at: 1000 });
    }
  });

  type Answer = {
    answer: string;
    error: DriveApiRequestError;
    repeatable: boolean;
    /** What the approver is told. */
    message: string;
    /** Whether the write fails for good, where otherwise it stays pending. */
    forGood: boolean;
    /** Whether the marker written before the send is still there. */
    kept: boolean;
    /** The class the send's failure is logged as. */
    outcome: string;
  };
  let pending = { forGood: false };
  let answers: Answer[] = [false, true].flatMap((repeatable): Answer[] => [
    {
      answer: "a 503", error: new DriveApiRequestError(503, "backendError"), repeatable,
      message: UNCONFIRMED, ...pending, kept: true, outcome: "unknown",
    },
    {
      answer: "a 429", error: new DriveApiRequestError(429, "rateLimitExceeded"), repeatable,
      message: RATE_LIMITED, ...pending, kept: repeatable, outcome: "rateLimited",
    },
    {
      answer: "a 403 for the rate of sharing",
      error: new DriveApiRequestError(403, "sharingRateLimitExceeded"), repeatable,
      message: RATE_LIMITED, ...pending, kept: repeatable, outcome: "rateLimited",
    },
    {
      answer: "a 403 for a missing scope",
      error: new DriveApiRequestError(403, "insufficientPermissions"), repeatable,
      message: WRITES_GRANT_MISSING, ...pending, kept: repeatable, outcome: "absent",
    },
    repeatable ? {
      answer: "a 401", error: new DriveApiRequestError(401, "authError"), repeatable,
      message: CREDENTIALS_NOT_ACCEPTED, ...pending, kept: true, outcome: "unauthorized",
    } : {
      answer: "a 401", error: new DriveApiRequestError(401, "authError"), repeatable,
      message: REFUSED, forGood: true, kept: false, outcome: "absent",
    },
    {
      answer: "a 403 Google gives for the change itself",
      error: new DriveApiRequestError(403, "cannotDeletePermission"), repeatable,
      message: REFUSED, forGood: true, kept: false, outcome: "absent",
    },
    repeatable ? {
      answer: "a 400", error: new DriveApiRequestError(400, "invalidSharingRequest"), repeatable,
      message: REFUSED, forGood: true, kept: false, outcome: "absent",
    } : {
      answer: "a 400", error: new DriveApiRequestError(400, "invalidSharingRequest"), repeatable,
      message: UNCONFIRMED, ...pending, kept: true, outcome: "unknown",
    },
    {
      answer: "a 400 for the response mask",
      error: new DriveApiRequestError(400, "invalidParameter"), repeatable,
      message: UNCONFIRMED, ...pending, kept: true, outcome: "unknown",
    },
  ]);

  it.each(answers)("classifies a send's answer: $answer, repeatable $repeatable",
    async ({ error, repeatable, message, forGood, kept, outcome }) => {
      let { markers, host } = markerStore();
      let { step, refusal } = fakeStep({ repeatable, send: async () => { throw error; } });
      let failure = await failureOf(sendOnce(host, 7, step));
      expect(failure.message).toBe(message);
      expect(failure instanceof ActionApplyError).toBe(forGood);
      expect(markers.get(7)).toEqual(kept ? { at: expect.any(Number) } : undefined);
      if (forGood) expect(refusal).toHaveBeenCalledWith(error);
      else expect(refusal).not.toHaveBeenCalled();
      expect(warn.mock.calls.map(([line]) => line)).toEqual([expect.objectContaining({
        event: "drive.test.send.failed", outcome, httpStatus: error.status,
        providerReasons: [error.reason], actionId: 7,
      })]);
      expect(info).not.toHaveBeenCalled();
    });

  it("says a send Google answered 401 was not accepted, in these words", () => {
    expect(CREDENTIALS_NOT_ACCEPTED).toBe(
      "Google did not accept this connection's credentials for this change. Approve it again, " +
      "which first checks the file; if it is refused the same way, reconnect the Google account.");
  });

  it("leaves the outcome open when a send fails without an answer from Drive", async () => {
    for (let repeatable of [false, true]) {
      let { markers, host } = markerStore();
      let lost = new TypeError("fetch failed");
      let { step } = fakeStep({ repeatable, send: async () => { throw lost; } });
      let failure = await failureOf(sendOnce(host, 7, step));
      expect(failure.message, String(repeatable)).toBe(UNCONFIRMED);
      expect(failure.cause, String(repeatable)).toBe(lost);
      expect(markers.get(7), String(repeatable)).toEqual({ at: expect.any(Number) });
    }
  });

  it("drops the marker when a check fails the write for good", async () => {
    let gone = new ActionApplyError("That file is no longer in this connection's scope.");
    let { markers, host } = markerStore({ at: 1000 });
    let { step, send } = fakeStep({ repeatable: true, check: async () => { throw gone; } });
    expect(await failureOf(sendOnce(host, 7, step))).toBe(gone);
    expect(send).not.toHaveBeenCalled();
    expect(markers.size).toBe(0);
  });

  it("stores attempt markers under driveComments:attempt:, the key markers in storage have", () => {
    expect(WRITE_ATTEMPT_PREFIX).toBe("driveComments:attempt:");

    // A marker a comment's send left in storage, with the replies it noted, is read as it is.
    let kv = new MemoryKv();
    kv.put("driveComments:attempt:7", { at: 1000, existing: ["reply-1"] });
    let attempts = writeAttempts(kv);
    expect(attempts.get(7)).toEqual({ at: 1000, existing: ["reply-1"] });
    expect(attempts.get(8)).toBeUndefined();

    attempts.put(8, { at: 2000 });
    attempts.put(9, { at: 3000 });
    kv.put("drive:action:9", { state: "pending" });
    expect([...kv.entries.keys()]).toEqual([
      "driveComments:attempt:7", "driveComments:attempt:8", "driveComments:attempt:9",
      "drive:action:9",
    ]);
    attempts.delete(8);
    expect(attempts.get(8)).toBeUndefined();

    // A sweep keeps the markers of the actions named and touches no other key.
    attempts.sweep(new Set([9]));
    expect([...kv.entries.keys()]).toEqual(["driveComments:attempt:9", "drive:action:9"]);
  });
});

describe("a deployment that keeps Google Drive read-only", () => {
  it("reads the deployment's setting, and anything it does not recognize as read", () => {
    expect(driveAccessCap({})).toBe("write");
    for (let value of ["", "write", " Write "]) {
      expect(driveAccessCap({ GOOGLE_DRIVE_ACCESS: value }), value).toBe("write");
    }
    for (let value of ["read", " READ ", "readonly", "none", "true"]) {
      expect(driveAccessCap({ GOOGLE_DRIVE_ACCESS: value }), value).toBe("read");
    }
  });

  it("refuses every binding of a read-only deployment first, without asking the account", async () => {
    let scope: DriveBindingScope = { kind: "folder", folderId: "R" };
    let holdsGrant = vi.fn(async () => true);
    let refused = await writeRefusal({ deployment: "read", access: "write", scope, holdsGrant });
    expect(refused).toBe(
      "This deployment keeps Google Drive read-only, so no Google Drive connection can make " +
      "changes, and none can be connected with read and write access. Only the deployment's " +
      "administrator can change that.");
    expect(refused).toBe(DEPLOYMENT_READ_ONLY);
    // A read-only binding is told of the deployment too, and not of a URL it would refuse.
    expect(await writeRefusal({ deployment: "read", scope, holdsGrant })).toBe(DEPLOYMENT_READ_ONLY);
    expect(DEPLOYMENT_READ_ONLY).not.toBe(readOnlyRefusal(scope));
    expect(DEPLOYMENT_READ_ONLY).not.toContain("https:");
    expect(holdsGrant).not.toHaveBeenCalled();

    // Where the deployment lets Drive connections write, the binding and the account decide.
    expect(await writeRefusal({ deployment: "write", scope, holdsGrant }))
      .toBe(readOnlyRefusal(scope));
    expect(await writeRefusal({ deployment: "write", access: "write", scope, holdsGrant }))
      .toBeUndefined();
    expect(await writeRefusal({
      deployment: "write", access: "write", scope, holdsGrant: async () => false,
    })).toBe(WRITES_GRANT_MISSING);
  });
});

describe("Drive write refusals a later approval can pass", () => {
  it("leaves a write pending for a refusal a later approval can pass", async () => {
    expect(isLiftable(WRITES_GRANT_MISSING)).toBe(true);
    expect(isLiftable(DEPLOYMENT_READ_ONLY)).toBe(true);
    expect(isLiftable(readOnlyRefusal({ kind: "account" }))).toBe(false);

    let capped =
      await failureOf(requireWritable({ writeRefusal: async () => DEPLOYMENT_READ_ONLY }));
    expect(capped.message).toBe(DEPLOYMENT_READ_ONLY);
    expect(capped).not.toBeInstanceOf(ActionApplyError);
  });

  it("leaves a write pending for the grant's refusal, and fails it for good for a read-only binding's", async () => {
    let readOnly = readOnlyRefusal({ kind: "account" });
    expect(isLiftable(WRITES_GRANT_MISSING)).toBe(true);
    expect(isLiftable(readOnly)).toBe(false);

    let missing =
      await failureOf(requireWritable({ writeRefusal: async () => WRITES_GRANT_MISSING }));
    expect(missing.message).toBe(WRITES_GRANT_MISSING);
    expect(missing).not.toBeInstanceOf(ActionApplyError);

    let refused = await failureOf(requireWritable({ writeRefusal: async () => readOnly }));
    expect(refused.message).toBe(readOnly);
    expect(refused).toBeInstanceOf(ActionApplyError);

    await expect(requireWritable({ writeRefusal: async () => undefined })).resolves.toBeUndefined();

    // A failure of the refusal's own read is passed on as it came, which leaves the write pending.
    let unreachable = new Error("account unreachable");
    expect(await failureOf(requireWritable({ writeRefusal: async () => { throw unreachable; } })))
      .toBe(unreachable);
  });
});

describe("Drive write names, IDs and refusal texts", () => {
  it("names a pending result by its action", () => {
    expect(PENDING_PREFIX).toBe("pending:");
    expect(pendingId(7)).toBe("pending:7");
    expect(isPendingId(pendingId(7))).toBe(true);
    expect(isPendingId("anyoneWithLink")).toBe(false);
    expect(isPendingId("12345")).toBe(false);
  });

  it("reads the domain of an address", () => {
    expect(addressDomain("Bob@Example.COM")).toBe("example.com");
    // What follows the last `@` is the domain, whatever a quoted local part holds.
    expect(addressDomain("\"a@b\"@Corp.example")).toBe("corp.example");
  });

  it("fences a write on the account's Drive permission ID", () => {
    expect(actorFence({ permissionId: "0123456789", emailAddress: "ada@example.com" }))
      .toEqual({ generation: "0123456789" });
    expect(actorFence({ permissionId: "0123456789" })).toEqual({ generation: "0123456789" });
  });

  it("ends every refusal with Google's code", () => {
    let rows = [{ status: 403, reason: "shareOutNotPermitted", message: "No." }];
    let refusal = (error: unknown) => driveRefusal(error, rows, "Refused.");
    expect(refusal(new DriveApiRequestError(403, "shareOutNotPermitted")))
      .toBe("No. [http=403 reason=shareOutNotPermitted]");
    expect(refusal(new DriveApiRequestError(403, "somethingNew")))
      .toBe("Refused. [http=403 reason=somethingNew]");
    expect(refusal(new DriveApiRequestError(403))).toBe("Refused. [http=403]");
    // A row answers for its status and its reason together.
    expect(refusal(new DriveApiRequestError(400, "shareOutNotPermitted")))
      .toBe("Refused. [http=400 reason=shareOutNotPermitted]");
    expect(refusal(new TypeError("fetch failed"))).toBe("Refused.");

    // The two refusals every kind shares, whatever the kind's own rows say of them.
    let shared = [
      { status: 403, reason: "domainPolicy", message: "A kind's own words." },
      { status: 403, reason: "accessNotConfigured", message: "A kind's own words." },
    ];
    for (let own of [rows, shared]) {
      expect(driveRefusal(new DriveApiRequestError(403, "domainPolicy"), own, "Refused.")).toBe(
        "Your organization's administrator does not allow this app to use Google Drive. " +
        "[http=403 reason=domainPolicy]");
      expect(driveRefusal(new DriveApiDisabledError("disabled"), own, "Refused.")).toBe(
        "The Google Drive API is not enabled for this deployment's Google project. " +
        "[http=403 reason=accessNotConfigured]");
    }
  });

  it("shows a name whole, or its first 200 characters and an ellipsis", () => {
    let whole = "x".repeat(200);
    expect(shownFileName("Plan.pdf")).toBe("Plan.pdf");
    expect(shownFileName(whole)).toBe(whole);
    expect(shownFileName("x".repeat(250))).toBe(`${whole}…`);
    // Characters are code points: a cut never splits a surrogate pair.
    expect(shownFileName("😀".repeat(200))).toBe("😀".repeat(200));
    expect(shownFileName("😀".repeat(201))).toBe(`${"😀".repeat(200)}…`);
  });
});
