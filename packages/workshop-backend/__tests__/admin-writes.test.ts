import { describe, expect, it } from "vitest";
import {
  ADMIN_WRITE_ACTIONS, MAX_ADMIN_AUDIT_ARG_LENGTH,
  type AdminAgentOrigin, type AdminVia, type AdminWriteAction, type AdminWriteArgs,
} from "@gadgets/workshop-shared/api";
import {
  adminWriteArgs, adminWriteDigest, adminWriteTitle, entersActionLog, isRequestInsider,
  needsSecondAdmin,
} from "../src/admin-writes.js";

// A value each argument accepts.
const VALID: Required<AdminWriteArgs> = { chatId: 3, gatekeeperId: 7 };
const ALL_ARGS = Object.keys(VALID) as (keyof AdminWriteArgs)[];

// What each action takes, written out here rather than read from the code under test.
const TAKES: Record<AdminWriteAction,
    { required: (keyof AdminWriteArgs)[]; optional: (keyof AdminWriteArgs)[] }> = {
  stopAgent: { required: ["chatId"], optional: [] },
  restartWorkspace: { required: [], optional: [] },
  grantContentAccess: { required: [], optional: [] },
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

  // Ids start at 0: a workspace's first chat has it.
  it("refuses a chatId that is not a non-negative safe integer", () => {
    for (let value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(typeError(() => adminWriteArgs("stopAgent", { chatId: value })))
          .toBe("`chatId` must be a non-negative whole number.");
    }
    expect(adminWriteArgs("stopAgent", { chatId: 0 }).chatId).toBe(0);
    expect(adminWriteArgs("stopAgent", { chatId: Number.MAX_SAFE_INTEGER }).chatId)
        .toBe(Number.MAX_SAFE_INTEGER);
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
    grantContentAccess: "Read the workspace's content",
  };

  it.each(ADMIN_WRITE_ACTIONS)("names %s from its ids alone", action => {
    const { required, optional } = TAKES[action];
    expect(adminWriteTitle(action, pick([...required, ...optional]))).toBe(TITLES[action]);
  });
});

describe("the action that reads content", () => {
  // Written out here, so that an action added to ADMIN_WRITE_ACTIONS is decided on purpose.
  const CHANGES = ["stopAgent", "restartWorkspace"];

  it("is the only one that needs a second admin, and the only one the action log leaves out",
      () => {
    expect(ADMIN_WRITE_ACTIONS.filter(action => !needsSecondAdmin(action))).toEqual(CHANGES);
    expect(ADMIN_WRITE_ACTIONS.filter(entersActionLog)).toEqual(CHANGES);
    expect(needsSecondAdmin("grantContentAccess")).toBe(true);
    expect(entersActionLog("grantContentAccess")).toBe(false);
  });

  it("takes no argument", () => {
    expect(adminWriteArgs("grantContentAccess", {})).toStrictEqual({});
    expect(typeError(() => adminWriteArgs("grantContentAccess", { chatId: 1 })))
        .toBe("\"grantContentAccess\" takes no `chatId`.");
  });
});

describe("the digest of a request to read content", () => {
  it("covers its action: the same request for another action signs differently", async () => {
    const request = {
      id: "4c1d2a0e-8a53-4c59-9a0e-3d7f1b6c2e11", workspaceId: "a".repeat(64),
      workspaceTitle: "Quarterly report", workspaceOwner: "bob@example.test",
      action: "grantContentAccess" as AdminWriteAction, args: {},
      reason: "Ticket 7: the owner cannot be reached", requestedBy: "admin@example.test",
      via: "cli" as AdminVia, requestedAt: new Date("2026-01-02T03:04:05.000Z"),
      expiresAt: new Date("2026-01-02T03:14:05.000Z"),
    };
    const digest = (await adminWriteDigest(request)).toHex();
    expect((await adminWriteDigest({ ...request, action: "restartWorkspace" })).toHex())
        .not.toBe(digest);
    expect((await adminWriteDigest({ ...request })).toHex()).toBe(digest);
  });
});

