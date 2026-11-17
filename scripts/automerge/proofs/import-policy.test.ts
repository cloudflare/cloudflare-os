import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Trust model rule 4: judge code has no head dependencies. A proof script may import only Node
// builtins and other files under scripts/automerge/, so what decides a pull request is the reviewed
// source in this directory and never a package the pull request can bump.
const PROOFS = dirname(fileURLToPath(import.meta.url));
const AUTOMERGE = resolve(PROOFS, "..");
const SPECIFIER = /(?:^|[\s;])(?:import|export)\s(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

describe("automerge judge imports", () => {
  const files = readdirSync(PROOFS).filter((name) => name.endsWith(".ts")).map((name) => join(PROOFS, name));

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
