import { describe, expect, it } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, DEFAULT_ADMIN_AUDIT_RETENTION_DAYS, MAX_ADMIN_AUDIT_ARG_LENGTH,
  MAX_ADMIN_AUDIT_RETENTION_DAYS, MAX_ADMIN_AUDIT_VALUE_LENGTH, MAX_ANNOUNCEMENT_LENGTH,
  MAX_INSTANCE_INSTRUCTIONS_LENGTH, getAdminAccessErrorCode,
  type ActionLogEntry, type AdminChatState, type AiChatHistoryPage, type AiChatMetadata,
  type BoundHookInfo, type FileAtCommit, type WorkpieceSummary,
} from "@gadgets/workshop-shared/api";
import {
  ADMIN_AUDIT_EXCERPT_CONTEXT, actionHoldsContent, adminAccessPolicy, adminAuditStatsDays,
  adminAuditValue, adminListLimit, adminSettingChange, adminViewCallAccess, adminViewLifetimeMs,
  assertAdminViewLive, chatHoldsContent, chatPageHoldsContent, chatStateHoldsContent,
  cutAdminAuditText, fileHoldsContent, hookHoldsContent,
  lowerAdminWorkspaceAccess, maxAdminWorkspaceAccess, minAdminAuditRetentionDays,
  redactAdminAuditArgs, validateAdminAccessReason, withholdActionContent, withholdChatContent,
  withholdChatStateContent, withholdHookContent, workpieceHoldsContent, type AdminViewTerms,
} from "../src/admin-access.js";

// The variables these helpers read, as a deployment's environment carries them: a secret or a
// `.env` file gives strings, a JSON binding any JSON value.
function envWith(vars: Record<string, unknown>): Cloudflare.Env {
  return vars as unknown as Cloudflare.Env;
}

function codeOf(call: () => unknown): string | undefined {
  try {
    call();
  } catch (err) {
    return getAdminAccessErrorCode(err);
  }
  throw new Error("expected a refusal");
}

const ADMIN = "admin@example.test";
const adminEnv = envWith({ ADMINS: [ADMIN] });

