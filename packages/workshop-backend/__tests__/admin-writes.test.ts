import { describe, expect, it } from "vitest";
import {
  ADMIN_WRITE_ACTIONS, MAX_ADMIN_AUDIT_ARG_LENGTH,
  type AdminVia, type AdminWriteAction, type AdminWriteArgs,
} from "@gadgets/workshop-shared/api";
import { adminWriteArgs, adminWriteDigest, adminWriteTitle } from "../src/admin-writes.js";

// A value each argument accepts.
const VALID: Required<AdminWriteArgs> = { chatId: 3, gatekeeperId: 7 };
const ALL_ARGS = Object.keys(VALID) as (keyof AdminWriteArgs)[];

// What each action takes, written out here rather than read from the code under test.
const TAKES: Record<AdminWriteAction,
    { required: (keyof AdminWriteArgs)[]; optional: (keyof AdminWriteArgs)[] }> = {
  stopAgent: { required: ["chatId"], optional: [] },
  restartWorkspace: { required: [], optional: [] },
  deleteChat: { required: ["chatId"], optional: [] },
  rejectPendingActions: { required: [], optional: ["gatekeeperId"] },
};

function pick(names: (keyof AdminWriteArgs)[]): AdminWriteArgs {
  return Object.fromEntries(names.map(name => [name, VALID[name]]));
}

/** The message of the TypeError `call` throws. */
function typeError(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return (error as TypeError).message;
  }
  throw new Error("Expected the call to throw.");
}

describe("adminWriteArgs", () => {
  it("covers every action", () => {
    expect(Object.keys(TAKES).toSorted()).toEqual([...ADMIN_WRITE_ACTIONS].toSorted());
  });

  describe.each(ADMIN_WRITE_ACTIONS)("%s", action => {
    const { required, optional } = TAKES[action];
    const full = pick([...required, ...optional]);

    it("accepts exactly its arguments", () => {
      expect(adminWriteArgs(action, full)).toStrictEqual(full);
      expect(adminWriteArgs(action, pick(required))).toStrictEqual(pick(required));
      // An argument left undefined is one not given.
      const padded = { ...full, ...Object.fromEntries(ALL_ARGS.map(name => [name, full[name]])) };
      expect(adminWriteArgs(action, padded)).toStrictEqual(full);
    });

    it("refuses a request missing a required argument, naming it", () => {
      for (let name of required) {
        const { [name]: _missing, ...rest } = full;
        expect(typeError(() => adminWriteArgs(action, rest)))
            .toBe(`"${action}" needs \`${name}\`.`);
      }
    });

    it("refuses every argument it does not take, naming it", () => {
      for (let name of ALL_ARGS) {
        if (name in full) continue;
        expect(typeError(() => adminWriteArgs(action, { ...full, [name]: VALID[name] })))
            .toBe(`"${action}" takes no \`${name}\`.`);
      }
    });
  });

  it("refuses a property that is no argument at all, cutting a long name", () => {
    const args = { chatId: 3, chatID: 4 } as AdminWriteArgs;
    expect(typeError(() => adminWriteArgs("stopAgent", args)))
        .toBe("\"stopAgent\" takes no `chatID`.");

    const long = { chatId: 3, ["x".repeat(5000)]: 1 } as AdminWriteArgs;
    const message = typeError(() => adminWriteArgs("stopAgent", long));
    expect(message)
        .toBe(`"stopAgent" takes no \`${"x".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…\`.`);
  });

  it("refuses an unknown action, an inherited property name included", () => {
    for (let action of ["bogus", "constructor", "toString", "__proto__", ""]) {
      expect(typeError(() => adminWriteArgs(action as AdminWriteAction, {})))
          .toBe("No such write action.");
    }
  });

  it.each(["chatId", "gatekeeperId"] as const)(
      "refuses a %s that is not a non-negative safe integer", name => {
    const action = ({ chatId: "deleteChat", gatekeeperId: "rejectPendingActions" } as const)[name];
    const full = pick(TAKES[action].required);
    for (let value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(typeError(() => adminWriteArgs(action, { ...full, [name]: value })))
          .toBe(`\`${name}\` must be a non-negative whole number.`);
    }
    expect(adminWriteArgs(action, { ...full, [name]: 0 })[name]).toBe(0);
    expect(adminWriteArgs(action, { ...full, [name]: Number.MAX_SAFE_INTEGER })[name])
        .toBe(Number.MAX_SAFE_INTEGER);
  });

  // Ids start at 0: a workspace's first chat and connection each have it.
  it("keeps an id of 0 as an id given, where it is optional", () => {
    expect(adminWriteArgs("rejectPendingActions", { gatekeeperId: 0 }))
        .toStrictEqual({ gatekeeperId: 0 });
  });

  it("refuses an argument it does not take when its value is 0", () => {
    expect(typeError(() => adminWriteArgs("restartWorkspace", { chatId: 0 })))
        .toBe("\"restartWorkspace\" takes no `chatId`.");
    expect(typeError(() => adminWriteArgs("stopAgent", { chatId: 3, gatekeeperId: 0 })))
        .toBe("\"stopAgent\" takes no `gatekeeperId`.");
  });

  it("refuses an action ADMIN_WRITE_ACTIONS does not list and an argument AdminWriteArgs does " +
      "not declare, each by name", () => {
    for (let action of ["retryAgent", "addCollaborator", "revertChat", "revertGadget",
        "deleteGadget", "deleteWorkspace", "removeConnection"]) {
      // With the arguments a client might send with it, and with none.
      for (let args of [{}, VALID]) {
        expect(typeError(() => adminWriteArgs(action as AdminWriteAction, args)))
            .toBe("No such write action.");
      }
    }

    const undeclared = {
      modelId: "provider/model", revertFrom: 12, gadgetId: 5,
      commitId: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567", username: "bob@example.test",
      grant: "workspace", note: "",
    };
    for (let action of ADMIN_WRITE_ACTIONS) {
      const { required, optional } = TAKES[action];
      const full = pick([...required, ...optional]);
      for (let [name, value] of Object.entries(undeclared)) {
        expect(typeError(() => adminWriteArgs(action, { ...full, [name]: value })))
            .toBe(`"${action}" takes no \`${name}\`.`);
      }
    }
  });
});

