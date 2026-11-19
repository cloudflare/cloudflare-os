// Writes a gatekeeper package from the template to a scratch directory, for the workerd suite to
// load: what `pnpm create-gatekeeper` writes, without the configurator frame, which a build makes.

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scaffold, type ScaffoldOptions } from "../../src/scaffold.ts";

/**
 * Generates the package and returns its directory. It resolves its dependencies through this
 * package's `node_modules`, which lists what a generated gatekeeper depends on.
 */
export function generate(options: Omit<ScaffoldOptions, "name">): string {
  // Laid out as it would be in `packages/`, under the root tsconfig its own extends.
  const repo = join(import.meta.dirname, "..", "..", "..", "..");
  const root = mkdtempSync(join(tmpdir(), "create-gatekeeper-workerd-"));
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "packages", "gatekeeper-acme");
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(repo, "tsconfig.json"), join(root, "tsconfig.json"));
  // The packages its tsconfig names by path.
  for (const name of ["configurator-ui", "gatekeeper-kit", "workshop-shared"]) {
    symlinkSync(join(repo, "packages", name), join(root, "packages", name));
  }
  for (const [path, file] of scaffold({ name: "acme", ...options })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    if ("text" in file) writeFileSync(join(dir, path), file.text);
    else symlinkSync(file.symlink, join(dir, path));
  }
  mkdirSync(join(dir, "src", "generated"), { recursive: true });
  writeFileSync(join(dir, "src", "generated", "acme-configurator-ui.txt"), "<!DOCTYPE html>");
  symlinkSync(join(import.meta.dirname, "..", "..", "node_modules"), join(dir, "node_modules"));
  return dir;
}
