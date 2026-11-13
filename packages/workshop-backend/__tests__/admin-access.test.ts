import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, DEFAULT_ADMIN_AUDIT_RETENTION_DAYS, MAX_ADMIN_AUDIT_ARG_LENGTH,
  MAX_ADMIN_AUDIT_RETENTION_DAYS, MAX_ADMIN_AUDIT_VALUE_LENGTH, MAX_ANNOUNCEMENT_LENGTH,
  MAX_INSTANCE_INSTRUCTIONS_LENGTH, getAdminAccessErrorCode,
  type ActionLogEntry, type AiChatMetadata, type BlueprintGadgetSummary, type BoundHookInfo,
  type CommitInfo, type GatekeeperCreationSpec,
} from "@gadgets/workshop-shared/api";
import {
  ADMIN_AUDIT_EXCERPT_CONTEXT, adminAccessPolicy, adminAuditStatsDays, adminAuditValue,
  adminCommitLogDepth, adminListLimit, adminSettingChange, adminViewLifetimeMs,
  assertAdminViewLive, cutAdminAuditText, lowerAdminWorkspaceAccess, maxAdminWorkspaceAccess,
  minAdminAuditRetentionDays, redactAdminAuditArgs, validateAdminAccessReason,
  withholdActionContent, withholdBlueprintContent, withholdChatContent, withholdCommitContent,
  withholdCreationContent, withholdHookContent,
  type AdminViewTerms,
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
  return { via: "api", expiresAt: new Date(Date.now() + 60_000), ...overrides };
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
    expect(maxAdminWorkspaceAccess(envWith({ ADMIN_WORKSPACE_ACCESS_MAX: "\tMetadata\n" })))
        .toBe("metadata");
  });

  // A value meant to turn inspection off must never grant the default, and neither must one that
  // names more than a level gives.
  it("fails closed to off for anything that is not a level, logging each value once", () => {
    let logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let values = ["none", "false", "of", "disabled", "1", "full", "FULL", " full "];
    for (let value of [...values, ...values]) {
      expect(maxAdminWorkspaceAccess(envWith({ ADMIN_WORKSPACE_ACCESS_MAX: value })), value)
          .toBe("off");
    }
    let entries = logged.mock.calls.map(([entry]) => entry as { event?: unknown });
    logged.mockRestore();
    expect(entries.map(entry => entry.event))
        .toEqual(values.map(() => "admin.access.config.invalid"));
    // The log names the variable, never the value it holds.
    expect(JSON.stringify(entries)).not.toMatch(/none|disabled|full/i);
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
    expect(lowerAdminWorkspaceAccess("metadata", "off")).toBe("off");
    expect(lowerAdminWorkspaceAccess("off", "metadata")).toBe("off");
    expect(lowerAdminWorkspaceAccess("metadata", "metadata")).toBe("metadata");
    expect(lowerAdminWorkspaceAccess("off", "off")).toBe("off");
  });

  it("holds the admins' choices within the environment's bounds", () => {
    let metadata = { adminWorkspaceAccess: "metadata", adminAuditRetentionDays: 30 } as const;
    expect(adminAccessPolicy(metadata, envWith({})))
        .toEqual({ access: "metadata", retentionDays: DEFAULT_ADMIN_AUDIT_RETENTION_DAYS });
    expect(adminAccessPolicy(metadata, envWith({
      ADMIN_WORKSPACE_ACCESS_MAX: "metadata", ADMIN_AUDIT_RETENTION_MIN_DAYS: "7",
    }))).toEqual({ access: "metadata", retentionDays: 30 });
    for (let cap of ["off", "nope", "full"]) {
      expect(adminAccessPolicy(metadata, envWith({ ADMIN_WORKSPACE_ACCESS_MAX: cap })).access, cap)
          .toBe("off");
    }
    expect(adminAccessPolicy({ adminWorkspaceAccess: "off", adminAuditRetentionDays: 400 },
        envWith({ ADMIN_WORKSPACE_ACCESS_MAX: "metadata" })))
        .toEqual({ access: "off", retentionDays: 400 });
  });

  // lowerAdminWorkspaceAccess() sorts a value that is not a level lowest and returns it, so the
  // policy checks the chosen value itself: every enforcement point compares its answer with "off".
  describe.each([
    ["no cap", {}],
    ["the cap at metadata", { ADMIN_WORKSPACE_ACCESS_MAX: "metadata" }],
  ])("with %s", (_name, vars) => {
    it.each(["full", "FULL", "", "none", undefined, null])(
        "gives off for a chosen value that is not a level: %j", value => {
      let env = envWith({ ...vars, ADMIN_AUDIT_RETENTION_MIN_DAYS: "7" });
      expect(adminAccessPolicy(
          { adminWorkspaceAccess: value as never, adminAuditRetentionDays: 30 }, env))
          .toEqual({ access: "off", retentionDays: 30 });
      expect(adminAccessPolicy(
          { adminWorkspaceAccess: "metadata", adminAuditRetentionDays: 30 }, env))
          .toEqual({ access: "metadata", retentionDays: 30 });
    });
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

  it("validates the commit log's depth", () => {
    expect(adminCommitLogDepth(undefined)).toBe(20);
    expect(adminCommitLogDepth(1)).toBe(1);
    expect(adminCommitLogDepth(100)).toBe(100);
    for (let bad of [0, 101, 1.5, NaN]) {
      expect(() => adminCommitLogDepth(bad)).toThrow(TypeError);
      expect(() => adminCommitLogDepth(bad))
          .toThrow("The commit log's depth must be a whole number from 1 to 100.");
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

  it("empties a commit's message on a copy", () => {
    let commit = commitInfo("Fix the parser\n");
    let before = structuredClone(commit);
    expect(withholdCommitContent(commit)).toStrictEqual({ ...before, message: "" });
    expect(commit).toStrictEqual(before);
  });

  it("drops a creation spec's configuration on a copy, and returns any other spec as it is", () => {
    let spec: GatekeeperCreationSpec = {
      type: "gatekeeper", vendorId: "vendor", typeUrlPattern: "https://*",
      resourceUrl: "https://example.com/thing", configuration: "what the agent suggested",
    };
    let before = structuredClone(spec);
    let { configuration: _configuration, ...rest } = before;
    expect(withholdCreationContent(spec)).toStrictEqual(rest);
    expect(spec).toStrictEqual(before);

    let ambient: GatekeeperCreationSpec = { type: "ambient", vendorId: "library", accountId: 3 };
    expect(withholdCreationContent(ambient)).toBe(ambient);
  });

  it("empties a blueprint's id and drops its screenshot URL on a copy", () => {
    let blueprint = blueprintSummary("bp-1");
    let before = structuredClone(blueprint);
    let { screenshotUrl: _screenshotUrl, ...rest } = before;
    expect(withholdBlueprintContent(blueprint)).toStrictEqual({ ...rest, id: "" });
    expect(blueprint).toStrictEqual(before);
  });
});

// A published blueprint with a screenshot, whose URL holds its id.
function blueprintSummary(id: string): BlueprintGadgetSummary {
  return {
    id, title: "Kit", description: "A kit", version: 2, codeVersionDate: new Date(1700000000_000),
    screenshotUrl: `/blueprint-screenshot/${id}?v=1`, dirty: true, unpublishedChanges: true,
  };
}

// A commit with one parent.
function commitInfo(message: string): CommitInfo {
  return {
    oid: "1".repeat(40), parents: ["2".repeat(40)], message,
    author: { name: "Owner", email: "owner@example.test" }, timestamp: new Date(1700000000_000),
  };
}

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
