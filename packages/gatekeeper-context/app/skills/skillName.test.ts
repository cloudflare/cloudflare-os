import { describe, expect, it } from "vitest";
import {
  humanizeSkillName,
  isValidSkillName,
  sanitizeSkillTitle,
  skillNameFromTitle,
} from "./skillName";

describe("skill names", () => {
  it("humanizes metadata names for display", () => {
    expect(humanizeSkillName("incident-response-playbook"))
      .toBe("Incident Response Playbook");
  });

  it("converts human-readable titles to valid metadata names", () => {
    expect(skillNameFromTitle("  Résumé / Review!  ")).toBe("resume-review");
    expect(skillNameFromTitle("Incident -- Response")).toBe("incident-response");
  });

  it("sanitizes title input without forcing metadata formatting", () => {
    expect(sanitizeSkillTitle("Incident: Response")).toBe("Incident Response");
  });

  it("enforces the Agent Skills name constraints", () => {
    expect(isValidSkillName("incident-response")).toBe(true);
    expect(isValidSkillName("incident--response")).toBe(false);
    expect(isValidSkillName(`a${"b".repeat(64)}`)).toBe(false);
  });
});
