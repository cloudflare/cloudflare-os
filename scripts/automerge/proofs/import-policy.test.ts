import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Trust model rule 4: judge code has no head dependencies. A proof or evidence script may import
// only Node builtins and other files under scripts/automerge/, so what decides a pull request is
// the reviewed source in this directory and never a package the pull request can bump.
const AUTOMERGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNED = ["proofs", "evidence"];
const SPECIFIER = /(?:^|[\s;])(?:import|export)\s(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "testdata" ? [] : sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("automerge judge imports", () => {
  const files = OWNED.flatMap((name) => {
    try {
      return sources(join(AUTOMERGE, name));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  });

  it("finds the proof scripts", () => {
    assert.ok(files.some((file) => file.endsWith("deps.ts")));
  });

  for (const file of files) {
    it(`${relative(AUTOMERGE, file)} imports only node: builtins and scripts/automerge/`, () => {
      const offenders = [...readFileSync(file, "utf8").matchAll(SPECIFIER)]
        .map((match) => match[1] ?? match[2])
        .filter((specifier) => {
          if (specifier.startsWith("node:")) return false;
          if (!specifier.startsWith(".")) return true;
          return relative(AUTOMERGE, resolve(dirname(file), specifier)).startsWith("..");
        });
      assert.deepEqual(offenders, []);
    });
  }
});
