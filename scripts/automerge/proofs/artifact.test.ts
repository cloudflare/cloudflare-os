import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { format } from "node:util";

import { runProducer } from "./artifact.ts";

describe("runProducer", () => {
  // A failed request's error can hold what the server sent, as a property or on the error that
  // caused it, and the job log is public.
  it("logs and records a thrown error's message and stack, not its causes or properties", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "producer-"));
    const cwd = process.cwd();
    const printed: string[] = [];
    const print = (...values: (string | Error)[]) => {
      printed.push(format(...values));
    };
    t.mock.method(console, "error", print);
    t.mock.method(console, "log", print);
    process.env.AUTOMERGE_HEAD_SHA = "a".repeat(40);
    process.env.AUTOMERGE_BASE_SHA = "b".repeat(40);
    process.chdir(dir);
    t.after(() => {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    });
    await runProducer("proof-deps", async () => {
      const cause = Object.assign(new Error("the response did not parse"), { data: "sk-live" });
      throw Object.assign(new Error("fetch failed", { cause }), { response: { headers: { "set-cookie": "sk-live" } } });
    });
    const artifact = readFileSync(join(dir, "automerge-out", "automerge-proof-deps.json"), "utf8");
    for (const published of [artifact, ...printed]) assert.ok(!published.includes("sk-live"), published);
    assert.ok(artifact.includes("fetch failed") && printed.some((line) => line.includes("fetch failed")), printed.join("\n"));
  });
});
