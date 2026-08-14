import { expect, it } from "vitest";
import { appendCodeModeReturnValue, CODE_MODE_HARNESS } from "../src/overseer.js";
it("preserves code mode return values", () => {
  expect(CODE_MODE_HARNESS).toContain("return await agent");
  expect(appendCodeModeReturnValue("", 1n)).toBe("1");
  expect(appendCodeModeReturnValue("started", { ok: true })).toBe('started\n{"ok":true}');
});