function terms(overrides: Partial<AdminViewTerms> = {}): AdminViewTerms {
  return {
    via: "api", requested: "full", access: "full", expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe("maxAdminWorkspaceAccess", () => {
  it("is metadata while unset or blank", () => {
    expect(maxAdminWorkspaceAccess(envWith({}))).toBe("metadata");
    expect(maxAdminWorkspaceAccess(envWith({ ADMIN_WORKSPACE_ACCESS_MAX: "" }))).toBe("metadata");
    expect(maxAdminWorkspaceAccess(envWith({ ADMIN_WORKSPACE_ACCESS_MAX: "  " }))).toBe("metadata");
  });

  it("reads each level in any case, trimmed", () => {
    expect(maxAdminWorkspaceAccess(envWith({ ADMIN_WORKSPACE_ACCESS_MAX: " Off " }))).toBe("off");
    expect(maxAdminWorkspaceAccess(envWith({ ADMIN_WORKSPACE_ACCESS_MAX: "METADATA" })))
        .toBe("metadata");
    expect(maxAdminWorkspaceAccess(envWith({ ADMIN_WORKSPACE_ACCESS_MAX: "\tFull\n" })))
        .toBe("full");
  });

  // A value meant to turn inspection off must never grant the default.
  it("fails closed to off for anything that is not a level", () => {
    for (let value of ["none", "false", "of", "disabled", "1"]) {
      expect(maxAdminWorkspaceAccess(envWith({ ADMIN_WORKSPACE_ACCESS_MAX: value })), value)
          .toBe("off");
    }
  });
});

describe("minAdminAuditRetentionDays", () => {
  it("defaults while unset or blank, and reads a positive whole number", () => {
    expect(minAdminAuditRetentionDays(envWith({}))).toBe(DEFAULT_ADMIN_AUDIT_RETENTION_DAYS);
    expect(minAdminAuditRetentionDays(envWith({ ADMIN_AUDIT_RETENTION_MIN_DAYS: " " })))
        .toBe(DEFAULT_ADMIN_AUDIT_RETENTION_DAYS);
    expect(minAdminAuditRetentionDays(envWith({ ADMIN_AUDIT_RETENTION_MIN_DAYS: "120" }))).toBe(120);
    expect(minAdminAuditRetentionDays(envWith({ ADMIN_AUDIT_RETENTION_MIN_DAYS: 120 }))).toBe(120);
    expect(minAdminAuditRetentionDays(envWith({ ADMIN_AUDIT_RETENTION_MIN_DAYS: "7" }))).toBe(7);
  });

  it("defaults for anything else, and caps at the longest retention", () => {
    for (let value of ["0", "-5", "1.5", "abc", 0, -5, 1.5]) {
      expect(minAdminAuditRetentionDays(envWith({ ADMIN_AUDIT_RETENTION_MIN_DAYS: value })),
          String(value)).toBe(DEFAULT_ADMIN_AUDIT_RETENTION_DAYS);
    }
    expect(minAdminAuditRetentionDays(envWith({ ADMIN_AUDIT_RETENTION_MIN_DAYS: "5000" })))
        .toBe(MAX_ADMIN_AUDIT_RETENTION_DAYS);
  });
});

describe("adminAccessPolicy", () => {
  it("orders the levels", () => {
    expect(lowerAdminWorkspaceAccess("full", "metadata")).toBe("metadata");
    expect(lowerAdminWorkspaceAccess("off", "full")).toBe("off");
    expect(lowerAdminWorkspaceAccess("metadata", "metadata")).toBe("metadata");
  });

  it("holds the admins' choices within the environment's bounds", () => {
    let full = { adminWorkspaceAccess: "full", adminAuditRetentionDays: 30 } as const;
    expect(adminAccessPolicy(full, envWith({})))
        .toEqual({ access: "metadata", retentionDays: DEFAULT_ADMIN_AUDIT_RETENTION_DAYS });
    expect(adminAccessPolicy(full, envWith({
      ADMIN_WORKSPACE_ACCESS_MAX: "full", ADMIN_AUDIT_RETENTION_MIN_DAYS: "7",
    }))).toEqual({ access: "full", retentionDays: 30 });
    expect(adminAccessPolicy(full, envWith({ ADMIN_WORKSPACE_ACCESS_MAX: "nope" })).access)
        .toBe("off");
    expect(adminAccessPolicy({ adminWorkspaceAccess: "off", adminAuditRetentionDays: 400 },
        envWith({ ADMIN_WORKSPACE_ACCESS_MAX: "full" })))
        .toEqual({ access: "off", retentionDays: 400 });
  });
});

describe("validators", () => {
  it("validates the reason", () => {
    expect(validateAdminAccessReason("  ticket 42  ")).toBe("ticket 42");
    expect(validateAdminAccessReason("x".repeat(500))).toHaveLength(500);
    expect(() => validateAdminAccessReason("   ")).toThrow("at most 500 characters");
    expect(() => validateAdminAccessReason("x".repeat(501))).toThrow(TypeError);
  });

  it("validates the view's lifetime", () => {
    expect(adminViewLifetimeMs(undefined)).toBe(900_000);
    expect(adminViewLifetimeMs(1)).toBe(1000);
    expect(adminViewLifetimeMs(3600)).toBe(3_600_000);
    for (let bad of [0, 3601, 1.5, Number.NaN]) {
      expect(() => adminViewLifetimeMs(bad), String(bad)).toThrow("from 1 to 3600");
    }
  });

  it("validates the page size", () => {
    expect(adminListLimit(undefined)).toBe(50);
    expect(adminListLimit(200)).toBe(200);
    for (let bad of [0, 201, 2.5]) {
      expect(() => adminListLimit(bad)).toThrow("The page size must be a whole number from 1 to 200.");
    }
  });

  it("validates the statistics window", () => {
    expect(adminAuditStatsDays(undefined)).toBe(7);
    expect(adminAuditStatsDays(366)).toBe(366);
    for (let bad of [0, 367, 0.5]) expect(() => adminAuditStatsDays(bad)).toThrow("from 1 to 366");
  });
});

describe("view calls", () => {
  it("refuses an expired view before checking the admin", () => {
    let expired = terms({ expiresAt: new Date(1000) });
    expect(codeOf(() => assertAdminViewLive(expired, "someone-else", adminEnv, 1000)))
        .toBe(ADMIN_ACCESS_ERROR_CODES.viewExpired);
    expect(codeOf(() => assertAdminViewLive(terms(), "someone-else", adminEnv)))
        .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    expect(() => assertAdminViewLive(terms(), ADMIN, adminEnv)).not.toThrow();
  });

  it("runs each call at the view's level lowered to the policy's", () => {
    let metadata = { access: "metadata", retentionDays: 90 } as const;
    expect(adminViewCallAccess(terms(), "describe", metadata)).toEqual({ access: "metadata" });
    expect(adminViewCallAccess(terms(), "getChat", metadata))
        .toEqual({ access: "metadata", refused: ADMIN_ACCESS_ERROR_CODES.contentWithheld });
    expect(adminViewCallAccess(terms({ access: "metadata" }), "readFile",
        { access: "full", retentionDays: 90 }))
        .toEqual({ access: "metadata", refused: ADMIN_ACCESS_ERROR_CODES.contentWithheld });
    expect(adminViewCallAccess(terms(), "getChat", { access: "full", retentionDays: 90 }))
        .toEqual({ access: "full" });
    expect(adminViewCallAccess(terms(), "readChatAttachment", metadata))
        .toEqual({ access: "metadata", refused: ADMIN_ACCESS_ERROR_CODES.contentWithheld });
    expect(adminViewCallAccess(terms(), "readChatAttachment",
        { access: "full", retentionDays: 90 }))
        .toEqual({ access: "full" });
    // The chat reads that are not content run at either level.
    for (let method of ["getChatState", "listChatAttachments"] as const) {
      expect(adminViewCallAccess(terms(), method, metadata)).toEqual({ access: "metadata" });
    }
    expect(adminViewCallAccess(terms(), "describe", { access: "off", retentionDays: 90 }))
        .toEqual({ access: "off", refused: ADMIN_ACCESS_ERROR_CODES.accessOff });
  });
});

describe("cutAdminAuditText", () => {
  it("keeps text at or below the limit whole", () => {
    expect(cutAdminAuditText("abc", 3)).toBe("abc");
    expect(cutAdminAuditText("", 3)).toBe("");
  });

  it("cuts longer text to the limit, marked", () => {
    let cut = cutAdminAuditText("abcdef", 4);
    expect(cut).toBe("abc…");
    expect(cut).toHaveLength(4);
  });

  it("never splits a surrogate pair", () => {
    // "a😀b": the pair occupies indices 1 and 2, so a cut keeping two characters would split it.
    expect(cutAdminAuditText("a😀b", 3)).toBe("a…");
    expect(cutAdminAuditText("a😀b", 3)).toHaveLength(2);
    expect(cutAdminAuditText("😀😀", 3)).toBe("😀…");
  });

  it("cuts a multi-MiB string to the argument limit", () => {
    let cut = cutAdminAuditText("x".repeat(3 * 2 ** 20), MAX_ADMIN_AUDIT_ARG_LENGTH);
    expect(cut).toHaveLength(MAX_ADMIN_AUDIT_ARG_LENGTH);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("is the cut redactAdminAuditArgs() applies", () => {
    let long = "p".repeat(1000);
    expect(redactAdminAuditArgs({ path: long, chatId: 3, beforeSequence: undefined })).toEqual({
      path: cutAdminAuditText(long, MAX_ADMIN_AUDIT_ARG_LENGTH),
      chatId: 3,
    });
  });
});

describe("withholding content", () => {
  it("drops queued steers from a copy", () => {
    let meta = {
      id: 1, title: "t", started: new Date(0), lastActive: new Date(0),
      queuedSteers: [{ text: "secret", author: { id: "u", name: "U" } }],
    } as AiChatMetadata;
    let withheld = withholdChatContent(meta);
    expect(withheld).not.toHaveProperty("queuedSteers");
    expect(withheld.title).toBe("t");
    expect(meta.queuedSteers).toHaveLength(1);
  });

  it("empties descriptions and drops fields from a copy", () => {
    let fields = [{ label: "To", value: "x@example.com" }];
    let action = {
      id: 1, resourceTitle: "r", createdAt: new Date(0), state: "pending", type: "action",
      description: { title: "Send", description: "body", fields },
    } as unknown as ActionLogEntry;
    let observation = {
      id: 2, resourceTitle: "r", createdAt: new Date(0), state: "approved", type: "observation",
      description: { title: "Read", description: "content", fields },
    } as unknown as ActionLogEntry;
    let hookEntry = {
      id: 3, resourceTitle: "r", createdAt: new Date(0), state: "approved", type: "bindHook",
      enabled: true, description: { title: "Hook", description: "what it does" },
    } as unknown as ActionLogEntry;

    for (let entry of [action, observation, hookEntry]) {
      let before = structuredClone(entry);
      let withheld = withholdActionContent(entry);
      expect(withheld.description.title).toBe(entry.description.title);
      expect(withheld.description.description).toBe("");
      expect(withheld.description).not.toHaveProperty("fields");
      expect(entry).toEqual(before);
    }

    let hook = {
      id: 1, gatekeeperId: 2, gadgetId: 3, enabled: true,
      description: { title: "Hook", description: "what it does" },
    } as unknown as BoundHookInfo;
    expect(withholdHookContent(hook).description).toEqual({ title: "Hook", description: "" });
    expect(hook.description.description).toBe("what it does");
  });

  it("empties each queued call's argument summary on a copy", () => {
    let state = chatState(["first summary", "second summary"]);
    let before = structuredClone(state);
    expect(withholdChatStateContent(state)).toStrictEqual({
      ...before,
      queuedCalls: before.queuedCalls.map(call => ({ ...call, argsSummary: "" })),
    });
    expect(state).toStrictEqual(before);
  });
});

// A chat's state with a recorded turn, a pending action and one queued call per summary.
function chatState(summaries: string[]): AdminChatState {
  return {
    turn: {
      modelId: "m", initiator: { type: "user", id: "u", name: "U" }, callbackInitiated: false,
      resumeAttempts: 1, paused: true,
    },
    lastMessageAt: new Date(0),
    queuedCalls: summaries.map((argsSummary, callId) =>
        ({ callId, methodName: "run", initiatorModelId: null, argsSummary })),
    pendingActionIds: [4],
  };
}

// Answers as a view returns them, for the *HoldsContent() predicates.
function chatMeta(extra: Partial<AiChatMetadata> = {}): AiChatMetadata {
  return { id: 1, title: "t", started: new Date(0), lastActive: new Date(0), ...extra } as
      AiChatMetadata;
}
function logEntry(type: ActionLogEntry["type"], description: object): ActionLogEntry {
  return {
    id: 1, resourceTitle: "r", createdAt: new Date(0), state: "approved", type,
    ...(type === "bindHook" ? { enabled: true } : {}), description,
  } as unknown as ActionLogEntry;
}
function boundHook(description: string): BoundHookInfo {
  return {
    id: 1, gatekeeperId: 2, gadgetId: 3, enabled: true,
    description: { title: "Hook", description },
  } as unknown as BoundHookInfo;
}
function gadgetSummary(extra: Partial<WorkpieceSummary> = {}): WorkpieceSummary {
  return { id: "g", type: "gadget", title: "G", ...extra } as WorkpieceSummary;
}
const STEERS = [{ text: "secret", author: { id: "u", name: "U" } }];
const FIELDS = [{ label: "To", value: "x@example.com" }];

describe("whether an answer holds content", () => {
  it("finds a queued steer in a chat", () => {
    let full = chatMeta({ queuedSteers: STEERS } as Partial<AiChatMetadata>);
    expect(chatHoldsContent(full)).toBe(true);
    expect(chatHoldsContent(chatMeta({ queuedSteers: [] }))).toBe(false);
    expect(chatHoldsContent(chatMeta())).toBe(false);
    expect(chatHoldsContent(withholdChatContent(full))).toBe(false);
  });

  it("finds a queued call's argument summary in a chat's state", () => {
    let full = chatState(["", "summary"]);
    expect(chatStateHoldsContent(full)).toBe(true);
    expect(chatStateHoldsContent(chatState([]))).toBe(false);
    expect(chatStateHoldsContent(chatState(["", ""]))).toBe(false);
    expect(chatStateHoldsContent(withholdChatStateContent(full))).toBe(false);
  });

  it("finds a description or a field in an action log entry", () => {
    for (let type of ["action", "observation"] as const) {
      let full = logEntry(type, { title: "T", description: "body", fields: FIELDS });
      expect(actionHoldsContent(full)).toBe(true);
      expect(actionHoldsContent(logEntry(type, { title: "T", description: "", fields: FIELDS })))
          .toBe(true);
      expect(actionHoldsContent(logEntry(type, { title: "T", description: "" }))).toBe(false);
      expect(actionHoldsContent(logEntry(type, { title: "T", description: "", fields: [] })))
          .toBe(false);
      expect(actionHoldsContent(withholdActionContent(full))).toBe(false);
    }
    let bound = logEntry("bindHook", { title: "Hook", description: "what it does" });
    expect(actionHoldsContent(bound)).toBe(true);
    expect(actionHoldsContent(logEntry("bindHook", { title: "Hook", description: "" })))
        .toBe(false);
    expect(actionHoldsContent(withholdActionContent(bound))).toBe(false);
  });

  it("finds a hook's description", () => {
    expect(hookHoldsContent(boundHook("what it does"))).toBe(true);
    expect(hookHoldsContent(boundHook(""))).toBe(false);
    expect(hookHoldsContent(withholdHookContent(boundHook("what it does")))).toBe(false);
  });

  it("finds the blueprint a gadget follows", () => {
    let upstream = { blueprintId: "bp-1", commitId: "c" };
    expect(workpieceHoldsContent(gadgetSummary({ upstream }))).toBe(true);
    expect(workpieceHoldsContent(gadgetSummary({ upstream: {} }))).toBe(false);
    expect(workpieceHoldsContent(gadgetSummary())).toBe(false);
    expect(workpieceHoldsContent({ id: "w", type: "worktree", title: "W" } as WorkpieceSummary))
        .toBe(false);
  });

  it("finds messages or a compaction summary in a chat page", () => {
    let message = { sequence: 1 } as unknown as AiChatHistoryPage["messages"][number];
    let compacted = { to: 1, summary: "s" } as AiChatHistoryPage["compacted"];
    expect(chatPageHoldsContent({ messages: [message] })).toBe(true);
    expect(chatPageHoldsContent({ messages: [], compacted })).toBe(true);
    expect(chatPageHoldsContent({ messages: [] })).toBe(false);
    expect(chatPageHoldsContent({ messages: [], compacted: undefined })).toBe(false);
  });

  it("finds any file at the path, an unreadable one too", () => {
    let files: FileAtCommit[] = [
      { kind: "text", text: "x" }, { kind: "unreadable", message: "a is a symlink to b" },
      { kind: "absent" },
    ];
    expect(files.map(fileHoldsContent)).toEqual([true, true, false]);
  });
});

describe("adminAuditValue", () => {
  it("keeps strings as themselves and writes anything else as JSON", () => {
    expect(adminAuditValue("")).toBe("");
    expect(adminAuditValue('say "hi"\n')).toBe('say "hi"\n');
    expect(adminAuditValue(undefined)).toBeUndefined();
    expect(adminAuditValue(3)).toBe("3");
    expect(adminAuditValue(false)).toBe("false");
    expect(adminAuditValue(null)).toBe("null");
    expect(adminAuditValue("x".repeat(20_000))).toHaveLength(20_000);
  });

  it("sorts object keys at every level and keeps array order", () => {
    expect(adminAuditValue({ b: 1, a: { d: [3, 1, { z: 1, y: 2 }], c: null }, e: undefined }))
        .toBe('{"a":{"c":null,"d":[3,1,{"y":2,"z":1}]},"b":1}');
    expect(adminAuditValue([2, undefined, 1])).toBe("[2,null,1]");
  });

  it("keeps __proto__ and constructor keys as ordinary entries", () => {
    let value = JSON.parse('{"constructor": "c", "__proto__": "p", "a": 1}');
    let text = adminAuditValue(value)!;
    expect(text).toBe('{"__proto__":"p","a":1,"constructor":"c"}');
    let parsed = JSON.parse(text);
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(parsed.constructor).toBe("c");
  });
});

describe("adminSettingChange", () => {
  it("records nothing for equal values and leaves an absent side out", () => {
    expect(adminSettingChange("siteName", undefined, "a", "a")).toBeUndefined();
    expect(adminSettingChange("banner", undefined, { a: 1, b: 2 }, { b: 2, a: 1 })).toBeUndefined();
    expect(adminSettingChange("modelModes", "m", undefined, "disabled"))
        .toEqual({ setting: "modelModes", key: "m", after: "disabled" });
    expect(adminSettingChange("modelModes", "m", "disabled", undefined))
        .toEqual({ setting: "modelModes", key: "m", before: "disabled" });
  });

  it("cuts an over-long key", () => {
    let key200 = "k".repeat(200);
    expect(adminSettingChange("disabledResources", key200, undefined, ["x"])!.key).toBe(key200);
    let key = adminSettingChange("disabledResources", "k".repeat(300), undefined, ["x"])!.key!;
    expect(key).toHaveLength(MAX_ADMIN_AUDIT_ARG_LENGTH);
    expect(key.endsWith("…")).toBe(true);
  });

  it("keeps every bounded setting whole", () => {
    expect(MAX_ADMIN_AUDIT_VALUE_LENGTH).toBeGreaterThanOrEqual(MAX_INSTANCE_INSTRUCTIONS_LENGTH);
    expect(MAX_ADMIN_AUDIT_VALUE_LENGTH).toBeGreaterThanOrEqual(MAX_ANNOUNCEMENT_LENGTH);
    let before = "i".repeat(8_000);
    let after = `${"i".repeat(7_995)}edits`;
    expect(adminSettingChange("instanceInstructions", undefined, before, after))
        .toEqual({ setting: "instanceInstructions", before, after });
  });

  it("excerpts values past the cap around their first difference", () => {
    let before = "a".repeat(25_000);
    let after = `${"a".repeat(20_000)}B${"a".repeat(4_999)}`;
    let change = adminSettingChange("disabledResources", "v", before, after)!;
    let offset = 20_000 - ADMIN_AUDIT_EXCERPT_CONTEXT;
    expect(change.excerpt).toEqual({ offset, beforeLength: 25_000, afterLength: 25_000 });
    expect(change.before).toBe(before.slice(offset, offset + MAX_ADMIN_AUDIT_VALUE_LENGTH));
    expect(change.after).toBe(after.slice(offset, offset + MAX_ADMIN_AUDIT_VALUE_LENGTH));
    expect(change.after![ADMIN_AUDIT_EXCERPT_CONTEXT]).toBe("B");
  });

  it("excerpts an append past the cap from just before it", () => {
    let before = "a".repeat(MAX_ADMIN_AUDIT_VALUE_LENGTH);
    let after = `${before}tail`;
    let change = adminSettingChange("x", undefined, before, after)!;
    let offset = MAX_ADMIN_AUDIT_VALUE_LENGTH - ADMIN_AUDIT_EXCERPT_CONTEXT;
    expect(change.excerpt).toEqual({
      offset, beforeLength: MAX_ADMIN_AUDIT_VALUE_LENGTH,
      afterLength: MAX_ADMIN_AUDIT_VALUE_LENGTH + 4,
    });
    expect(change.before).toBe("a".repeat(ADMIN_AUDIT_EXCERPT_CONTEXT));
    expect(change.after).toBe(`${"a".repeat(ADMIN_AUDIT_EXCERPT_CONTEXT)}tail`);
  });

  it("excerpts a new value past the cap from its start", () => {
    let after = "z".repeat(12_000);
    let change = adminSettingChange("x", undefined, undefined, after)!;
    expect(change.excerpt).toEqual({ offset: 0, afterLength: 12_000 });
    expect(change).not.toHaveProperty("before");
    expect(change.after).toHaveLength(MAX_ADMIN_AUDIT_VALUE_LENGTH);
  });

  it("never splits a surrogate pair at either end of an excerpt", () => {
    // The first difference sits 100 characters after a pair's low half, so the excerpt would
    // start on it; and the excerpt's end falls between a pair's halves.
    let head = `${"a".repeat(4_999)}😀`;   // the pair occupies 4_999 and 5_000
    // Padding that puts the second pair's high half at the excerpt's last index, 14_998.
    let tailPad = "b".repeat(MAX_ADMIN_AUDIT_VALUE_LENGTH - 103);
    let before = `${head}${"c".repeat(99)}X${tailPad}😀more`;
    let after = `${head}${"c".repeat(99)}Y${tailPad}😀more`;
    let change = adminSettingChange("x", undefined, before, after)!;
    expect(change.excerpt!.offset).toBe(4_999);
    for (let excerpt of [change.before!, change.after!]) {
      expect(excerpt.length).toBeLessThanOrEqual(MAX_ADMIN_AUDIT_VALUE_LENGTH);
      expect(excerpt.startsWith("😀")).toBe(true);
      let last = excerpt.charCodeAt(excerpt.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });
});
