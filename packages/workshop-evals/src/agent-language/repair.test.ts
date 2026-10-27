import { it, expect } from "vitest";
import { repairLoop } from "./runner.ts";
import { tasks } from "./tasks.ts";
it("feeds actionable diagnostics back and stops after success", async () => {
  const a = await repairLoop(
    tasks[0],
    "export default async function(self,env,ctx){return env.missing()}",
    "checkjs",
    async (_, d) => {
      expect(d.join(" ")).toContain("missing");
      return tasks[0].js;
    },
  );
  expect(a).toHaveLength(2);
  expect(a[1].success).toBe(true);
}, 20000);
it("bounds unsuccessful repair attempts", async () => {
  const a = await repairLoop(tasks[0], "bad code", "checkjs", async () => "bad code");
  expect(a).toHaveLength(3);
  expect(a.every((x) => !x.success)).toBe(true);
}, 20000);
