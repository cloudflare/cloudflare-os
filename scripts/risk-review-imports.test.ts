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

/**
 * Ways to load code that an import statement does not show: `require` and `createRequire` (from the
 * allowed `node:module`), resolving a path with `import.meta.resolve`, and loading a native addon.
 */
const HIDDEN_LOADERS = /\bcreateRequire\b|\brequire\s*\(|\bimport\.meta\.resolve\b|\bprocess\.dlopen\b/;

/** Why `source` breaks the judge-code rule, or `undefined` when it keeps it. */
function importProblem(source: string, from: string): string | undefined {
  const hidden = HIDDEN_LOADERS.exec(source);
  if (hidden) return `loads code outside an import: ${hidden[0]}`;
  for (const { specifier, statement } of specifiers(source)) {
    if (specifier === undefined) return `non-literal dynamic import: ${statement}`;
    if (specifier.startsWith("node:")) continue;
    if (!specifier.startsWith(".")) return `package import: ${statement}`;
    if (!isJudgePath(resolve(dirname(from), specifier))) return `import outside judge code: ${statement}`;
  }
  return undefined;
}

describe("judge code imports", () => {
  const files = judgeFiles();

  it("finds the gate's modules", () => {
    assert.ok(files.some((path) => path.endsWith(join("scripts", "risk-review.ts"))));
  });

  for (const path of files) {
    it(`${relative(ROOT, path)} imports only node: builtins and judge modules`, () => {
      assert.equal(importProblem(readFileSync(path, "utf8"), path), undefined);
    });
  }

  it("rejects every way to load code an import statement does not show", () => {
    const from = join(ROOT, "scripts", "risk-review.ts");
    for (const source of [
      'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nload("zod");',
      'const zod = require("zod");',
      'const path = import.meta.resolve("zod");',
      'process.dlopen(module, "./addon.node");',
      'import { z } from "zod";',
      'const name = "zod";\nawait import(name);',
      'import { x } from "../packages/workshop-backend/src/user.ts";',
    ]) {
      assert.ok(importProblem(source, from), source);
    }
    assert.equal(importProblem('import { readFileSync } from "node:fs";\nimport { x } from "./risk-review-policy.ts";', from), undefined);
  });
});
