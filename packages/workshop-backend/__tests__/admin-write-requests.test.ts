import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_WRITE_ERROR_CODES, ADMIN_WRITE_REQUEST_LIFETIME_SECONDS,
  DEFAULT_ADMIN_AUDIT_RETENTION_DAYS, MAX_PENDING_ADMIN_WRITES,
  getAdminWriteErrorCode,
  type AdminAuditRecord, type AdminWriteRecord,
} from "@gadgets/workshop-shared/api";
import type { AdminWriteActor } from "../src/admin-access.js";
import type { AdminSettings } from "../src/admin-settings.js";
import type { StoredAdminWrite } from "../src/admin-writes.js";
import { ADMIN, OTHER_ADMIN, adminWritesHarness } from "./admin-writes-harness";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEMOTED = "Its requester is no longer a deployment admin.";

let harness: ReturnType<typeof adminWritesHarness>;

beforeEach(() => {
  harness = adminWritesHarness();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.inDo((_admin, state) => state.storage.deleteAlarm());
});

/** A pending request as AdminApiImpl builds one, made by ADMIN from the CLI. */
function pendingWrite(overrides: Partial<StoredAdminWrite> = {}): StoredAdminWrite {
  const requestedAt = new Date();
  return {
    id: crypto.randomUUID(), workspaceId: "a".repeat(64), workspaceTitle: "Quarterly report",
    workspaceOwner: "bob@example.test", action: "deleteChat", args: { chatId: 3 },
    reason: "Ticket 7: chat is stuck", requestedBy: ADMIN, via: "cli",
    sessionId: "session of the requester", requestedAt,
    expiresAt: new Date(requestedAt.getTime() + ADMIN_WRITE_REQUEST_LIFETIME_SECONDS * 1000),
    state: "pending",
    ...overrides,
  };
}

function actor(admin: string): AdminWriteActor {
  return { admin, sessionId: `session of ${admin}`, via: "api" };
}

/** The record of `request`'s step `event`: taken by its requester, through the request's own
 * session and client, unless `by` is given, and with pendingWrite()'s arguments unless `extra`
 * holds the request's own as the audit log keeps them. */
function recordOf(request: StoredAdminWrite, event: AdminWriteRecord["event"],
    by?: AdminWriteActor, extra: object = {}): unknown {
  const { requestedBy: admin, sessionId, via } = request;
  return {
    kind: "write", at: expect.any(Date), ...(by ?? { admin, sessionId, via }),
    requestId: request.id, event,
    workspaceId: request.workspaceId, workspaceOwner: request.workspaceOwner,
    workspaceTitle: request.workspaceTitle, method: request.action, args: { chatId: 3 },
    reason: request.reason, requestedBy: request.requestedBy, ...extra,
  };
}

const eventsOf = (id: string) => harness.appended
    .filter((record): record is AdminWriteRecord => record.kind === "write")
    .filter(record => record.requestId === id).map(record => record.event);

/** What `call` rejects with. Awaited inside the Durable Object, so the error is the one thrown. */
async function rejection(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject.");
}

const codeOf = async (call: Promise<unknown>) => getAdminWriteErrorCode(await rejection(call));

/** Makes a request through the object, and returns it as stored. */
async function requestWrite(overrides: Partial<StoredAdminWrite> = {})
    : Promise<StoredAdminWrite> {
  const made = pendingWrite(overrides);
  await harness.inDo(admin => admin.requestWorkspaceWrite(made));
  return made;
}