describe("adminWriteDigest", () => {
  const request = {
    id: "4c1d2a0e-8a53-4c59-9a0e-3d7f1b6c2e11",
    workspaceId: "a".repeat(64),
    workspaceTitle: "Quarterly report",
    workspaceOwner: "bob@example.test",
    action: "stopAgent" as AdminWriteAction,
    // Both arguments, which no action takes together, so that the order of their keys counts.
    args: { chatId: 3, gatekeeperId: 7 } as AdminWriteArgs,
    reason: "Ticket 7: the owner asked for it",
    requestedBy: "admin@example.test",
    via: "cli" as AdminVia,
    requestedAt: new Date("2026-01-02T03:04:05.000Z"),
    expiresAt: new Date("2026-01-02T03:14:05.000Z"),
  };
  const hex = async (value: typeof request & { agent?: AdminAgentOrigin }) =>
      (await adminWriteDigest(value)).toHex();

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
    const canonical = `{"action":"stopAgent","args":{"chatId":3,"gatekeeperId":7},` +
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
    ["action", { action: "restartWorkspace" }],
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

  it("gives a request with no agent a digest that has no key for one", async () => {
    // Pinned as a constant: a passkey's signature over a request is over these bytes, so a
    // request that names no agent must digest to them whatever else a request may carry.
    const pinned = "e75963268a84ee47d351fb78ef9284c824111acca0c0dffeb4ab4909fb27cc4a";
    expect(await hex(request)).toBe(pinned);
    expect(await hex({ ...request, agent: undefined })).toBe(pinned);
  });

  it("covers where an agent's request came from", async () => {
    const filed = { ...request, via: "gatekeeper" as AdminVia };
    const origin = { workspaceId: "c".repeat(64), chatId: 4 };
    const digest = await hex({ ...filed, agent: origin });
    expect(digest).not.toBe(await hex(filed));
    expect(await hex({ ...filed, agent: { chatId: 4, workspaceId: origin.workspaceId } }))
        .toBe(digest);
    expect(await hex({ ...filed, agent: { ...origin, chatId: 5 } })).not.toBe(digest);
    expect(await hex({ ...filed, agent: { ...origin, workspaceId: "d".repeat(64) } }))
        .not.toBe(digest);
    expect(await hex({ ...filed, agent: { workspaceId: origin.workspaceId } })).not.toBe(digest);
  });

  it("does not cover who was in the workspace an agent's request was filed from", async () => {
    const filed = {
      ...request, via: "gatekeeper" as AdminVia, agent: { workspaceId: "c".repeat(64), chatId: 4 },
    };
    const digest = await hex(filed);
    const withInsiders = { ...filed, insiders: ["admin@example.test", "second@example.test"] };
    expect(await hex(withInsiders)).toBe(digest);
    const withNone = { ...filed, insiders: [] };
    expect(await hex(withNone)).toBe(digest);
  });
});

describe("isRequestInsider", () => {
  const filed = {
    requestedBy: "owner@example.test",
    insiders: ["owner@example.test", "member@example.test", "decider@example.test"],
  };

  it("names the requester", () => {
    expect(isRequestInsider(filed, "owner@example.test")).toBe(true);
  });

  it("names everyone the request keeps as an insider", () => {
    expect(isRequestInsider(filed, "member@example.test")).toBe(true);
    expect(isRequestInsider(filed, "decider@example.test")).toBe(true);
  });

  it("names a requester and an insider spelled in another case of ASCII letters", () => {
    expect(isRequestInsider(filed, "Owner@Example.test")).toBe(true);
    expect(isRequestInsider(filed, "MEMBER@example.test")).toBe(true);
    // Only ASCII letters fold: the Kelvin sign is not "k".
    expect(isRequestInsider({ requestedBy: "owner@example.test", insiders: ["kim@example.test"] },
        "\u212Aim@example.test")).toBe(false);
  });

  it("names nobody else", () => {
    expect(isRequestInsider(filed, "outside@example.test")).toBe(false);
    expect(isRequestInsider(filed, "member@example.test.evil")).toBe(false);
    expect(isRequestInsider(filed, "")).toBe(false);
  });

  it("names the requester alone for a request that keeps no list", () => {
    const direct = { requestedBy: "owner@example.test" };
    expect(isRequestInsider(direct, "owner@example.test")).toBe(true);
    expect(isRequestInsider(direct, "OWNER@example.test")).toBe(true);
    expect(isRequestInsider(direct, "member@example.test")).toBe(false);
    expect(isRequestInsider({ ...direct, insiders: [] }, "member@example.test")).toBe(false);
  });
});
