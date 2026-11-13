// What the admin views share (src/admin-view.ts): the one way a view's call is checked, run and
// recorded (adminViewCall()), and the check of the terms a view is minted on
// (assertAdminViewTerms()).
//
// Runs over a fake host: an environment whose BLUEPRINTS serves the deployment's config, an audit
// namespace and a logger that note what they are given, and a record built from recordOf()'s
// arguments. Each view has a suite of its own for what it reads and records.

import { describe, expect, it } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, MAX_ADMIN_ACCESS_REASON_LENGTH, MAX_ADMIN_VIEW_LIFETIME_SECONDS,
  getAdminAccessErrorCode, type AdminAccessRecord,
} from "@gadgets/workshop-shared/api";
import { assertAdminViewLive, type AdminViewTerms } from "../src/admin-access.js";
import { adminViewCall, assertAdminViewTerms, type AdminViewCallHost } from "../src/admin-view.js";
import { ADMIN_CONFIG_KEY } from "../src/storage-schema/blueprints-kv.js";
import type { AdminConfig } from "../src/storage-schema/admin-settings-storage.js";

const ADMIN = "admin@example.test";
const REASON = "Support ticket 42";
// A deployment whose admins turned access off.
const OFF = { config: { adminWorkspaceAccess: "off" } } as const;

type Refusal = AdminAccessRecord["refused"];

function termsOf(overrides: Partial<AdminViewTerms> = {}): AdminViewTerms {
  return { via: "api", expiresAt: new Date(Date.now() + 60_000), ...overrides };
}