/** Moves a stored request's expiry into the past, as time passing would. */
function age(admin: AdminSettings, id: string, by = 1000): Date {
  const writes = harness.storageOf(admin).adminWrites;
  const expiresAt = new Date(Date.now() - by);
  writes.put({ ...writes.get(id)!, expiresAt });
  return expiresAt;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** Has `admin` append to a log that keeps the retention each write record comes with, which the
 * harness's own log ignores. Returns them as [event, days], in order. */
function writeRetentionsOf(admin: AdminSettings): [AdminWriteRecord["event"], number][] {
  const retentions: [AdminWriteRecord["event"], number][] = [];
  Object.assign(admin, { audits: { getByName: () => ({
    append: async (record: AdminAuditRecord, retentionDays: number) => {
      if (record.kind === "write") retentions.push([record.event, retentionDays]);
    },
  }) } });
  return retentions;
}

describe("requestWorkspaceWrite", () => {
  it("records \"requested\" before it stores the request", async () => {
    // Not from the CLI: the record says how its own request was made.
    const made = pendingWrite({ via: "api" });
    await harness.inDo(async admin => {
      const writes = harness.storageOf(admin).adminWrites;
      let storedAtAppend: unknown = "never appended";
      harness.audit.before = async () => { storedAtAppend = writes.get(made.id); };
      await admin.requestWorkspaceWrite(made);
      expect(storedAtAppend).toBeUndefined();
      expect(writes.get(made.id)).toStrictEqual(made);
    });
    expect(harness.appended).toStrictEqual([recordOf(made, "requested")]);
  });

  it("stores nothing when the record cannot be appended", async () => {
    const made = pendingWrite();
    harness.audit.fail = true;
    await harness.inDo(async (admin, state) => {
      expect(await rejection(admin.requestWorkspaceWrite(made)))
          .toStrictEqual(new Error("audit log unavailable"));
      expect([...harness.storageOf(admin).adminWrites.list()]).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(harness.appended).toEqual([]);
  });

  it("ends the overdue requests first, which then no longer count as pending", async () => {
    const overdue = Array.from({ length: MAX_PENDING_ADMIN_WRITES }, () => pendingWrite());
    const next = pendingWrite();
    await harness.inDo(async admin => {
      const writes = harness.storageOf(admin).adminWrites;
      for (let stored of overdue) {
        writes.put(stored);
        age(admin, stored.id);
      }

      await admin.requestWorkspaceWrite(next);
      expect(writes.get(next.id)).toStrictEqual(next);
      expect(overdue.map(stored => writes.get(stored.id)?.state))
          .toEqual(overdue.map(() => "expired"));
    });
    // Every one of them recorded "expired", and only then the request that takes a place.
    expect(harness.appended.map(record => (record as AdminWriteRecord).event))
        .toEqual([...overdue.map(() => "expired"), "requested"]);
    expect(eventsOf(next.id)).toEqual(["requested"]);
  });

  it("refuses the request past MAX_PENDING_ADMIN_WRITES pending, recording nothing", async () => {
    const pending = Array.from({ length: MAX_PENDING_ADMIN_WRITES }, () => pendingWrite());
    await harness.inDo(async admin => {
      const writes = harness.storageOf(admin).adminWrites;
      for (let stored of pending) writes.put(stored);

      // The limit is the deployment's: those pending are all one admin's, and another admin
      // finds no room.
      const theirs = pendingWrite({ requestedBy: OTHER_ADMIN });
      expect(await codeOf(admin.requestWorkspaceWrite(theirs)))
          .toBe(ADMIN_WRITE_ERROR_CODES.tooManyRequests);
      expect([...writes.list()]).toHaveLength(MAX_PENDING_ADMIN_WRITES);
      expect(harness.appended).toEqual([]);

      // A resolved request is kept, and no longer counts.
      await admin.denyWorkspaceWrite(pending[0].id, actor(OTHER_ADMIN));
      const next = pendingWrite();
      await admin.requestWorkspaceWrite(next);
      expect(writes.get(next.id)?.state).toBe("pending");
      expect([...writes.list()]).toHaveLength(MAX_PENDING_ADMIN_WRITES + 1);
    });
  });

  it("runs one at a time: requests made together are stored up to the limit, in order",
      async () => {
    const made = Array.from({ length: MAX_PENDING_ADMIN_WRITES + 10 }, () => pendingWrite());
    await harness.inDo(async admin => {
      const settled = await Promise.allSettled(
          made.map(request => admin.requestWorkspaceWrite(request)));
      // Each counts the requests that those made before it stored, so the last ten find no room.
      expect(settled.map(result =>
          result.status === "rejected" ? getAdminWriteErrorCode(result.reason) : "stored"))
          .toEqual(made.map((_request, index) => index < MAX_PENDING_ADMIN_WRITES
              ? "stored" : ADMIN_WRITE_ERROR_CODES.tooManyRequests));
      expect([...harness.storageOf(admin).adminWrites.list()])
          .toHaveLength(MAX_PENDING_ADMIN_WRITES);
    });
    expect(harness.appended).toStrictEqual(
        made.slice(0, MAX_PENDING_ADMIN_WRITES).map(request => recordOf(request, "requested")));
  });
});

describe("getWorkspaceWrite", () => {
  it("returns the stored request, recording nothing", async () => {
    const made = await requestWrite();
    expect(await harness.inDo(admin => admin.getWorkspaceWrite(made.id))).toStrictEqual(made);
    expect(eventsOf(made.id)).toEqual(["requested"]);
  });

  it("finds nothing under an unknown id, or under one that is not an id", async () => {
    await requestWrite();
    for (let id of [crypto.randomUUID(), "", "nope", "x".repeat(5000)]) {
      expect(await harness.inDo(admin => codeOf(admin.getWorkspaceWrite(id))))
          .toBe(ADMIN_WRITE_ERROR_CODES.requestNotFound);
    }
  });

  it("never uses a string of another length than an id's as a storage key", async () => {
    await harness.inDo(async admin => {
      const get = vi.spyOn(harness.storageOf(admin).adminWrites, "get");
      for (let id of ["", "nope", "x".repeat(35), "x".repeat(37), "x".repeat(5000)]) {
        expect(await codeOf(admin.getWorkspaceWrite(id)))
            .toBe(ADMIN_WRITE_ERROR_CODES.requestNotFound);
        expect(await codeOf(admin.denyWorkspaceWrite(id, actor(ADMIN))))
            .toBe(ADMIN_WRITE_ERROR_CODES.requestNotFound);
      }
      expect(get).not.toHaveBeenCalled();

      // One of an id's length is looked up, whatever it holds.
      const id = "x".repeat(36);
      expect(await codeOf(admin.getWorkspaceWrite(id)))
          .toBe(ADMIN_WRITE_ERROR_CODES.requestNotFound);
      expect(get.mock.calls).toEqual([[id]]);
    });
  });
});

describe("denyWorkspaceWrite", () => {
  it("records the denial, then stores it, and refuses a second one", async () => {
    const made = await requestWrite({ requestedAt: new Date(Date.now() - 5000) });
    await harness.inDo(async admin => {
      const writes = harness.storageOf(admin).adminWrites;
      let stateAtAppend: unknown;
      harness.audit.before = async () => { stateAtAppend = writes.get(made.id)?.state; };
      const before = Date.now();
      await admin.denyWorkspaceWrite(made.id, actor(OTHER_ADMIN));
      const after = Date.now();
      expect(stateAtAppend).toBe("pending");

      const denied = writes.get(made.id)!;
      expect(denied).toStrictEqual(
          { ...made, state: "denied", resolvedBy: OTHER_ADMIN, resolvedAt: expect.any(Date) });
      // Resolved when it was denied: neither when it was requested nor when it would have run out.
      expect(denied.resolvedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(denied.resolvedAt!.getTime()).toBeLessThanOrEqual(after);
      expect(await admin.getWorkspaceWrite(made.id)).toStrictEqual(denied);

      expect(await codeOf(admin.denyWorkspaceWrite(made.id, actor(ADMIN))))
          .toBe(ADMIN_WRITE_ERROR_CODES.requestNotPending);
      expect(writes.get(made.id)).toStrictEqual(denied);
    });
    expect(harness.appended).toStrictEqual(
        [recordOf(made, "requested"), recordOf(made, "denied", actor(OTHER_ADMIN))]);
  });

  it("leaves the request pending when the denial cannot be recorded", async () => {
    const made = await requestWrite();
    harness.audit.fail = true;
    await harness.inDo(async admin => {
      expect(await rejection(admin.denyWorkspaceWrite(made.id, actor(OTHER_ADMIN))))
          .toStrictEqual(new Error("audit log unavailable"));
      expect(harness.storageOf(admin).adminWrites.get(made.id)).toStrictEqual(made);
    });
  });

  it("finds nothing to deny under an unknown id", async () => {
    expect(await harness.inDo(
        admin => codeOf(admin.denyWorkspaceWrite(crypto.randomUUID(), actor(ADMIN)))))
        .toBe(ADMIN_WRITE_ERROR_CODES.requestNotFound);
    expect(harness.appended).toEqual([]);
  });

  it("runs one at a time: a denial started during another's append waits for it", async () => {
    const made = await requestWrite();
    const release = Promise.withResolvers<void>();
    let appending = 0;
    harness.audit.before = async () => {
      appending++;
      await release.promise;
    };
    await harness.inDo(async admin => {
      const settled: string[] = [];
      const first = admin.denyWorkspaceWrite(made.id, actor(ADMIN))
          .then(() => { settled.push("first"); });
      const second = codeOf(admin.denyWorkspaceWrite(made.id, actor(OTHER_ADMIN)))
          .then(code => { settled.push("second"); return code; });

      // The first holds its append open; the second has not read the request yet, or it would
      // be appending a denial of its own.
      await tick();
      await tick();
      expect(appending).toBe(1);
      expect(settled).toEqual([]);

      release.resolve();
      await first;
      expect(await second).toBe(ADMIN_WRITE_ERROR_CODES.requestNotPending);
      expect(settled).toEqual(["first", "second"]);
      expect(harness.storageOf(admin).adminWrites.get(made.id)?.resolvedBy).toBe(ADMIN);
    });
    expect(eventsOf(made.id)).toEqual(["requested", "denied"]);
  });

  it("keeps running after a call that failed", async () => {
    const made = await requestWrite();
    await harness.inDo(async admin => {
      harness.audit.fail = true;
      await rejection(admin.denyWorkspaceWrite(made.id, actor(ADMIN)));
      harness.audit.fail = false;
      await admin.denyWorkspaceWrite(made.id, actor(ADMIN));
    });
    expect(eventsOf(made.id)).toEqual(["requested", "denied"]);
  });
});

describe("expiry", () => {
  it("is recorded once by the alarm, in the requester's name, then stored", async () => {
    // Not from the CLI: the record the alarm writes says how the request was made.
    const made = await requestWrite({ via: "api", requestedAt: new Date(Date.now() - 5000) });
    await harness.inDo(async admin => {
      const writes = harness.storageOf(admin).adminWrites;
      const expiresAt = age(admin, made.id);
      let stateAtAppend: unknown;
      harness.audit.before = async () => { stateAtAppend = writes.get(made.id)?.state; };
      const before = Date.now();
      await admin.alarm();
      expect(stateAtAppend).toBe("pending");
      // The record is dated when the alarm met the request: neither when it was requested nor
      // when it ran out.
      const recordedAt = harness.appended.at(-1)!.at.getTime();
      expect(recordedAt).toBeGreaterThanOrEqual(before);
      expect(recordedAt).toBeLessThanOrEqual(Date.now());
      // Resolved when it ran out, by nobody, and with no error: it simply ran out.
      expect(writes.get(made.id)).toStrictEqual(
          { ...made, expiresAt, state: "expired", resolvedAt: expiresAt });

      await admin.alarm();
      await admin.getWorkspaceWrite(made.id);
    });
    expect(harness.appended).toStrictEqual(
        [recordOf(made, "requested"), recordOf(made, "expired")]);
  });

  it("is found by a read before any alarm", async () => {
    const made = await requestWrite();
    const read = await harness.inDo(admin => {
      age(admin, made.id);
      return admin.getWorkspaceWrite(made.id);
    });
    expect(read.state).toBe("expired");
    expect(eventsOf(made.id)).toEqual(["requested", "expired"]);
  });

  it("is recorded once by two concurrent calls", async () => {
    const made = await requestWrite();
    await harness.inDo(async admin => {
      age(admin, made.id);
      const [read, denial] = await Promise.all([
        admin.getWorkspaceWrite(made.id),
        codeOf(admin.denyWorkspaceWrite(made.id, actor(OTHER_ADMIN))),
        admin.alarm(),
      ]);
      expect(read.state).toBe("expired");
      expect(denial).toBe(ADMIN_WRITE_ERROR_CODES.requestNotPending);
    });
    expect(eventsOf(made.id)).toEqual(["requested", "expired"]);
  });

  it("is recorded once when a new request is made while it is read", async () => {
    const overdue = await requestWrite();
    const next = pendingWrite();
    await harness.inDo(async admin => {
      age(admin, overdue.id);
      const [, read] = await Promise.all(
          [admin.requestWorkspaceWrite(next), admin.getWorkspaceWrite(overdue.id)]);
      expect(read.state).toBe("expired");
    });
    // The new request's sweep ends the overdue one, and the read waits for it rather than end it
    // again.
    expect(harness.appended).toStrictEqual([
      recordOf(overdue, "requested"), recordOf(overdue, "expired"), recordOf(next, "requested"),
    ]);
  });

  it("comes before a denial: an overdue request is no longer pending", async () => {
    const made = await requestWrite();
    await harness.inDo(async admin => {
      age(admin, made.id);
      expect(await codeOf(admin.denyWorkspaceWrite(made.id, actor(OTHER_ADMIN))))
          .toBe(ADMIN_WRITE_ERROR_CODES.requestNotPending);
      expect(harness.storageOf(admin).adminWrites.get(made.id)?.state).toBe("expired");
    });
    expect(eventsOf(made.id)).toEqual(["requested", "expired"]);
  });

  it("ends a request whose requester is no longer an admin, ahead of its time", async () => {
    const made = await requestWrite();
    const before = Date.now();
    const read = await harness.inDo(
        admin => admin.getWorkspaceWrite(made.id), { ADMINS: [OTHER_ADMIN] });
    expect(read).toStrictEqual(
        { ...made, state: "expired", resolvedAt: expect.any(Date), error: DEMOTED });
    expect(read.resolvedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(read.resolvedAt!.getTime()).toBeLessThan(made.expiresAt.getTime());
    expect(harness.appended).toStrictEqual([
      recordOf(made, "requested"), recordOf(made, "expired", undefined, { error: DEMOTED }),
    ]);

    // Another admin's request stands.
    const theirs = await requestWrite({ requestedBy: OTHER_ADMIN });
    await harness.inDo(async admin => {
      expect((await admin.getWorkspaceWrite(theirs.id)).state).toBe("pending");
    }, { ADMINS: [OTHER_ADMIN] });
  });

  it("ends a demoted requester's request made after one that stays pending", async () => {
    const standing = await requestWrite(
        { requestedBy: OTHER_ADMIN, requestedAt: new Date(Date.now() - 2000) });
    const demoted = await requestWrite({ requestedAt: new Date(Date.now() - 1000) });
    await harness.inDo(async admin => {
      // The sweep meets the older request first, finds nothing due for it, and goes on.
      expect((await admin.getWorkspaceWrite(demoted.id)).state).toBe("expired");
      expect((await admin.getWorkspaceWrite(standing.id)).state).toBe("pending");
    }, { ADMINS: [OTHER_ADMIN] });
    expect(harness.appended).toStrictEqual([
      recordOf(standing, "requested"), recordOf(demoted, "requested"),
      recordOf(demoted, "expired", undefined, { error: DEMOTED }),
    ]);
  });

  it.each([["at", 0], ["after", 60_000]])(
      "simply ran out %s its expiry, though its requester is no longer an admin by then",
      async (_when, late) => {
    const made = await requestWrite();
    await harness.inDo(async admin => {
      // As the alarm meets it: the alarm is set for the request's expiry.
      vi.spyOn(Date, "now").mockReturnValue(made.expiresAt.getTime() + late);
      await admin.alarm();
      expect(harness.storageOf(admin).adminWrites.get(made.id)).toStrictEqual(
          { ...made, state: "expired", resolvedAt: made.expiresAt });
    }, { ADMINS: [OTHER_ADMIN] });
    // No `error`: that says why a request ended before its time.
    expect(harness.appended).toStrictEqual(
        [recordOf(made, "requested"), recordOf(made, "expired")]);
  });

  it("ends the overdue requests oldest first, and stops at a record it cannot write", async () => {
    // Storage lists requests by id, and these ids sort against the requests' ages: the order they
    // end in is the sweep's, not the listing's.
    const newer = await requestWrite(
        { id: "00000000-0000-4000-8000-000000000000", requestedAt: new Date(Date.now() - 2000) });
    const older = await requestWrite(
        { id: "ffffffff-0000-4000-8000-000000000000", requestedAt: new Date(Date.now() - 3000) });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await harness.inDo(async admin => {
      const writes = harness.storageOf(admin).adminWrites;
      age(admin, newer.id);
      age(admin, older.id);
      let appends = 0;
      harness.audit.before = async () => {
        if (++appends === 2) throw new Error("audit log unavailable");
      };
      await admin.alarm();
      expect(writes.get(older.id)?.state).toBe("expired");
      expect(writes.get(newer.id)?.state).toBe("pending");

      harness.audit.before = undefined;
      await admin.alarm();
      expect(writes.get(newer.id)?.state).toBe("expired");
    });
    expect(harness.appended.slice(2)).toStrictEqual(
        [recordOf(older, "expired"), recordOf(newer, "expired")]);
  });
});

describe("a write record", () => {
  it("keeps the request's own arguments by name", async () => {
    const args = { gatekeeperId: 0 };
    const made = await requestWrite({ action: "rejectPendingActions", args });
    await harness.inDo(async admin => {
      expect(harness.storageOf(admin).adminWrites.get(made.id)?.args).toStrictEqual(args);
      expect((await admin.getWorkspaceWrite(made.id)).args).toStrictEqual(args);
      await admin.denyWorkspaceWrite(made.id, actor(OTHER_ADMIN));
    });
    expect(harness.appended).toStrictEqual([
      recordOf(made, "requested", undefined, { args }),
      recordOf(made, "denied", actor(OTHER_ADMIN), { args }),
    ]);
  });

  it("is appended with the retention the committed config and the environment give", async () => {
    const first = pendingWrite();
    const second = pendingWrite();
    await harness.inDo(async admin => {
      const retentions = writeRetentionsOf(admin);
      await admin.requestWorkspaceWrite(first);
      await admin.setAdminAuditRetentionDays(
          120, { ...actor(ADMIN), method: "setAdminAuditRetentionDays" });
      await admin.denyWorkspaceWrite(first.id, actor(OTHER_ADMIN));
      await admin.requestWorkspaceWrite(second);
      expect(retentions).toEqual([
        ["requested", DEFAULT_ADMIN_AUDIT_RETENTION_DAYS], ["denied", 120], ["requested", 120],
      ]);
    });

    // A floor the environment sets above the admins' choice holds for the records made under it.
    await harness.inDo(async admin => {
      const retentions = writeRetentionsOf(admin);
      age(admin, second.id);
      await admin.alarm();
      expect(retentions).toEqual([["expired", 180]]);
    }, { ADMIN_AUDIT_RETENTION_MIN_DAYS: "180" });
  });
});

describe("the alarm", () => {
  it("is set for a request's expiry, then for a day after its denial", async () => {
    const made = pendingWrite();
    await harness.inDo(async (admin, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      await admin.requestWorkspaceWrite(made);
      expect(await state.storage.getAlarm()).toBe(made.expiresAt.getTime());

      await admin.denyWorkspaceWrite(made.id, actor(OTHER_ADMIN));
      const { resolvedAt } = harness.storageOf(admin).adminWrites.get(made.id)!;
      expect(await state.storage.getAlarm()).toBe(resolvedAt!.getTime() + DAY_MS);
    });
  });

  it("is set for whichever stored request is due first, wherever it is listed or made",
      async () => {
    // Storage lists requests by id: the one due first is neither the first nor the last listed,
    // and neither the first nor the last made.
    const sooner = pendingWrite({
      id: "88888888-0000-4000-8000-000000000000", expiresAt: new Date(Date.now() + 120_000),
    });
    await harness.inDo(async (admin, state) => {
      await admin.requestWorkspaceWrite(
          pendingWrite({ id: "00000000-0000-4000-8000-000000000000" }));
      await admin.requestWorkspaceWrite(sooner);
      await admin.requestWorkspaceWrite(
          pendingWrite({ id: "ffffffff-0000-4000-8000-000000000000" }));
      expect(await state.storage.getAlarm()).toBe(sooner.expiresAt.getTime());
    });
  });

  it("stays at a pending request's expiry when another request is denied", async () => {
    const pending = pendingWrite();
    const denied = pendingWrite();
    await harness.inDo(async (admin, state) => {
      await admin.requestWorkspaceWrite(pending);
      await admin.requestWorkspaceWrite(denied);
      await admin.denyWorkspaceWrite(denied.id, actor(OTHER_ADMIN));
      // The denied request is kept a day, and the pending one runs out long before that.
      expect(await state.storage.getAlarm()).toBe(pending.expiresAt.getTime());
    });
  });

  it("forgets a request resolved a day ago, and is cleared once none is stored", async () => {
    const made = await requestWrite();
    await harness.inDo(async (admin, state) => {
      const writes = harness.storageOf(admin).adminWrites;
      await admin.denyWorkspaceWrite(made.id, actor(OTHER_ADMIN));

      // Not yet a day: kept, and readable.
      writes.put({ ...writes.get(made.id)!, resolvedAt: new Date(Date.now() - DAY_MS + 60_000) });
      await admin.alarm();
      expect((await admin.getWorkspaceWrite(made.id)).state).toBe("denied");
      expect(await state.storage.getAlarm()).not.toBeNull();

      writes.put({ ...writes.get(made.id)!, resolvedAt: new Date(Date.now() - DAY_MS - 1000) });
      await admin.alarm();
      expect(writes.get(made.id)).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
      expect(await codeOf(admin.getWorkspaceWrite(made.id)))
          .toBe(ADMIN_WRITE_ERROR_CODES.requestNotFound);
    });
    // Forgetting a request records nothing.
    expect(eventsOf(made.id)).toEqual(["requested", "denied"]);
  });

  it("never throws: while the log fails it comes back, and records once it can", async () => {
    const made = await requestWrite();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await harness.inDo(async (admin, state) => {
      const writes = harness.storageOf(admin).adminWrites;
      const expiresAt = age(admin, made.id);
      harness.audit.fail = true;

      const before = Date.now();
      await admin.alarm();
      expect(logged.mock.calls.map(([entry]) => (entry as { event?: string }).event))
          .toEqual(["admin.write.sweep.failed"]);
      // Still stored as pending, and never read as pending: every reader sweeps first.
      expect(writes.get(made.id)?.state).toBe("pending");
      expect(await rejection(admin.getWorkspaceWrite(made.id)))
          .toStrictEqual(new Error("audit log unavailable"));
      expect(await rejection(admin.denyWorkspaceWrite(made.id, actor(OTHER_ADMIN))))
          .toStrictEqual(new Error("audit log unavailable"));
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBeGreaterThanOrEqual(before + 30_000);
      expect(alarm).toBeLessThanOrEqual(Date.now() + 30_000);

      harness.audit.fail = false;
      await admin.alarm();
      expect(writes.get(made.id)).toStrictEqual(
          { ...made, expiresAt, state: "expired", resolvedAt: expiresAt });
      // Due again once the expired request has been kept its day.
      expect(await state.storage.getAlarm()).toBe(expiresAt.getTime() + DAY_MS);
    });
    expect(eventsOf(made.id)).toEqual(["requested", "expired"]);
  });

  it("forgets the passkey challenges past their expiry", async () => {
    await harness.inDo(async admin => {
      const challenges = harness.storageOf(admin).adminPasskeyChallenges;
      const past = Date.now() - 1;
      challenges.put({ key: `approve:${ADMIN}`, challenge: "a", expiresAt: past, subject: "x" });
      challenges.put({ key: `enrol:${ADMIN}`, challenge: "b", expiresAt: past });
      challenges.put({ key: `enrol:${OTHER_ADMIN}`, challenge: "c", expiresAt: past + 60_000 });
      challenges.put({ key: `remove:${ADMIN}`, challenge: "d", expiresAt: past });
      await admin.alarm();
      expect([...challenges.list()].map(challenge => challenge.key))
          .toEqual([`enrol:${OTHER_ADMIN}`]);
    });
  });
});

// AdminApiImpl asks the same of the session Worker's environment before it calls. This object's
// can be newer: a session outlives the config its Worker started with.
describe("the object's own environment", () => {
  const CASES = [
    ["an admin who is no longer one", { ADMINS: [OTHER_ADMIN] }, ADMIN_ACCESS_ERROR_CODES.notAdmin],
    ["every admin while writes are off", { ADMIN_WORKSPACE_WRITES: "off" },
     ADMIN_WRITE_ERROR_CODES.writesOff],
  ] as const;

  it.each(CASES)("refuses a request from %s, recording and storing nothing",
      async (_who, vars, code) => {
    const error = await harness.inDo(
        admin => rejection(admin.requestWorkspaceWrite(pendingWrite())), vars);
    expect(error).toMatchObject({ code });
    expect(harness.appended).toEqual([]);
    expect(await harness.inDo(admin => [...harness.storageOf(admin).adminWrites.list()]))
        .toEqual([]);
  });

  it.each(CASES)("lets %s deny nothing", async (_who, vars, code) => {
    const theirs = await requestWrite({ requestedBy: OTHER_ADMIN });
    const error = await harness.inDo(
        admin => rejection(admin.denyWorkspaceWrite(theirs.id, actor(ADMIN))), vars);
    expect(error).toMatchObject({ code });
    expect(eventsOf(theirs.id)).toEqual(["requested"]);
    expect(await harness.inDo(admin => harness.storageOf(admin).adminWrites.get(theirs.id)))
        .toStrictEqual(theirs);
  });
});
