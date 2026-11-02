import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { asArray, asObject, asString, parseJson } from "../proofs/json.ts";
import { evaluateDryRuns } from "./deploy-dry-run.ts";
import type { CommandResult } from "./exec.ts";
import { affectedDeployables, assetPackages, workspaceDependencies, type WorkspacePackage } from "./workspace.ts";

// The workspace as `readWorkspace` read it at 91f4e7073, and the files real merged commits changed
// (`git show --name-only`), recorded 2026-11-02.
const DIR = new URL("./testdata/deploy/", import.meta.url);

function workspace(): WorkspacePackage[] {
  return asArray(parseJson(readFileSync(new URL("workspace-91f4e7073.json", DIR), "utf8")), "workspace").map((entry) => {
    const pkg = asObject(entry, "package");
    return {
      dir: asString(pkg.dir, "dir"),
      name: asString(pkg.name, "name"),
      workspaceDeps: asArray(pkg.workspaceDeps, "deps").map((name) => asString(name, "dep")),
      deployable: pkg.deployable === true,
      assetPackages: asArray(pkg.assetPackages, "assets").map((name) => asString(name, "asset")),
    };
  });
}

function changed(commit: string): string[] {
  return readFileSync(new URL(`files-${commit}.txt`, DIR), "utf8").split("\n").filter((line) => line !== "");
}

const ok: CommandResult = { ok: true, code: 0, seconds: 2, tail: "" };
const failed: CommandResult = { ok: false, code: 1, seconds: 3, tail: "✘ [ERROR] Could not resolve \"./chat-cards\"" };

describe("affectedDeployables", () => {
  const packages = workspace();
  const deployables = packages.filter((pkg) => pkg.deployable).map((pkg) => pkg.dir);

  it("reads 22 Workers, and the router serving workshop-frontend's build", () => {
    assert.equal(deployables.length, 22);
    assert.deepEqual(packages.find((pkg) => pkg.dir === "router")?.assetPackages, ["workshop-frontend"]);
  });

  it("#951 changes gatekeeper-google and a doc: only that Worker", () => {
    assert.deepEqual(affectedDeployables(packages, changed("91f4e7073")), ["gatekeeper-google"]);
  });

  it("a workshop-frontend change reaches the router through its assets", () => {
    assert.deepEqual(affectedDeployables(packages, changed("65922355a")), ["router"]);
  });

  it("a workshop-shared change reaches every Worker that depends on it", () => {
    const affected = affectedDeployables(packages, changed("6756bd6ca"));
    assert.ok(affected.includes("workshop-backend"));
    assert.ok(affected.includes("router"));
  });

  it("an eval-harness change reaches no Worker", () => {
    assert.deepEqual(affectedDeployables(packages, changed("298d0f177")), []);
  });

  it("a change to the root build scripts reaches every Worker", () => {
    assert.deepEqual(affectedDeployables(packages, changed("02bbac421")), deployables);
  });

  it("documentation and CI configuration reach no Worker", () => {
    assert.deepEqual(affectedDeployables(packages, ["docs/testing.md", ".github/workflows/ci.yml", "README.md"]), []);
  });
});

describe("workspace parsing", () => {
  it("keeps only workspace: specifiers", () => {
    assert.deepEqual(workspaceDependencies({
      dependencies: { "@gadgets/workshop-shared": "workspace:*", zod: "catalog:" },
      devDependencies: { "@gadgets/scripts": "workspace:^" },
    }), ["@gadgets/scripts", "@gadgets/workshop-shared"]);
  });

  it("follows assets.directory into another package only", () => {
    assert.deepEqual(assetPackages("router", { assets: { directory: "../workshop-frontend/dist" } }), ["workshop-frontend"]);
    assert.deepEqual(assetPackages("gatekeeper-x", { assets: { directory: "./public" } }), []);
  });
});

describe("evaluateDryRuns", () => {
  it("holds when the build and every dry run pass", () => {
    const outcome = evaluateDryRuns(ok, [{ package: "gatekeeper-google", result: ok }]);
    assert.equal(outcome.holds, true);
    assert.equal(outcome.status, "ok");
  });

  it("fails naming each package that did not bundle, with its output", () => {
    const outcome = evaluateDryRuns(ok, [{ package: "gatekeeper-google", result: failed }, { package: "router", result: ok }]);
    assert.equal(outcome.holds, false);
    assert.deepEqual(outcome.details.reasons, ["wrangler deploy --dry-run failed for gatekeeper-google (exit 1)"]);
    assert.equal(asObject(asObject(outcome.details.packages, "packages")["gatekeeper-google"], "google").tail, failed.tail);
  });

  it("fails when the workspace does not build", () => {
    const outcome = evaluateDryRuns(failed, []);
    assert.deepEqual(outcome.details.reasons, ["pnpm build exited 1"]);
  });
});
