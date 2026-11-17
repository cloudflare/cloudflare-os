// The membrane between the admin gatekeeper and AdminApi (src/admin-agent.ts), over a fake AdminApi
// that records what reaches it: which call each use allows, what ends a lend, and that a view is
// only ever handed out behind the lend's own checks.
//
// The lent API and a returned view are native stubs, and a native stub answers some names itself
// (`dup`, `constructor`, `toString`, `__proto__`): a caller cannot send those through one. The
// tables that would refuse them are tested directly (adminAgentRefusal(), the `answers` of
// ADMIN_AGENT_VIEWS); the tests over stubs say, name by name, what workerd sent and what it kept.

import { describe, expect, it, vi } from "vitest";
import { RpcTarget } from "cloudflare:workers";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_USER_METHODS, DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS,
  getAdminAccessErrorCode,
} from "@gadgets/workshop-shared/api";
import {
  ADMIN_AGENT_ACTIONS, ADMIN_AGENT_KINDS, adminAgentActionMethods, type AdminAgentAction,
} from "@gadgets/workshop-shared/admin-agent";
import type { AdminApi } from "@gadgets/workshop-shared/api";
import { ADMIN_METHOD_ANSWERS } from "../src/admin-access.js";
import {
  ADMIN_AGENT_VIEWS, adminAgentRefusal, capViewLifetime, restrictAdminApi, type AdminAgentUse,
} from "../src/admin-agent.js";

const ADMIN = "admin@example.test";
const METHODS = Object.keys(ADMIN_AGENT_KINDS) as (keyof typeof ADMIN_AGENT_KINDS)[];
const ACTIONS = Object.keys(ADMIN_AGENT_ACTIONS) as AdminAgentAction[];
// Names that are not methods of AdminApi, the ones every object answers included.
const NOT_METHODS = ["constructor", "then", "toString", "__proto__", "hasOwnProperty", "dup", ""];
// The view methods, as the table for inspectWorkspace() allows them.
const VIEW_METHODS = Object.keys(ADMIN_METHOD_ANSWERS).filter(name => name !== "inspectWorkspace");
// The methods of a view of a user's account, as the table for inspectUser() allows them.
const USER_VIEW_METHODS: string[] = ADMIN_USER_METHODS.filter(name => name !== "inspectUser");
const T0 = 1_700_000_000_000;
const SESSION: AdminAgentUse = { for: "session", until: T0 + 60_000, live: () => {} };

const action = (kind: AdminAgentAction, autoApproved = false): AdminAgentUse =>
    ({ for: "action", kind, autoApproved, decidedBy: ADMIN });

// Arguments of `method` that the action `kind` allows.
function allowedArgs(kind: AdminAgentAction): unknown[] {
  let { method, visibility } = ADMIN_AGENT_ACTIONS[kind];
  if (method === "addIssueReportEntry") return ["report", "text", visibility];
  if (method === "setIssueReportStatus") return ["report", "answered"];
  if (typeof method !== "string") return ["report"];
  if (method === "requestContentAccess") return ["workspace", "reason"];
  return ["workspace", "stopAgent", { chatId: 3 }, "reason"];
}

async function rejection(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected the call to reject.");
}

