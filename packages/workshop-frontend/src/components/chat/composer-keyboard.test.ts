import { describe, expect, it } from "vitest";
import { isImeComposing } from "./composer-keyboard";

describe("composer keyboard handling", () => {
  it("recognizes a standards-based IME composition event", () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  it("recognizes the legacy IME process key used by older browsers", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("leaves an ordinary Enter key available for message submission", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
