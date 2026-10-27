import { it, expect } from "vitest";
import { tasks, verify, typescript } from "./tasks.ts";
import { validate } from "./compiler.ts";
import { execute } from "./runtime.ts";
for (const task of tasks) {
  it(`reference JS / TS: ${task.id}`, async () => {
    for (const variant of ["checkjs", "ts"] as const) {
      const checked = validate(variant === "ts" ? typescript(task.js) : task.js, variant);
      expect(checked.diagnostics).toEqual([]);
    }
    expect(verify(task, await execute(task.js))).toBe(true);
  }, 30000);
  it(`reference BAML: ${task.id}`, async () => {
    const r = await execute(task.baml, true, task.bindings);
    expect(r.error).toBeUndefined();
    expect(verify(task, r)).toBe(true);
  }, 30000);
}