describe("adminAgentRefusal", () => {
  it("lets a session read, and refuses it every act and omitted method", () => {
    for (let method of METHODS) {
      let refusal = adminAgentRefusal(SESSION, method, []);
      let kind = ADMIN_AGENT_KINDS[method];
      if (kind === "read") expect(refusal, method).toBeUndefined();
      if (kind === "act") {
        expect(refusal).toBe(`AdminApi.${method}() runs only as an approved action.`);
      }
      if (kind === "omitted") {
        expect(refusal).toBe(`AdminApi.${method}() is not available through the admin gatekeeper.`);
      }
    }
  });

  it.each(ACTIONS)("lets an action of kind %s make its own call and no other", kind => {
    let own = adminAgentActionMethods(kind);
    for (let method of METHODS) {
      let refusal = adminAgentRefusal(action(kind), method, allowedArgs(kind));
      if (own.includes(method)) {
        expect(refusal, method).toBeUndefined();
      } else if (ADMIN_AGENT_KINDS[method] === "omitted") {
        expect(refusal).toBe(`AdminApi.${method}() is not available through the admin gatekeeper.`);
      } else {
        expect(refusal).toBe(`This action may only call AdminApi.${own.join("() or AdminApi.")}().`);
      }
    }
  });

  it("lets an approved assignment claim or release, and nothing else", () => {
    let assignment = action("issueReportAssignment");
    expect(adminAgentRefusal(assignment, "claimIssueReport", ["report"])).toBeUndefined();
    expect(adminAgentRefusal(assignment, "releaseIssueReport", ["report"])).toBeUndefined();
    for (let method of ["whoami", "getIssueReport", "setIssueReportStatus", "addIssueReportEntry"]) {
      expect(adminAgentRefusal(assignment, method, ["report"])).toBe("This action may only call " +
          "AdminApi.claimIssueReport() or AdminApi.releaseIssueReport().");
    }
  });

  it("refuses a claim and a release to a session and to every other kind", () => {
    for (let method of ["claimIssueReport", "releaseIssueReport"]) {
      expect(adminAgentRefusal(SESSION, method, ["report"]))
          .toBe(`AdminApi.${method}() runs only as an approved action.`);
      for (let kind of ACTIONS) {
        if (kind === "issueReportAssignment") continue;
        expect(adminAgentRefusal(action(kind), method, allowedArgs(kind)), kind).toBe(
            `This action may only call AdminApi.${ADMIN_AGENT_ACTIONS[kind].method}().`);
      }
    }
  });

  it("holds an entry to its kind's visibility", () => {
    let entry = (kind: AdminAgentAction, visibility: unknown) =>
        adminAgentRefusal(action(kind), "addIssueReportEntry", ["report", "text", visibility]);
    for (let kind of ["issueReportReply", "issueReportScopedReply"] as const) {
      expect(entry(kind, "public")).toBeUndefined();
      for (let other of ["admins", undefined, "PUBLIC", ["public"]]) {
        expect(entry(kind, other)).toBe(`This action may only write a "public" entry.`);
      }
    }
    expect(entry("issueReportNote", "admins")).toBeUndefined();
    for (let other of ["public", undefined]) {
      expect(entry("issueReportNote", other)).toBe(`This action may only write a "admins" entry.`);
    }
  });

  it("keeps a request for content apart from a write", () => {
    expect(adminAgentRefusal(action("contentAccessRequest"), "writeWorkspace",
        ["workspace", "stopAgent", { chatId: 3 }, "why"]))
        .toBe("This action may only call AdminApi.requestContentAccess().");
    expect(adminAgentRefusal(action("workspaceWriteRequest"), "requestContentAccess",
        ["workspace", "why"]))
        .toBe("This action may only call AdminApi.writeWorkspace().");
  });

  it("refuses a name that is not a method, whatever the use", () => {
    for (let use of [SESSION, ...ACTIONS.map(kind => action(kind))]) {
      for (let name of NOT_METHODS) {
        expect(adminAgentRefusal(use, name, [])).toBe(`AdminApi has no method ${name}.`);
      }
    }
  });

  it("quotes no argument", () => {
    let secret = "secret-argument";
    for (let use of [SESSION, ...ACTIONS.map(kind => action(kind))]) {
      for (let method of [...METHODS, ...NOT_METHODS]) {
        let refusal = adminAgentRefusal(use, method, [secret, secret, secret, secret]);
        expect(refusal ?? "").not.toContain(secret);
      }
    }
  });
});

