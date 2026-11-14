import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADMIN_AUDIT_RETENTION_DAYS, MAX_ADMIN_AUDIT_ARG_LENGTH, MAX_ADMIN_AUDIT_RETENTION_DAYS,
  MAX_ADMIN_AUDIT_VALUE_LENGTH, MAX_ANNOUNCEMENT_LENGTH, MAX_INSTANCE_INSTRUCTIONS_LENGTH,
} from "@gadgets/workshop-shared/api";
import {
  ADMIN_AUDIT_EXCERPT_CONTEXT, adminAccessPolicy, adminAuditStatsDays, adminAuditValue,
  adminListLimit, adminSettingChange, cutAdminAuditText, minAdminAuditRetentionDays,
} from "../src/admin-access.js";

// The variables these helpers read, as a deployment's environment carries them: a secret or a
// `.env` file gives strings, a JSON binding any JSON value.
function envWith(vars: Record<string, unknown>): Cloudflare.Env {
  return vars as unknown as Cloudflare.Env;
}

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
  it("holds the admins' choice within the environment's bound", () => {
    let chosen = { adminAuditRetentionDays: 30 };
    expect(adminAccessPolicy(chosen, envWith({})))
        .toEqual({ retentionDays: DEFAULT_ADMIN_AUDIT_RETENTION_DAYS });
    expect(adminAccessPolicy(chosen, envWith({ ADMIN_AUDIT_RETENTION_MIN_DAYS: "7" })))
        .toEqual({ retentionDays: 30 });
    expect(adminAccessPolicy({ adminAuditRetentionDays: 400 }, envWith({})))
        .toEqual({ retentionDays: 400 });
  });
});

describe("validators", () => {
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
