import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isInstructionPath } from "./instructions.ts";

describe("isInstructionPath", () => {
  it("matches instruction files and directories at any depth and in any case", () => {
    for (const path of ["AGENTS.md", "packages/x/AGENTS.md", "a/b/c/d/agents.md", "CLAUDE.md", "pkg/Claude.md",
      "REVIEW.md", "docs/review.md", "packages/ui/src/CONTEXT.md", "CONTRIBUTING.md", "opencode.json", "packages/x/opencode.jsonc",
      ".agents/skills/x/SKILL.md", "packages/x/.agents/skills/y/SKILL.md", ".opencode/tool/run.ts",
      "packages/x/.opencode/plugin/p.js", ".claude/settings.json", "deep/.Claude/commands/c.md"]) {
      assert.equal(isInstructionPath(path), true, path);
    }
    for (const path of ["src/agents.ts", "AGENTS.md.bak", "docs/agents/guide.md", "packages/opencode/src/a.ts",
      "agents/readme.md", ".agents", ".claude"]) {
      assert.equal(isInstructionPath(path), false, path);
    }
  });
});
