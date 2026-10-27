import { it, expect } from "vitest";
import { faults, faultProgram, faultTask } from "./faults.ts";
import { validate } from "./compiler.ts";
import { execute } from "./runtime.ts";
import { verify } from "./tasks.ts";
for (const [id, task, body] of faults)
  it(`oracle rejects ${id}`, async () => {
    const c = validate(faultProgram(body), "js");
    if (!c.diagnostics.length)
      expect(verify(faultTask(task), await execute(c.javascript))).toBe(false);
  }, 20000);
