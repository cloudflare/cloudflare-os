// Builds gatekeeper-google as it was at UPGRADE_BASE, for the suite that upgrades it in place to
// this tree's build (`__tests__/google-hooks-upgrade.test.ts`): the release a deployment runs
// before this one, whose Durable Object storage the new code has to take over.
//
// It checks the revision out into a temporary git worktree, installs that tree's dependencies
// from the store, and bundles the worker with `wrangler deploy --dry-run`, so the suite boots a
// self-contained bundle with nothing of the old tree left to resolve. The worktree goes once the
// bundle is out. The bundle depends on this file alone, which names the revision and every step,
// so a rerun with this file unchanged returns at once.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pnpmCommand } from "@gadgets/scripts/pnpm-command";

/**
 * main as it was before the hook delivery queue moved into gatekeeper-kit. Move it forward when the
 * next change to what the hook drivers store wants its upgrade tested, or once the Workshop no
 * longer serves a gatekeeper this old.
 */
export const UPGRADE_BASE = "d958d4786fefa7284fba582043dc7566ec2d2ece";

const SCRIPT = fileURLToPath(import.meta.url);
const PACKAGE_DIR = resolve(dirname(SCRIPT), "..");
const WORKSPACE_DIR = resolve(PACKAGE_DIR, "../..");

/** Where the bundle lands: `bundle/` holds the worker, beside the `wrangler.jsonc` it shipped with. */
export const UPGRADE_BASE_DIR = join(PACKAGE_DIR, ".wrangler/upgrade-base/gatekeeper-google");

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function pnpm(args: string[], cwd: string): void {
  const [command, argv] = pnpmCommand(args);
  run(command, argv, cwd);
}

export function buildUpgradeBase(): void {
  const marker = join(UPGRADE_BASE_DIR, "built-by");
  const builtBy = createHash("sha256").update(readFileSync(SCRIPT)).digest("hex");
  if (existsSync(marker) && readFileSync(marker, "utf8") === builtBy) return;
  // A shallow clone, as CI checks out, lacks the revision.
  try {
    execFileSync("git", ["cat-file", "-e", `${UPGRADE_BASE}^{commit}`], { cwd: WORKSPACE_DIR, stdio: "ignore" });
  } catch {
    run("git", ["fetch", "--depth=1", "origin", UPGRADE_BASE], WORKSPACE_DIR);
  }
  const tree = mkdtempSync(join(tmpdir(), "gadgets-upgrade-base-"));
  run("git", ["worktree", "add", "--detach", tree, UPGRADE_BASE], WORKSPACE_DIR);
  try {
    pnpm(["install", "--frozen-lockfile", "--prefer-offline", "--filter", "@gadgets/google-gatekeeper..."], tree);
    const gatekeeper = join(tree, "packages/gatekeeper-google");
    pnpm(["exec", "gadgets-build-configurator", "."], gatekeeper);
    rmSync(UPGRADE_BASE_DIR, { recursive: true, force: true });
    pnpm(["exec", "wrangler", "deploy", "--dry-run", "--outdir", join(UPGRADE_BASE_DIR, "bundle")], gatekeeper);
    copyFileSync(join(gatekeeper, "wrangler.jsonc"), join(UPGRADE_BASE_DIR, "wrangler.jsonc"));
    writeFileSync(marker, builtBy);
  } finally {
    run("git", ["worktree", "remove", "--force", tree], WORKSPACE_DIR);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) buildUpgradeBase();
