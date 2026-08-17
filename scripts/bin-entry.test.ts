import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { resolveBinEntry } from "./bin-entry.ts";

// A fresh temp directory per run: `node --test` runs files in parallel, and anything written inside
// the repo would land in `run-local`'s source hash. Torn down even when a test fails. Realpathed
// because resolveBinEntry is, and on macOS `tmpdir()` is a symlink (/var -> /private/var).
const root = realpathSync(mkdtempSync(join(tmpdir(), "bin-entry-")));
after(() => rmSync(root, { recursive: true, force: true }));

let caseCount = 0;

// A package directory holding `node_modules/<name>` with the given manifest, plus each named entry
// file. `entries` is separate from `bin` so a manifest can point at a file that is not there.
function pkgWith(name: string, bin: unknown, entries: string[]): string {
  const pkgDir = join(root, `case-${++caseCount}`);
  const installed = join(pkgDir, "node_modules", name);
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name, bin }));
  for (const entry of entries) {
    const file = join(installed, entry);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
  return pkgDir;
}

describe("resolveBinEntry", () => {
  it("resolves a string `bin` to an absolute entry path", () => {
    const pkgDir = pkgWith("vite", "bin/vite.js", ["bin/vite.js"]);
    assert.equal(
        resolveBinEntry(pkgDir, "vite"),
        join(pkgDir, "node_modules", "vite", "bin", "vite.js"));
  });

  it("resolves the matching key of an object `bin`", () => {
    const pkgDir = pkgWith("wrangler", { wrangler: "./main.js", other: "./other.js" }, ["main.js"]);
    assert.equal(
        resolveBinEntry(pkgDir, "wrangler"),
        join(pkgDir, "node_modules", "wrangler", "main.js"));
  });

  // The case that broke the `shell: true` attempt at this bug: a checkout under a path with a space
  // is re-split by the shell, so the entry has to reach the caller as one intact argv element.
  it("resolves from a package directory whose path contains a space", () => {
    const spaced = join(root, "cf os", "repo");
    const installed = join(spaced, "node_modules", "vite");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "vite", bin: "./cli.js" }));
    writeFileSync(join(installed, "cli.js"), "");
    assert.equal(resolveBinEntry(spaced, "vite"), join(installed, "cli.js"));
  });

  // Callers treat null as "leave the command as written", so a wrong guess must never be returned.
  it("returns null when the bin cannot be resolved to a file that exists", () => {
    assert.equal(resolveBinEntry(join(root, "nonexistent"), "vite"), null);
    assert.equal(
        resolveBinEntry(pkgWith("vite", { other: "./other.js" }, ["other.js"]), "vite"), null);
    assert.equal(resolveBinEntry(pkgWith("vite", undefined, []), "vite"), null);
    assert.equal(resolveBinEntry(pkgWith("vite", "./missing.js", []), "vite"), null);
  });
});
