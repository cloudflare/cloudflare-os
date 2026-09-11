import { describe, expect, it } from "vitest";
import { formatSkillUpdatedAt, skillUpdatedAtLabel } from "./skillUpdatedAt";

describe("formatSkillUpdatedAt", () => {
  const now = new Date("2026-09-11T12:00:00Z").getTime();

  it.each([
    ["2026-09-11T11:59:30Z", "now"],
    ["2026-09-11T11:48:00Z", "12m"],
    ["2026-09-11T08:00:00Z", "4h"],
    ["2026-08-30T12:00:00Z", "12d"],
    ["2025-09-11T12:00:00Z", "1y"],
  ])("formats %s as %s", (timestamp, expected) => {
    expect(formatSkillUpdatedAt(new Date(timestamp), now)).toBe(expected);
  });

  it("provides an unabbreviated accessible label", () => {
    const date = new Date("2026-09-11T11:48:00Z");
    expect(skillUpdatedAtLabel(date, now)).toBe("Updated 12 minutes ago");
  });
});
