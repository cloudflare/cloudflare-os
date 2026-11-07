// Judge code has no head dependencies: the gate and every producer's judging script import only
// `node:` builtins and relative modules under `scripts/automerge/` or `scripts/risk-review*`. A
// package import would resolve from the workspace, whose lockfile the pull request controls.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function judgeFiles(): string[] {
  const scripts = join(ROOT, "scripts");
  const found = readdirSync(scripts, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
    .filter((path) => path.startsWith("risk-review") || path.startsWith(`automerge/`));
  return found.map((path) => join(scripts, path));
}

/** Whether `path` is judge code an import may reach. */
function isJudgePath(path: string): boolean {
  const fromScripts = relative(join(ROOT, "scripts"), path);
  return fromScripts.startsWith("risk-review") || fromScripts.startsWith("automerge/");
}

/** Every module specifier in `source`: static imports and re-exports, and dynamic `import()`. */
function specifiers(source: string): { specifier: string | undefined; statement: string }[] {
  const found: { specifier: string | undefined; statement: string }[] = [];
  for (const match of source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)) {
    found.push({ specifier: match[1], statement: match[0].trim() });
  }
  for (const match of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) found.push({ specifier: match[1], statement: match[0].trim() });
  for (const match of source.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
    const literal = /^["']([^"']+)["']$/.exec(match[1]?.trim() ?? "");
    found.push({ specifier: literal?.[1], statement: match[0] });
  }
  return found;
}

describe("judge code imports", () => {
  const files = judgeFiles();

  it("finds the gate's modules", () => {
    assert.ok(files.some((path) => path.endsWith(join("scripts", "risk-review.ts"))));
  });

  for (const path of files) {
    it(`${relative(ROOT, path)} imports only node: builtins and judge modules`, () => {
      for (const { specifier, statement } of specifiers(readFileSync(path, "utf8"))) {
        assert.ok(specifier !== undefined, `non-literal dynamic import: ${statement}`);
        if (specifier.startsWith("node:")) continue;
        assert.ok(specifier.startsWith("."), `package import: ${statement}`);
        assert.ok(isJudgePath(resolve(dirname(path), specifier)), `import outside judge code: ${statement}`);
      }
    });
  }
});