describe("capViewLifetime", () => {
  const FIVE_MINUTES = 5 * 60_000;

  it("gives a view with no options what the lend has left", () => {
    expect(capViewLifetime(["ws", "why"], FIVE_MINUTES))
        .toEqual(["ws", "why", { lifetimeSeconds: 300 }]);
    expect(capViewLifetime(["ws", "why", {}], FIVE_MINUTES))
        .toEqual(["ws", "why", { lifetimeSeconds: 300 }]);
  });

  it("gives the default life when the lend has longer left", () => {
    expect(capViewLifetime(["ws", "why"], 3_600_000))
        .toEqual(["ws", "why", { lifetimeSeconds: DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS }]);
  });

  it("cuts a longer life and keeps a shorter one", () => {
    expect(capViewLifetime(["ws", "why", { lifetimeSeconds: 3600 }], FIVE_MINUTES))
        .toEqual(["ws", "why", { lifetimeSeconds: 300 }]);
    expect(capViewLifetime(["ws", "why", { lifetimeSeconds: 60 }], FIVE_MINUTES))
        .toEqual(["ws", "why", { lifetimeSeconds: 60 }]);
  });

  it("rounds what is left up to a whole second, and never below one", () => {
    expect(capViewLifetime(["ws", "why"], 1_500)).toEqual(["ws", "why", { lifetimeSeconds: 2 }]);
    for (let left of [999, 1, 0, -5_000]) {
      expect(capViewLifetime(["ws", "why"], left)).toEqual(["ws", "why", { lifetimeSeconds: 1 }]);
    }
  });

  it("keeps the other options and leaves the caller's object alone", () => {
    let options = { access: "content", forIssueReport: "report-1", lifetimeSeconds: 3600 };
    expect(capViewLifetime(["ws", "why", options], FIVE_MINUTES))
        .toEqual(["ws", "why", { access: "content", forIssueReport: "report-1", lifetimeSeconds: 300 }]);
    expect(options.lifetimeSeconds).toBe(3600);
  });

  it("passes on what it does not understand, for AdminApi to refuse", () => {
    for (let args of [
      ["ws", "why", { lifetimeSeconds: "60" }], ["ws", "why", { lifetimeSeconds: null }],
      ["ws", "why", "3600"], ["ws", "why", 3600], ["ws", "why", null], ["ws", "why", [3600]],
    ]) {
      expect(capViewLifetime(args, FIVE_MINUTES)).toEqual(args);
    }
    // A life that is not one AdminApi takes stays one it refuses.
    for (let lifetimeSeconds of [0, -1, 1.5, NaN, 3601, Infinity]) {
      expect(capViewLifetime(["ws", "why", { lifetimeSeconds }], FIVE_MINUTES))
          .toEqual(["ws", "why", { lifetimeSeconds }]);
    }
  });
});

describe("ADMIN_AGENT_VIEWS", () => {
  it("has an entry for each of the two opens and no other method", () => {
    expect(Object.keys(ADMIN_AGENT_VIEWS)).toEqual(["inspectWorkspace", "inspectUser"]);
    expect(ADMIN_AGENT_VIEWS.inspectWorkspace.cap).toBe(capViewLifetime);
    expect(ADMIN_AGENT_VIEWS.inspectUser.cap).toBe(capViewLifetime);
  });

  it("answers every method of a workspace view and no other name", () => {
    let { answers } = ADMIN_AGENT_VIEWS.inspectWorkspace;
    expect(VIEW_METHODS.length).toBeGreaterThan(20);
    for (let name of VIEW_METHODS) expect(answers(name), name).toBe(true);
    for (let name of ["inspectWorkspace", "onRpcBroken", "valueOf", ...NOT_METHODS]) {
      expect(answers(name), name).toBe(false);
    }
  });

  it("answers every method of a view of a user's account and no other name", () => {
    let { answers } = ADMIN_AGENT_VIEWS.inspectUser;
    expect(USER_VIEW_METHODS).toHaveLength(7);
    for (let name of USER_VIEW_METHODS) expect(answers(name), name).toBe(true);
    // Not the open, and nothing only a workspace's view answers.
    let workspaceOnly = VIEW_METHODS.filter(name => !USER_VIEW_METHODS.includes(name));
    expect(workspaceOnly).toContain("getChat");
    for (let name of ["inspectUser", "onRpcBroken", "valueOf", ...workspaceOnly, ...NOT_METHODS]) {
      expect(answers(name), name).toBe(false);
    }
  });
});

// A fake AdminApi: every method of ADMIN_AGENT_KINDS, recording its call and answering with
// `answers[method](...args)`, else with "<method> answered".
function fakeApi(answers: Record<string, (...args: any[]) => unknown> = {}) {
  let calls: { method: string; args: unknown[] }[] = [];
  let api = Object.fromEntries(METHODS.map(method => [method, async (...args: unknown[]) => {
    calls.push({ method, args });
    return answers[method] ? answers[method](...args) : `${method} answered`;
  }])) as unknown as AdminApi;
  return { api, calls };
}

// A capability as a fake hands one out: it has `names` as methods, each recording that it was
// reached in `reached` and answering with `answers[name]()`, else with "<name> answered".
function fakeCapability(names: string[], reached: string[],
                        answers: Record<string, () => unknown> = {}): RpcTarget {
  let target = new RpcTarget();
  for (let name of names) {
    Object.defineProperty(target, name, { value: () => {
      reached.push(name);
      return answers[name] ? answers[name]() : `${name} answered`;
    } });
  }
  Object.defineProperty(target, Symbol.dispose, { value: () => { reached.push("disposed"); } });
  return target;
}

