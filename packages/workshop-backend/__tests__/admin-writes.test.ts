import { describe, expect, it } from "vitest";
import {
  ADMIN_WRITE_ACTIONS, MAX_ADMIN_AUDIT_ARG_LENGTH,
  type AdminVia, type AdminWriteAction, type AdminWriteArgs,
} from "@gadgets/workshop-shared/api";
import {
  adminWriteArgs, adminWriteAuditArgs, adminWriteDigest, adminWriteTitle,
} from "../src/admin-writes.js";

const COMMIT = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";

// A value each argument accepts.
const VALID: Required<AdminWriteArgs> = {
  chatId: 3, modelId: "provider/model", revertFrom: 12, gadgetId: 5, commitId: COMMIT,
  gatekeeperId: 7, username: "bob@example.test", grant: "workspace", note: "For the ticket.",
};
const ALL_ARGS = Object.keys(VALID) as (keyof AdminWriteArgs)[];

// What each action takes, written out here rather than read from the code under test.
const TAKES: Record<AdminWriteAction,
    { required: (keyof AdminWriteArgs)[]; optional: (keyof AdminWriteArgs)[] }> = {
  stopAgent: { required: ["chatId"], optional: [] },
  retryAgent: { required: ["chatId"], optional: ["modelId"] },
  restartWorkspace: { required: [], optional: [] },
  addCollaborator: { required: ["username", "grant"], optional: ["note"] },
  deleteChat: { required: ["chatId"], optional: [] },
  revertChat: { required: ["chatId", "revertFrom"], optional: [] },
  revertGadget: { required: ["gadgetId", "commitId"], optional: [] },
  deleteGadget: { required: ["gadgetId"], optional: [] },
  deleteWorkspace: { required: [], optional: [] },
  rejectPendingActions: { required: [], optional: ["gatekeeperId"] },
  removeConnection: { required: ["gatekeeperId"], optional: [] },
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

  it("retries on a given model, or on none", () => {
    expect(adminWriteArgs("retryAgent", { chatId: 3, modelId: "provider/model" }))
        .toStrictEqual({ chatId: 3, modelId: "provider/model" });
    expect(adminWriteArgs("retryAgent", { chatId: 3 })).toStrictEqual({ chatId: 3 });
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

  it.each(["chatId", "revertFrom", "gadgetId", "gatekeeperId"] as const)(
      "refuses a %s that is not a non-negative safe integer", name => {
    const action = ({
      chatId: "revertChat", revertFrom: "revertChat", gadgetId: "revertGadget",
      gatekeeperId: "removeConnection",
    } as const)[name];
    const full = pick(TAKES[action].required);
    for (let value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(typeError(() => adminWriteArgs(action, { ...full, [name]: value })))
          .toBe(`\`${name}\` must be a non-negative whole number.`);
    }
    expect(adminWriteArgs(action, { ...full, [name]: 0 })[name]).toBe(0);
    expect(adminWriteArgs(action, { ...full, [name]: Number.MAX_SAFE_INTEGER })[name])
        .toBe(Number.MAX_SAFE_INTEGER);
  });

  // Ids start at 0: a workspace's first chat, gadget and connection each have it.
  it("keeps an id of 0 as an id given, where it is optional or inside a grant", () => {
    expect(adminWriteArgs("rejectPendingActions", { gatekeeperId: 0 }))
        .toStrictEqual({ gatekeeperId: 0 });
    const args = { username: "bob@example.test", grant: { gadgetId: 0 } };
    expect(adminWriteArgs("addCollaborator", args).grant).toStrictEqual({ gadgetId: 0 });
  });

  it("refuses an argument it does not take when its value is 0 or empty", () => {
    expect(typeError(() => adminWriteArgs("restartWorkspace", { chatId: 0 })))
        .toBe("\"restartWorkspace\" takes no `chatId`.");
    expect(typeError(() => adminWriteArgs("stopAgent", { chatId: 3, note: "" })))
        .toBe("\"stopAgent\" takes no `note`.");
  });

  it("refuses a commit id that is not 40 lowercase hex characters", () => {
    for (let commitId of ["", COMMIT.slice(1), `${COMMIT}0`, COMMIT.toUpperCase(),
        `${COMMIT.slice(0, 39)}g`, `${COMMIT}\n`]) {
      expect(typeError(() => adminWriteArgs("revertGadget", { gadgetId: 5, commitId })))
          .toBe("`commitId` must be 40 lowercase hex characters.");
    }
  });

  it.each(["username", "modelId", "note"] as const)(
      "refuses a %s that is blank or too long, and keeps one at the limit as given", name => {
    const action = name === "modelId" ? "retryAgent" : "addCollaborator";
    const full = pick([...TAKES[action].required, ...TAKES[action].optional]);
    // The limit is on the string as given: the whitespace around a short text counts.
    for (let value of ["", "   ", "\n\t", "x".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH + 1),
        `x${" ".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH)}`]) {
      expect(typeError(() => adminWriteArgs(action, { ...full, [name]: value }))).toBe(
          `\`${name}\` must be non-blank and at most ${MAX_ADMIN_AUDIT_ARG_LENGTH} characters.`);
    }
    const longest = ` ${"x".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}`;
    expect(adminWriteArgs(action, { ...full, [name]: longest })[name]).toBe(longest);
  });

  it("keeps a grant as \"workspace\" or as its gadget id alone", () => {
    const base = { username: "bob@example.test" };
    expect(adminWriteArgs("addCollaborator", { ...base, grant: "workspace" }).grant)
        .toBe("workspace");
    const crowded = { gadgetId: 5, role: "owner" } as AdminWriteArgs["grant"];
    expect(adminWriteArgs("addCollaborator", { ...base, grant: crowded }).grant)
        .toStrictEqual({ gadgetId: 5 });

    for (let grant of [{ gadgetId: -1 }, { gadgetId: 1.5 }, {}, "gadget", "everything"]) {
      expect(typeError(() => adminWriteArgs(
          "addCollaborator", { ...base, grant: grant as AdminWriteArgs["grant"] })))
          .toBe("`grant` must be \"workspace\" or { gadgetId }, a non-negative whole number.");
    }
  });
});

