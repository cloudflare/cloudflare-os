import { expect, it } from "vitest";
import { appendCodeModeReturnValue } from "../src/overseer.js";
it("preserves code mode return values", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(appendCodeModeReturnValue("", 1n)).toBe("1");
  expect(appendCodeModeReturnValue("started", { ok: true })).toBe('started\n{"ok":true}');
  expect(appendCodeModeReturnValue("", circular)).toBe("[unserializable return value]");
});
