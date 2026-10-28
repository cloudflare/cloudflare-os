// Builds gatekeepers as an earlier revision of the repo had them, for the suites that upgrade them in
// place to this tree's build: the release a deployment runs before this one, whose Durable Object
// storage the new code has to take over. gatekeeper-google for `__tests__/google-hooks-upgrade.test.ts`,
// gatekeeper-context for `__tests__/context-observer-upgrade.test.ts`.
//
// Each is checked out into a temporary git worktree of its revision, which installs that tree's
// dependencies from the store and bundles the worker with `wrangler deploy --dry-run`, so the suite
// boots a self-contained bundle with nothing of the old tree left to resolve. The worktree goes once
// the bundle is out. A bundle depends on this file alone, which names each revision and every step,
// so a rerun with this file unchanged returns at once.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pnpmCommand } from "@gadgets/scripts/pnpm-command";

const SCRIPT = fileURLToPath(import.meta.url);
const PACKAGE_DIR = resolve(dirname(SCRIPT), "..");
const WORKSPACE_DIR = resolve(PACKAGE_DIR, "../..");

type UpgradeBase = {
  revision: string;
  /** The gatekeeper's directory under `packages/`. */
  packageDir: string;
  packageName: string;
  /** Generates what bundling the gatekeeper reads but its own build step does not write. */
  prepare(gatekeeper: string): void;
};

const UPGRADE_BASES: UpgradeBase[] = [
  {
    // main as it was before the hook delivery queue moved into gatekeeper-kit. Move it forward when
    // the next change to what the hook drivers store wants its upgrade tested, or once the Workshop
    // no longer serves a gatekeeper this old.
    revision: "d958d4786fefa7284fba582043dc7566ec2d2ece",
    packageDir: "gatekeeper-google",
    packageName: "@gadgets/google-gatekeeper",
    prepare: gatekeeper => pnpm(["exec", "gadgets-build-configurator", "."], gatekeeper),
  },
  {
    // main as it was before the Context Library moved its observer tracking into the Workshop.
    revision: "fe3ce9fc3dbd93be7f41795b07384b404a90076e",
    packageDir: "gatekeeper-context",
    packageName: "@gadgets/gatekeeper-context",
    prepare: gatekeeper => {
      // The worker bundles typed-storage's build output.
      pnpm(["exec", "tsc", "-p", "../typed-storage"], gatekeeper);
      // The management app is only embedded, and no suite renders the old release's.
      mkdirSync(join(gatekeeper, "src/generated"), { recursive: true });
      writeFileSync(join(gatekeeper, "src/generated/app.txt"), "<!doctype html><title>Skills</title>");
    },
  },
];

/** Where a gatekeeper's base lands: `bundle/` holds the worker, beside the `wrangler.jsonc` it shipped with. */
export function upgradeBaseDir(packageDir: string): string {
  return join(PACKAGE_DIR, ".wrangler/upgrade-base", packageDir);
}

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function pnpm(args: string[], cwd: string): void {
  const [command, argv] = pnpmCommand(args);
  run(command, argv, cwd);
}

function buildBase({ revision, packageDir, packageName, prepare }: UpgradeBase, builtBy: string): void {
  const out = upgradeBaseDir(packageDir);
  const marker = join(out, "built-by");
  if (existsSync(marker) && readFileSync(marker, "utf8") === builtBy) return;
  // A shallow clone, as CI checks out, lacks the revision.
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], { cwd: WORKSPACE_DIR, stdio: "ignore" });
  } catch {
    run("git", ["fetch", "--depth=1", "origin", revision], WORKSPACE_DIR);
  }
  const tree = mkdtempSync(join(tmpdir(), "gadgets-upgrade-base-"));
  run("git", ["worktree", "add", "--detach", tree, revision], WORKSPACE_DIR);
  try {
    pnpm(["install", "--frozen-lockfile", "--prefer-offline", "--filter", `${packageName}...`], tree);
    const gatekeeper = join(tree, "packages", packageDir);
    prepare(gatekeeper);
    rmSync(out, { recursive: true, force: true });
    pnpm(["exec", "wrangler", "deploy", "--dry-run", "--outdir", join(out, "bundle")], gatekeeper);
    copyFileSync(join(gatekeeper, "wrangler.jsonc"), join(out, "wrangler.jsonc"));
    writeFileSync(marker, builtBy);
  } finally {
    run("git", ["worktree", "remove", "--force", tree], WORKSPACE_DIR);
  }
}

export function buildUpgradeBases(): void {
  const builtBy = createHash("sha256").update(readFileSync(SCRIPT)).digest("hex");
  for (const base of UPGRADE_BASES) buildBase(base, builtBy);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) buildUpgradeBases();