describe("adminWriteAuditArgs", () => {
  it("keeps ids and strings by name, and leaves out what was not given", () => {
    expect(adminWriteAuditArgs({ chatId: 3, revertFrom: 12 }))
        .toStrictEqual({ chatId: 3, revertFrom: 12 });
    expect(adminWriteAuditArgs({ gadgetId: 5, commitId: COMMIT }))
        .toStrictEqual({ gadgetId: 5, commitId: COMMIT });
    expect(adminWriteAuditArgs({})).toStrictEqual({});
    expect(adminWriteAuditArgs({ chatId: 0, revertFrom: 0 }))
        .toStrictEqual({ chatId: 0, revertFrom: 0 });
  });

  it("writes a grant as \"workspace\" or \"gadget:<id>\"", () => {
    expect(adminWriteAuditArgs({ username: "bob@example.test", grant: "workspace" }))
        .toStrictEqual({ username: "bob@example.test", grant: "workspace" });
    expect(adminWriteAuditArgs({ username: "bob@example.test", grant: { gadgetId: 5 } }))
        .toStrictEqual({ username: "bob@example.test", grant: "gadget:5" });
    expect(adminWriteAuditArgs({ username: "bob@example.test", grant: { gadgetId: 0 } }).grant)
        .toBe("gadget:0");
  });

  it("cuts a long string as the audit log cuts an argument", () => {
    // adminWriteArgs() refuses a note this long; a record still never holds more than its bound.
    const note = "n".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH + 50);
    expect(adminWriteAuditArgs({ username: "bob@example.test", grant: "workspace", note }).note)
        .toBe(`${"n".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…`);
  });
});