describe("adminWriteTitle", () => {
  const TITLES: Record<AdminWriteAction, string> = {
    stopAgent: "Stop the agent in chat 3",
    restartWorkspace: "Restart the workspace",
    deleteChat: "Delete chat 3",
    rejectPendingActions: "Reject the pending actions of connection 7",
  };

  it.each(ADMIN_WRITE_ACTIONS)("names %s from its ids alone", action => {
    const { required, optional } = TAKES[action];
    expect(adminWriteTitle(action, pick([...required, ...optional]))).toBe(TITLES[action]);
  });

  it("names the rejection of every pending action when no connection is given", () => {
    expect(adminWriteTitle("rejectPendingActions", {})).toBe("Reject the pending actions");
  });

  it("names the rejection of connection 0's pending actions as that connection's alone", () => {
    expect(adminWriteTitle("rejectPendingActions", { gatekeeperId: 0 }))
        .toBe("Reject the pending actions of connection 0");
  });
});

describe("adminWriteDigest", () => {
  const request = {
    id: "4c1d2a0e-8a53-4c59-9a0e-3d7f1b6c2e11",
    workspaceId: "a".repeat(64),
    workspaceTitle: "Quarterly report",
    workspaceOwner: "bob@example.test",
    action: "rejectPendingActions" as AdminWriteAction,
    // Both arguments, which no action takes together, so that the order of their keys counts.
    args: { chatId: 3, gatekeeperId: 7 } as AdminWriteArgs,
    reason: "Ticket 7: the owner asked for it",
    requestedBy: "admin@example.test",
    via: "cli" as AdminVia,
    requestedAt: new Date("2026-01-02T03:04:05.000Z"),
    expiresAt: new Date("2026-01-02T03:14:05.000Z"),
  };
  const hex = async (value: typeof request) => (await adminWriteDigest(value)).toHex();

  it("is a SHA-256 that depends on no key order and on nothing else stored", async () => {
    const digest = await adminWriteDigest(request);
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.length).toBe(32);

    const reordered = {
      ...Object.fromEntries(Object.entries(request).toReversed()),
      args: { gatekeeperId: 7, chatId: 3 },
    } as typeof request;
    expect(Object.keys(reordered)[0]).toBe("expiresAt");
    expect(await hex(reordered)).toBe(digest.toHex());

    // What a stored request holds besides: none of it is what an approval signs.
    const stored = { ...request, sessionId: "session", state: "pending", resolvedBy: "x" };
    expect(await hex(stored)).toBe(digest.toHex());
  });

  it("is the SHA-256 of the request as canonical JSON, its times in milliseconds", async () => {
    // Keys sorted at every level, and nothing but what never changes of the request.
    const canonical = `{"action":"rejectPendingActions","args":{"chatId":3,"gatekeeperId":7},` +
        `"expiresAt":1767323645000,"id":"4c1d2a0e-8a53-4c59-9a0e-3d7f1b6c2e11",` +
        `"reason":"Ticket 7: the owner asked for it","requestedAt":1767323045000,` +
        `"requestedBy":"admin@example.test","via":"cli",` +
        `"workspaceId":"${"a".repeat(64)}","workspaceOwner":"bob@example.test",` +
        `"workspaceTitle":"Quarterly report"}`;
    const sha256 = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    expect(await hex(request)).toBe(new Uint8Array(sha256).toHex());
  });

  it.each<[string, Partial<typeof request>]>([
    ["id", { id: "4c1d2a0e-8a53-4c59-9a0e-3d7f1b6c2e12" }],
    ["workspace id", { workspaceId: "b".repeat(64) }],
    ["title", { workspaceTitle: "Quarterly report 2" }],
    ["owner", { workspaceOwner: "mallory@example.test" }],
    ["action", { action: "deleteChat" }],
    ["argument", { args: { ...request.args, gatekeeperId: 8 } }],
    ["set of arguments", { args: { chatId: 3 } }],
    ["reason", { reason: "Ticket 8: the owner asked for it" }],
    ["requester", { requestedBy: "other-admin@example.test" }],
    ["via", { via: "api" }],
    ["request time", { requestedAt: new Date("2026-01-02T03:04:05.001Z") }],
    ["expiry", { expiresAt: new Date("2026-01-02T03:14:05.001Z") }],
  ])("differs when the %s changes", async (_what, change) => {
    expect(await hex({ ...request, ...change })).not.toBe(await hex(request));
  });
});
