import { describe, expect, it } from "vitest";
import { checkName } from "../src/sharepoint-session";

describe("checkName", () => {
  it.each(["plan.md", "Q3 budget (final).xlsx", "Café notes", "a", "x".repeat(255), "con2.txt", ".github", "readme.lock"])(
    "accepts %j", name => {
      expect(checkName(name)).toBe(name);
    });

  it.each([
    ["", /required/],
    ["   ", /required/],
    [" plan.md", /start or end with a space/],
    ["plan.md ", /start or end with a space/],
    ["x".repeat(256), /at most 255/],
    ["a/b", /can't contain/],
    ["a\\b", /can't contain/],
    ["what?", /can't contain/],
    ["a:b", /can't contain/],
    ["tab\there", /can't contain/],
    ["draft.", /end with a period/],
    ["~$plan.docx", /Office reserves/],
    ["CON", /reserves/],
    ["con.txt", /reserves/],
    ["LPT1", /reserves/],
    ["desktop.ini", /reserves/],
    [".lock", /reserves/],
    ["my_vti_folder", /reserves/],
  ])("refuses %j", (name, message) => {
    expect(() => checkName(name)).toThrow(message);
  });
});