describe("adminWriteTitle", () => {
  const TITLES: Record<AdminWriteAction, string> = {
    stopAgent: "Stop the agent in chat 3",
    retryAgent: "Retry the agent in chat 3",
    restartWorkspace: "Restart the workspace",
    addCollaborator: "Add a collaborator",
    deleteChat: "Delete chat 3",
    revertChat: "Revert chat 3 from message 12",
    revertGadget: "Restore gadget 5 to version 0a1b2c3",
    deleteGadget: "Delete gadget 5",
    deleteWorkspace: "Delete the workspace",
    rejectPendingActions: "Reject the pending actions of connection 7",
    removeConnection: "Remove connection 7",
  };

  it.each(ADMIN_WRITE_ACTIONS)("names %s from its ids alone", action => {
    const { required, optional } = TAKES[action];
    const title = adminWriteTitle(action, pick([...required, ...optional]));
    expect(title).toBe(TITLES[action]);
    for (let text of [VALID.username, VALID.note, VALID.modelId, COMMIT]) {
      expect(title).not.toContain(text);
    }
  });

  it("names the rejection of every pending action when no connection is given", () => {
    expect(adminWriteTitle("rejectPendingActions", {})).toBe("Reject the pending actions");
  });

  it("names the rejection of connection 0's pending actions as that connection's alone", () => {
    expect(adminWriteTitle("rejectPendingActions", { gatekeeperId: 0 }))
        .toBe("Reject the pending actions of connection 0");
  });

  it("names an added collaborator the same whatever the account, grant and note", () => {
    for (let args of [
      { username: "<b>mallory</b>", grant: "workspace" as const },
      { username: "x".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH), grant: { gadgetId: 5 }, note: "Hi" },
    ]) {
      expect(adminWriteTitle("addCollaborator", args)).toBe("Add a collaborator");
    }
  });
});

describe("adminWriteDigest", () => {
  const request = {
    id: "4c1d2a0e-8a53-4c59-9a0e-3d7f1b6c2e11",
    workspaceId: "a".repeat(64),
    workspaceTitle: "Quarterly report",
    workspaceOwner: "bob@example.test",
    action: "addCollaborator" as AdminWriteAction,
    args: { username: "carol@example.test", grant: { gadgetId: 5 }, note: "Hi" } as AdminWriteArgs,
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
      args: { note: "Hi", grant: { gadgetId: 5 }, username: "carol@example.test" },
    } as typeof request;
    expect(Object.keys(reordered)[0]).toBe("expiresAt");
    expect(await hex(reordered)).toBe(digest.toHex());

    // What a stored request holds besides: none of it is what an approval signs.
    const stored = { ...request, sessionId: "session", state: "pending", resolvedBy: "x" };
    expect(await hex(stored)).toBe(digest.toHex());
  });

  it("is the SHA-256 of the request as canonical JSON, its times in milliseconds", async () => {
    // Keys sorted at every level, and nothing but what never changes of the request.
    const canonical = `{"action":"addCollaborator",` +
        `"args":{"grant":{"gadgetId":5},"note":"Hi","username":"carol@example.test"},` +
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
    ["action", { action: "removeConnection" }],
    ["argument", { args: { ...request.args, username: "mallory@example.test" } }],
    ["nested argument", { args: { ...request.args, grant: { gadgetId: 6 } } }],
    ["added argument", { args: { ...request.args, chatId: 1 } }],
    ["reason", { reason: "Ticket 8: the owner asked for it" }],
    ["requester", { requestedBy: "other-admin@example.test" }],
    ["via", { via: "api" }],
    ["request time", { requestedAt: new Date("2026-01-02T03:04:05.001Z") }],
    ["expiry", { expiresAt: new Date("2026-01-02T03:14:05.001Z") }],
  ])("differs when the %s changes", async (_what, change) => {
    expect(await hex({ ...request, ...change })).not.toBe(await hex(request));
  });
});