// The record the fake host builds for a call: fixed but for what adminViewCall() decides.
function recordOf(terms: AdminViewTerms, refused?: Refusal): AdminAccessRecord {
  return {
    kind: "workspace", workspaceId: "workspace-1", workspaceOwner: "owner@example.test",
    workspaceTitle: "Title", at: new Date(0), admin: ADMIN, sessionId: "session-1",
    via: terms.via, method: "describe", args: {}, reason: REASON,
    access: refused ? "off" : "metadata", ...(refused ? { refused } : {}),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  let promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/**
 * A host for adminViewCall(), minted on `terms` over the defaults. Its environment lists ADMIN in
 * ADMINS beside `vars`, and its BLUEPRINTS serves `config` as the deployment's, after
 * `onConfigRead`. Its check number `microtaskAtCheck` queues a microtask that notes itself in the
 * log. `log` lists what the call did, in order; `recorded` holds what recordOf() was given,
 * `appended` the audit namespace's calls and `warnings` the logger's.
 */
function fakeView(options: {
  config?: Partial<Record<keyof AdminConfig, unknown>>;
  vars?: Record<string, unknown>;
  terms?: Partial<AdminViewTerms>;
  onConfigRead?: () => void | Promise<void>;
  microtaskAtCheck?: number;
  append?: () => Promise<void>;
} = {}) {
  let log: string[] = [];
  let checks = 0;
  let recorded: (Refusal | undefined)[] = [];
  let appended: { name: string; args: unknown[] }[] = [];
  let warnings: unknown[][] = [];
  let terms = termsOf(options.terms);
  let vars: Record<string, unknown> = {
    ADMINS: [ADMIN],
    BLUEPRINTS: {
      get: async (key: string) => {
        log.push("config");
        await options.onConfigRead?.();
        return key === ADMIN_CONFIG_KEY ? JSON.stringify(options.config ?? {}) : null;
      },
    },
    ...options.vars,
  };
  let env = () => vars as unknown as Cloudflare.Env;
  let host: AdminViewCallHost = {
    env,
    audits: {
      getByName: (name: string) => ({
        append: async (...args: unknown[]) => {
          log.push("append");
          appended.push({ name, args });
          await options.append?.();
        },
      }),
    } as unknown as AdminViewCallHost["audits"],
    logger: {
      warn: (...args: unknown[]) => { warnings.push(args); },
    } as unknown as AdminViewCallHost["logger"],
    assertLive: () => {
      log.push("assertLive");
      assertAdminViewLive(terms, ADMIN, env());
      if (++checks === options.microtaskAtCheck) queueMicrotask(() => log.push("microtask"));
    },
    recordOf: refused => {
      log.push("recordOf");
      recorded.push(refused);
      return recordOf(terms, refused);
    },
  };
  // Replaces the environment under the view, as a deployment's can change under a live one.
  let setVars = (changed: Record<string, unknown>) => { vars = { ...vars, ...changed }; };
  // A read that notes it ran and answers with `answer`.
  let reads = <T>(answer: T) => () => {
    log.push("read");
    return answer;
  };
  return { host, terms, log, recorded, appended, warnings, setVars, reads };
}

// What `call` rejected with, failing the test if it resolved.
async function rejection(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject.");
}

async function codeOf(call: Promise<unknown>): Promise<string | undefined> {
  return getAdminAccessErrorCode(await rejection(call));
}

// A read that fails.
function noSuchChat(): never {
  throw new Error("no such chat");
}

describe("adminViewCall", () => {
  it("checks, reads the setting, checks, reads, checks, and records before answering", async () => {
    let appending = deferred();
    // A microtask queued by the last check runs only once the call yields: after the record was
    // built and sent, when nothing is awaited between them.
    let view = fakeView({ microtaskAtCheck: 3, append: () => appending.promise });

    let answered = false;
    let call = adminViewCall(view.host, view.reads("answer")).then(answer => {
      answered = true;
      return answer;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.log).toStrictEqual([
      "assertLive", "config", "assertLive", "read", "assertLive", "recordOf", "append",
      "microtask",
    ]);
    expect(answered).toBe(false);

    appending.resolve();
    expect(await call).toBe("answer");
  });

  it("records each call in the deployment-wide log with no retention", async () => {
    let view = fakeView();
    // `read` is given nothing: no level, no policy.
    let given: unknown[][] = [];
    let read = (...args: unknown[]) => {
      given.push(args);
      return { text: "a title" };
    };

    expect(await adminViewCall(view.host, read)).toStrictEqual({ text: "a title" });
    expect(await adminViewCall(view.host, async () => "later")).toBe("later");

    expect(given).toStrictEqual([[]]);
    expect(view.recorded).toStrictEqual([undefined, undefined]);
    // The log's one object, and the record alone: a retention would prune by a stale policy.
    expect(view.appended).toStrictEqual([
      { name: "", args: [recordOf(view.terms)] },
      { name: "", args: [recordOf(view.terms)] },
    ]);
    expect(view.warnings).toStrictEqual([]);
  });

  it("records and refuses a call while the level is off, having read nothing", async () => {
    let { accessOff } = ADMIN_ACCESS_ERROR_CODES;
    for (let deployment of [
      OFF,
      { vars: { ADMIN_WORKSPACE_ACCESS_MAX: "off" } },
      // A value that is not a level, stored or in the environment, is "off".
      { config: { adminWorkspaceAccess: "full" } },
      { vars: { ADMIN_WORKSPACE_ACCESS_MAX: "full" } },
    ]) {
      let view = fakeView(deployment);
      expect(await codeOf(adminViewCall(view.host, view.reads("answer"))),
          JSON.stringify(deployment)).toBe(accessOff);
      expect(view.log).toStrictEqual(["assertLive", "config", "assertLive", "recordOf", "append"]);
      expect(view.recorded).toStrictEqual([accessOff]);
      expect(view.appended).toStrictEqual(
          [{ name: "", args: [recordOf(view.terms, accessOff)] }]);
    }
  });

  it("answers again once the level is back at metadata", async () => {
    let config: { adminWorkspaceAccess: string } = { adminWorkspaceAccess: "off" };
    let view = fakeView({ config });
    expect(await codeOf(adminViewCall(view.host, view.reads("answer"))))
        .toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);

    config.adminWorkspaceAccess = "metadata";
    expect(await adminViewCall(view.host, view.reads("answer"))).toBe("answer");
    expect(view.recorded).toStrictEqual([ADMIN_ACCESS_ERROR_CODES.accessOff, undefined]);
  });

  it("records a read that fails as an attempt", async () => {
    let failure = new Error("no such chat");
    // A read that throws, and one that rejects.
    for (let fail of [() => { throw failure; }, () => Promise.reject(failure)]) {
      let view = fakeView();
      let read = () => {
        view.log.push("read");
        return fail();
      };
      expect(await rejection(adminViewCall(view.host, read))).toBe(failure);
      expect(view.log).toStrictEqual([
        "assertLive", "config", "assertLive", "read", "assertLive", "recordOf", "append",
      ]);
      expect(view.recorded).toStrictEqual([undefined]);
      expect(view.appended).toStrictEqual([{ name: "", args: [recordOf(view.terms)] }]);
    }
  });

  it("records a refusal and a failed read with nothing awaited since the last check", async () => {
    // The last check is the second of a refused call and the third of one whose read failed. The
    // microtask it queues runs only once the call yields: after the record was built and sent.
    let refused = fakeView({ ...OFF, microtaskAtCheck: 2 });
    await rejection(adminViewCall(refused.host, refused.reads("answer")));
    expect(refused.log.slice(-3)).toStrictEqual(["recordOf", "append", "microtask"]);

    let failed = fakeView({ microtaskAtCheck: 3 });
    await rejection(adminViewCall(failed.host, noSuchChat));
    expect(failed.log.slice(-3)).toStrictEqual(["recordOf", "append", "microtask"]);
  });

  it("records nothing for a view that is no longer live", async () => {
    let { notAdmin, viewExpired } = ADMIN_ACCESS_ERROR_CODES;

    // At the first check.
    let expired = fakeView({ terms: { expiresAt: new Date(Date.now() - 1) } });
    expect(await codeOf(adminViewCall(expired.host, expired.reads("answer")))).toBe(viewExpired);
    expect(expired.log).toStrictEqual(["assertLive"]);

    // While the setting is read.
    let reading = deferred();
    let demoted = fakeView({ onConfigRead: () => reading.promise });
    let call = adminViewCall(demoted.host, demoted.reads("answer"));
    demoted.setVars({ ADMINS: [] });
    reading.resolve();
    expect(await codeOf(call)).toBe(notAdmin);
    expect(demoted.log).toStrictEqual(["assertLive", "config", "assertLive"]);

    // While the answer is read.
    let during = fakeView();
    let read = () => {
      during.log.push("read");
      during.setVars({ ADMINS: [] });
      return "answer";
    };
    expect(await codeOf(adminViewCall(during.host, read))).toBe(notAdmin);
    expect(during.log).toStrictEqual(["assertLive", "config", "assertLive", "read", "assertLive"]);

    // While a read that fails runs: the view's refusal, not the read's error.
    let failing = fakeView();
    let failingRead = () => {
      failing.log.push("read");
      failing.setVars({ ADMINS: [] });
      throw new Error("no such chat");
    };
    expect(await codeOf(adminViewCall(failing.host, failingRead))).toBe(notAdmin);
    expect(failing.log).toStrictEqual(["assertLive", "config", "assertLive", "read", "assertLive"]);

    for (let view of [expired, demoted, during, failing]) {
      expect(view.recorded).toStrictEqual([]);
      expect(view.appended).toStrictEqual([]);
    }
  });

  it("fails, logging the method alone, when the record cannot be written", async () => {
    let failure = new Error("audit store down");
    let view = fakeView({ append: () => Promise.reject(failure) });
    let outcome = await adminViewCall(view.host, view.reads("answer"))
        .then(answer => ({ answer }), error => ({ error }));
    expect(outcome).toStrictEqual({ error: failure });
    expect(view.log).toContain("read");
    // Never the record: it holds the reason and the call's arguments.
    expect(view.warnings).toStrictEqual([[
      "failed to append to the admin audit log",
      { event: "admin.audit.append.failed", operation: "describe", error: failure },
    ]]);
  });

  it("fails a refusal and a failed read alike when the record cannot be written", async () => {
    let failure = new Error("audit store down");
    let append = () => Promise.reject(failure);

    // Each fails with the record's error, not its own: neither is answered unrecorded.
    let refused = fakeView({ ...OFF, append });
    expect(await rejection(adminViewCall(refused.host, refused.reads("answer")))).toBe(failure);
    expect(refused.warnings).toHaveLength(1);

    let failed = fakeView({ append });
    expect(await rejection(adminViewCall(failed.host, noSuchChat))).toBe(failure);
    expect(failed.warnings).toHaveLength(1);
  });

  it("reads the environment at each use", async () => {
    // The cap allows "metadata" until the setting has been read and is "off" after it, as an
    // environment replaced under a live view is: the policy takes the cap as it is by then.
    let view = fakeView({
      onConfigRead: () => { view.setVars({ ADMIN_WORKSPACE_ACCESS_MAX: "off" }); },
    });
    expect(await codeOf(adminViewCall(view.host, view.reads("answer"))))
        .toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
    expect(view.log).not.toContain("read");
    expect(view.recorded).toStrictEqual([ADMIN_ACCESS_ERROR_CODES.accessOff]);
  });
});

describe("assertAdminViewTerms", () => {
  it("returns the trimmed reason of a well-formed open", () => {
    expect(assertAdminViewTerms(`  ${REASON}\n`, termsOf())).toBe(REASON);
    expect(assertAdminViewTerms(REASON, termsOf({ via: "cli" }))).toBe(REASON);
    // The longest lifetime, and one minted by a clock half a minute ahead: a minute of skew is
    // allowed.
    for (let seconds of [MAX_ADMIN_VIEW_LIFETIME_SECONDS, MAX_ADMIN_VIEW_LIFETIME_SECONDS + 30]) {
      let expiresAt = new Date(Date.now() + seconds * 1000);
      expect(assertAdminViewTerms(REASON, termsOf({ expiresAt }))).toBe(REASON);
    }
  });

  it("rejects a malformed open", () => {
    for (let reason of ["", "  \n", "r".repeat(MAX_ADMIN_ACCESS_REASON_LENGTH + 1)]) {
      expect(() => assertAdminViewTerms(reason, termsOf()), JSON.stringify(reason.slice(0, 8)))
          .toThrow(TypeError);
    }
    for (let [malformed, message] of [
      [{ via: "gatekeeper" }, "An admin view's via must be \"api\" or \"cli\"."],
      [{ expiresAt: new Date(NaN) },
        "An admin view's expiry must be a valid time within its longest lifetime."],
      [{ expiresAt: new Date(Date.now() + 60_000).toISOString() },
        "An admin view's expiry must be a valid time within its longest lifetime."],
      [{ expiresAt: new Date(Date.now() + (MAX_ADMIN_VIEW_LIFETIME_SECONDS + 120) * 1000) },
        "An admin view's expiry must be a valid time within its longest lifetime."],
    ] as const) {
      let terms = { ...termsOf(), ...malformed } as unknown as AdminViewTerms;
      let call = () => assertAdminViewTerms(REASON, terms);
      expect(call, JSON.stringify(malformed)).toThrow(TypeError);
      expect(call, JSON.stringify(malformed)).toThrow(message);
    }
  });

  it("accepts an expiry already past", () => {
    // Not malformed: the open is then refused as any call on an expired view is.
    expect(assertAdminViewTerms(REASON, termsOf({ expiresAt: new Date(Date.now() - 60_000) })))
        .toBe(REASON);
  });
});