// A lend over a fake API whose clock, admin list, off switch and approval the test moves.
// `whenOffAsked` runs as the lend asks the switch, before the answer.
function lendOver(use: AdminAgentUse, answers: Record<string, (...args: any[]) => unknown> = {}) {
  let fake = fakeApi(answers);
  let state = {
    now: T0, off: false, offAsked: 0, unapproved: undefined as string | undefined,
    whenOffAsked: () => {},
  };
  let env = { ADMINS: [ADMIN] } as unknown as Cloudflare.Env;
  let lend = restrictAdminApi(fake.api, env, ADMIN, use, async () => {
    state.offAsked++;
    state.whenOffAsked();
    return state.off;
  }, () => { if (state.unapproved) throw new Error(state.unapproved); }, () => state.now);
  return { ...fake, lend, api: lend.api as any, state, env: env as unknown as { ADMINS: string[] } };
}

describe("restrictAdminApi", () => {
  it("forwards a session's read with its arguments and returns the answer", async () => {
    let { api, calls } = lendOver(SESSION, { listUsers: options => ({ users: [], options }) });
    expect(await api.listUsers({ query: "ada" })).toEqual({ users: [], options: { query: "ada" } });
    expect(calls).toEqual([{ method: "listUsers", args: [{ query: "ada" }] }]);
  });

  it("refuses a session every act and omitted method and every name that is no method", async () => {
    let { api, calls } = lendOver(SESSION);
    expect((await rejection(api.addIssueReportEntry("report", "text", "admins"))).message)
        .toBe("AdminApi.addIssueReportEntry() runs only as an approved action.");
    expect((await rejection(api.setSiteName("x"))).message)
        .toBe("AdminApi.setSiteName() is not available through the admin gatekeeper.");
    expect((await rejection(api.approveContentAccess("request"))).message)
        .toBe("AdminApi.approveContentAccess() is not available through the admin gatekeeper.");
    expect((await rejection(api.noSuchMethod())).message)
        .toBe("AdminApi has no method noSuchMethod.");
    expect(calls).toEqual([]);
  });

  it("is not a thenable: awaiting it calls nothing", async () => {
    let { api, calls, state } = lendOver(SESSION);
    expect(api.then).toBeUndefined();
    await api;
    expect(calls).toEqual([]);
    expect(state.offAsked).toBe(0);
  });

  it("refuses a session once its time has passed", async () => {
    let { api, calls, state } = lendOver(SESSION);
    state.now = T0 + 59_999;
    expect(await api.listUsers()).toBe("listUsers answered");
    state.now = T0 + 60_000;
    expect((await rejection(api.listUsers())).message)
        .toBe("This Admin API session has ended. Open a new one.");
    expect(calls).toHaveLength(1);
  });

  it("lends nothing to a session whose time has already passed", () => {
    expect(() => restrictAdminApi(fakeApi().api, { ADMINS: [ADMIN] } as unknown as Cloudflare.Env,
        ADMIN, SESSION, async () => false, () => {}, () => T0 + 60_000))
        .toThrow("This Admin API session has ended. Open a new one.");
  });

  it("refuses every call after end()", async () => {
    let { api, lend, calls } = lendOver(SESSION);
    expect(await api.getSettings()).toBe("getSettings answered");
    lend.end();
    expect((await rejection(api.getSettings())).message)
        .toBe("This Admin API session has ended. Open a new one.");
    expect(calls).toHaveLength(1);
  });

  it("refuses an admin who is one no longer, from the next call on", async () => {
    let { api, calls, env } = lendOver(SESSION);
    expect(await api.listUsers()).toBe("listUsers answered");
    env.ADMINS = ["someone-else@example.test"];
    expect(getAdminAccessErrorCode(await rejection(api.listUsers())))
        .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    expect(calls).toHaveLength(1);
  });

  it("refuses a session that is over, with the reason its queue gives", async () => {
    let over: string | undefined;
    let { api, calls } = lendOver({ ...SESSION, live: () => { if (over) throw new Error(over); } });
    expect(await api.listUsers()).toBe("listUsers answered");
    over = "The code execution this session belongs to has ended.";
    expect((await rejection(api.listUsers())).message).toBe(over);
    expect(calls).toHaveLength(1);
  });

  it("asks before each call whether the gatekeeper is off, and refuses once it is", async () => {
    let { api, calls, state } = lendOver(SESSION);
    expect(await api.listUsers()).toBe("listUsers answered");
    state.off = true;
    let refused = await rejection(api.listUsers());
    expect(refused.message).toBe("Gatekeeper is disabled.");
    expect(getAdminAccessErrorCode(refused)).toBe(ADMIN_ACCESS_ERROR_CODES.gatekeeperOff);
    expect(state.offAsked).toBe(2);
    expect(calls).toHaveLength(1);
  });

  it("checks in order: ended, admin, live, off, then the method", async () => {
    let { api, lend, state, env } = lendOver(
        { ...SESSION, live: () => { throw new Error("over"); } });
    state.off = true;
    expect((await rejection(api.setSiteName("x"))).message).toBe("over");
    env.ADMINS = [];
    expect(getAdminAccessErrorCode(await rejection(api.setSiteName("x"))))
        .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    lend.end();
    expect((await rejection(api.setSiteName("x"))).message)
        .toBe("This Admin API session has ended. Open a new one.");
    // Neither the admin nor the session was refused by the switch, which was never asked.
    expect(state.offAsked).toBe(0);

    let off = lendOver(SESSION);
    off.state.off = true;
    expect((await rejection(off.api.setSiteName("x"))).message).toBe("Gatekeeper is disabled.");
  });

  it("checks the lend again once the off switch answers, forwarding nothing after its end",
      async () => {
    let fake = fakeApi();
    let ends: (() => void)[] = [];
    let env = { ADMINS: [ADMIN] } as unknown as Cloudflare.Env;
    let now = T0;
    // The switch answers only after the lend has ended, run out, or lost its admin.
    let lend = restrictAdminApi(fake.api, env, ADMIN, SESSION, async () => {
      ends.shift()?.();
      return false;
    }, () => {}, () => now);
    let api = lend.api as any;
    ends.push(() => { now = T0 + 60_000; });
    expect((await rejection(api.listUsers())).message)
        .toBe("This Admin API session has ended. Open a new one.");
    now = T0;
    ends.push(() => { (env as unknown as { ADMINS: string[] }).ADMINS = []; });
    expect(getAdminAccessErrorCode(await rejection(api.listUsers())))
        .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    (env as unknown as { ADMINS: string[] }).ADMINS = [ADMIN];
    ends.push(() => lend.end());
    expect((await rejection(api.listUsers())).message)
        .toBe("This Admin API session has ended. Open a new one.");
    expect(fake.calls).toEqual([]);
  });

  it("fails a call that settles after its lend ends, letting go of a view it returned",
      async () => {
    let reached: string[] = [];
    let view = fakeCapability(["describe"], reached);
    let late = lendOver(SESSION, {
      listUsers: () => { late.state.now = T0 + 60_000; return "listUsers answered"; },
      inspectWorkspace: () => { late.lend.end(); return view; },
    });
    expect((await rejection(late.api.listUsers())).message)
        .toBe("This Admin API session has ended. Open a new one.");
    late.state.now = T0;
    expect((await rejection(late.api.inspectWorkspace("ws", "why"))).message)
        .toBe("This Admin API session has ended. Open a new one.");
    expect(reached).toEqual(["disposed"]);
  });

  // An error can name what the call read: one that fails after the lend ended says only that.
  it("replaces the error of a call that fails after its lend ends", async () => {
    let failing = lendOver(SESSION, {
      listUsers: () => { failing.lend.end(); throw new Error("no such file: secret/path.txt"); },
      getSettings: () => { throw new Error("still lent"); },
    });
    expect((await rejection(failing.api.getSettings())).message).toBe("still lent");
    expect((await rejection(failing.api.listUsers())).message)
        .toBe("This Admin API session has ended. Open a new one.");
  });

  it("asks last, after it asked whether the gatekeeper is off, whether an action is still " +
      "approved", async () => {
    let { api, calls, state } = lendOver(action("issueReportNote", true));
    // What approved the action stops doing so while the lend waits for the switch's answer.
    state.whenOffAsked = () => { state.unapproved = "This action waits for a person."; };
    expect((await rejection(api.addIssueReportEntry("report", "a note", "admins"))).message)
        .toBe("This action waits for a person.");
    expect(state.offAsked).toBe(1);
    expect(calls).toEqual([]);

    // Every refusal above comes first.
    let off = lendOver(action("issueReportNote", true));
    off.state.unapproved = "This action waits for a person.";
    expect((await rejection(off.api.addIssueReportEntry("report", "a reply", "public"))).message)
        .toBe(`This action may only write a "admins" entry.`);
  });

  it("lends nothing to an auto-approval of a kind that always waits for a person", () => {
    for (let kind of ACTIONS) {
      let lend = () => lendOver(action(kind, true));
      if (ADMIN_AGENT_ACTIONS[kind].autoApprovable) {
        expect(lend, kind).not.toThrow();
      } else {
        expect(lend, kind).toThrow("This kind of action is never auto-approved.");
      }
    }
    expect(ACTIONS.filter(kind => !ADMIN_AGENT_ACTIONS[kind].autoApprovable))
        .toEqual(["issueReportReply", "workspaceWriteRequest", "contentAccessRequest"]);
    // A person's approval of the same kinds is lent to.
    expect(() => lendOver(action("issueReportReply"))).not.toThrow();
    expect(() => lendOver(action("contentAccessRequest"))).not.toThrow();
  });

  it("answers an action's one call and refuses a second", async () => {
    let { api, calls } = lendOver(action("issueReportNote"));
    expect(await api.addIssueReportEntry("report", "a note", "admins"))
        .toBe("addIssueReportEntry answered");
    expect((await rejection(api.addIssueReportEntry("report", "another", "admins"))).message)
        .toBe("This action has made its one call.");
    expect(calls).toEqual([
      { method: "addIssueReportEntry", args: ["report", "a note", "admins"] },
    ]);
  });

  it("answers an assignment's one call, a claim or a release, and refuses the other after it", async () => {
    let claim = lendOver(action("issueReportAssignment"));
    expect(await claim.api.claimIssueReport("report")).toBe("claimIssueReport answered");
    expect((await rejection(claim.api.releaseIssueReport("report"))).message)
        .toBe("This action has made its one call.");
    expect(claim.calls).toEqual([{ method: "claimIssueReport", args: ["report"] }]);

    let release = lendOver(action("issueReportAssignment", true));
    expect(await release.api.releaseIssueReport("report")).toBe("releaseIssueReport answered");
    expect(release.calls).toEqual([{ method: "releaseIssueReport", args: ["report"] }]);
  });

  it("makes one call of two an action starts together", async () => {
    let { api, calls } = lendOver(action("issueReportStatus"));
    let results = await Promise.allSettled([
      api.setIssueReportStatus("report", "answered"),
      api.setIssueReportStatus("report", "closed"),
    ]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(calls).toEqual([{ method: "setIssueReportStatus", args: ["report", "answered"] }]);
  });

  it("leaves an action no call once its first was refused", async () => {
    let { api, calls } = lendOver(action("issueReportNote"));
    expect((await rejection(api.addIssueReportEntry("report", "a reply", "public"))).message)
        .toBe(`This action may only write a "admins" entry.`);
    expect((await rejection(api.addIssueReportEntry("report", "a note", "admins"))).message)
        .toBe("This action has made its one call.");
    expect(calls).toEqual([]);
  });

  it("refuses an action's lend after end(), its call made or not", async () => {
    let unused = lendOver(action("issueReportStatus"));
    unused.lend.end();
    expect((await rejection(unused.api.setIssueReportStatus("report", "closed"))).message)
        .toBe("This Admin API session has ended. Open a new one.");
    expect(unused.calls).toEqual([]);
  });

  it("passes a returned stream on to the caller", async () => {
    let bytes = new Uint8Array([1, 2, 3, 4]);
    let { api } = lendOver(SESSION, {
      readIssueReportImage: () => new Response(bytes).body,
    });
    let stream: ReadableStream<Uint8Array> = await api.readIssueReportImage("report", "image");
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(bytes);
  });
});

describe("a view a lent API returns", () => {
  // Every name a workspace view answers, and names it must not: the stub's own, the open, and
  // what any object answers.
  const FAKE_VIEW_NAMES =
      [...VIEW_METHODS, "inspectWorkspace", "dup", "onRpcBroken", "constructor", "toString"];

  function lendWithView(use: AdminAgentUse = SESSION, viewAnswers: Record<string, () => unknown> = {}) {
    let reached: string[] = [];
    let view = fakeCapability(FAKE_VIEW_NAMES, reached, viewAnswers);
    return { ...lendOver(use, { inspectWorkspace: () => view }), reached };
  }

  it("cancels the stream of a file a view answers after its lend ends", async () => {
    let cancelled = false;
    let content = new ReadableStream({ cancel() { cancelled = true; } });
    let held: { lend: { end(): void } } | undefined;
    let lent = lendWithView(SESSION, {
      readFile: () => { held!.lend.end(); return { kind: "stream", content, size: 4 }; },
    });
    held = lent;
    let view = await lent.api.inspectWorkspace("ws", "why");
    expect((await rejection(view.readFile(1, "big.bin"))).message)
        .toBe("This Admin API session has ended. Open a new one.");
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("answers every method of the view through the membrane", async () => {
    let { api, reached } = lendWithView();
    let view = await api.inspectWorkspace("ws", "why");
    for (let name of VIEW_METHODS) expect(await view[name]()).toBe(`${name} answered`);
    expect(reached).toEqual(VIEW_METHODS);
  });

  it("forwards nothing the view's table does not name", async () => {
    let { api, reached } = lendWithView();
    let view = await api.inspectWorkspace("ws", "why");

    // Sent to the membrane, which refuses them: the open, which is not a method of the view,
    // onRpcBroken(), which a native stub does not answer itself, and a name nothing has; each
    // on the stub and pipelined on the promise of the open.
    for (let name of ["inspectWorkspace", "onRpcBroken", "noSuchMethod"]) {
      expect((await rejection(view[name](() => {}))).message)
          .toBe(`This view has no method ${name}.`);
      expect((await rejection(api.inspectWorkspace("ws", "why")[name]())).message)
          .toBe(`This view has no method ${name}.`);
    }

    // Never sent. On the stub, dup() is the stub's own: it gives a second stub of the membrane,
    // which refuses what the first does. Pipelined, workerd refuses the name itself.
    let copy = view.dup();
    expect((await rejection(copy.inspectWorkspace("ws", "why"))).message)
        .toBe("This view has no method inspectWorkspace.");
    expect(await copy.describe()).toBe("describe answered");
    expect((await rejection(api.inspectWorkspace("ws", "why").dup())).message)
        .toMatch(/'dup' is a reserved method/);
    // Nor are these: they are members of the caller's stub.
    expect(typeof view.constructor).toBe("function");
    expect(view.toString()).toMatch(/^\[object /);
    expect(typeof view.__proto__).toBe("object");

    expect(reached).toEqual(["describe"]);
  });

  it("answers a view of a user's account by its own table, never a workspace view's",
      async () => {
    let reached: string[] = [];
    let view = fakeCapability([...new Set([...USER_VIEW_METHODS, ...VIEW_METHODS])], reached);
    let { api, calls } = lendOver(SESSION, { inspectUser: () => view });
    let opened = await api.inspectUser("ada", "why");
    for (let name of USER_VIEW_METHODS) expect(await opened[name]()).toBe(`${name} answered`);
    for (let name of ["inspectUser", "getChat", "readFile", "listChats"]) {
      expect((await rejection(opened[name]())).message).toBe(`This view has no method ${name}.`);
    }
    expect(reached).toEqual(USER_VIEW_METHODS);
    // The view's life is capped at the lend's, as a workspace view's is.
    expect(calls).toEqual([{ method: "inspectUser", args: ["ada", "why", { lifetimeSeconds: 60 }] }]);
  });

  it("stops with its lend: after end(), after its time and once the gatekeeper is off", async () => {
    let ended = lendWithView();
    let view = await ended.api.inspectWorkspace("ws", "why");
    expect(await view.describe()).toBe("describe answered");
    ended.lend.end();
    expect((await rejection(view.describe())).message)
        .toBe("This Admin API session has ended. Open a new one.");
    expect(ended.reached).toEqual(["describe", "disposed"]);

    let late = lendWithView();
    view = await late.api.inspectWorkspace("ws", "why");
    late.state.now = T0 + 60_000;
    expect((await rejection(view.listChats())).message)
        .toBe("This Admin API session has ended. Open a new one.");

    let off = lendWithView();
    view = await off.api.inspectWorkspace("ws", "why");
    off.state.off = true;
    expect((await rejection(view.listChats())).message).toBe("Gatekeeper is disabled.");

    let demoted = lendWithView();
    view = await demoted.api.inspectWorkspace("ws", "why");
    demoted.env.ADMINS = [];
    expect(getAdminAccessErrorCode(await rejection(view.listChats())))
        .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);

    let over: string | undefined;
    let session = lendWithView({ ...SESSION, live: () => { if (over) throw new Error(over); } });
    view = await session.api.inspectWorkspace("ws", "why");
    over = "The user stopped the agent turn this session belongs to.";
    expect((await rejection(view.listChats())).message).toBe(over);

    for (let { reached } of [late, off, demoted, session]) expect(reached).toEqual([]);
  });

  it("releases the view when its holder lets go of it, once", async () => {
    let { api, lend, reached } = lendWithView();
    let view = await api.inspectWorkspace("ws", "why");
    view[Symbol.dispose]();
    await vi.waitFor(() => expect(reached).toEqual(["disposed"]));
    lend.end();
    expect(reached).toEqual(["disposed"]);
  });

  it("hands out a capability a view call returns answering nothing", async () => {
    let inner: string[] = [];
    let { api, reached } = lendWithView(SESSION, {
      describe: () => fakeCapability(["describe", "secret", "listChats"], inner),
    });
    let view = await api.inspectWorkspace("ws", "why");
    let returned = await view.describe();
    for (let name of ["describe", "secret", "listChats"]) {
      expect((await rejection(returned[name]())).message).toBe(`This view has no method ${name}.`);
    }
    expect((await rejection(view.describe().secret())).message)
        .toBe("This view has no method secret.");
    expect(inner).toEqual([]);
    expect(reached).toEqual(["describe", "describe"]);
  });

  it("hands out a capability from a method with no entry answering nothing", async () => {
    let reached: string[] = [];
    let { api, calls } = lendOver(SESSION, {
      listUsers: () => fakeCapability(["describe", "listChats", "dup"], reached),
    });
    let returned = await api.listUsers();
    for (let name of ["describe", "listChats"]) {
      expect((await rejection(returned[name]())).message).toBe(`This view has no method ${name}.`);
    }
    expect((await rejection(api.listUsers().describe())).message)
        .toBe("This view has no method describe.");
    // The stub's own dup() gives a second stub of the membrane, which answers no more.
    expect((await rejection(returned.dup().describe())).message)
        .toBe("This view has no method describe.");
    expect(reached).toEqual([]);
    expect(calls.map(call => call.method)).toEqual(["listUsers", "listUsers"]);
  });

  it("caps a session's view at what the lend has left, through the entry of each key", async () => {
    for (let method of Object.keys(ADMIN_AGENT_VIEWS) as (keyof typeof ADMIN_AGENT_VIEWS)[]) {
      let { api, calls, state } = lendWithView();
      // 60 seconds of lend, 20 of them gone.
      state.now = T0 + 20_000;
      await api[method]("ws", "why", { lifetimeSeconds: 3600, access: "content" });
      await api[method]("ws", "why");
      await api[method]("ws", "why", { lifetimeSeconds: 5 });
      await api[method]("ws", "why", { lifetimeSeconds: "3600" });
      let expected = [
        ["ws", "why", { lifetimeSeconds: 3600, access: "content" }], ["ws", "why"],
        ["ws", "why", { lifetimeSeconds: 5 }], ["ws", "why", { lifetimeSeconds: "3600" }],
      ].map(args => ADMIN_AGENT_VIEWS[method].cap(args, 40_000));
      expect(calls).toEqual(expected.map(args => ({ method, args })));
      expect(calls.map(call => (call.args[2] as { lifetimeSeconds: unknown }).lifetimeSeconds))
          .toEqual([40, 40, 5, "3600"]);
    }
  });

  it("leaves the arguments of every other call as they came", async () => {
    let { api, calls } = lendOver(SESSION);
    await api.listWorkspaces({ lifetimeSeconds: 3600 }, "why", { lifetimeSeconds: 3600 });
    expect(calls[0]!.args).toEqual([{ lifetimeSeconds: 3600 }, "why", { lifetimeSeconds: 3600 }]);
  });
});
