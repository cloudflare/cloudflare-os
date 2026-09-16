import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

// Every `deploy` script in the workspace, so a new package is covered without being listed here.
const deployScripts = readdirSync("packages", { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .flatMap(entry => {
    const manifestPath = join("packages", entry.name, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      return []; // no package.json, or unreadable -- not a workspace package
    }
    const command = manifest.scripts?.deploy;
    return command ? [{ name: manifest.name, path: manifestPath, command }] : [];
  });

/**
 * Two invariants on the deploy path, both of which have been violated in the recent past.
 *
 * Neither is enforceable by types or by review alone: the failure is silent in both directions --
 * a deploy that replays a stale artifact, or one that bakes the wrong build-time flag, still exits
 * zero and still deploys.
 *
 * Both are conditional on the command mentioning vp or a builder, so neither fires on a `deploy`
 * that runs no codegen whatsoever. build-gatekeeper-configurator.test.ts requires that positively,
 * for the packages where it is a requirement.
 */
describe("deploy scripts", () => {
  it("covers the packages that deploy", () => {
    assert.ok(deployScripts.length > 0, "expected at least one deploy script to check");
  });

  // A cache hit is only as correct as the fingerprint is complete, and every bug here has been a
  // fingerprint missing an input: an env var the task never declared, a directory outside the
  // workspace that tracking cannot see. That is cheap to absorb on a build you can re-run and
  // expensive on a deploy you cannot, so deploys rebuild from source. The codegen costs seconds.
  it("never lets a deploy replay a cached artifact", () => {
    for (const { name, path, command } of deployScripts) {
      if (!command.includes("vp run")) continue;
      assert.ok(
        command.includes("--no-cache"),
        `${name} (${path}) runs a vp task while deploying without --no-cache: ${command}\n` +
          "Deploys must not replay a cached artifact -- add --no-cache.");
    }
  });

  // The codegen command belongs to the task that declares its env. A deploy script calling the
  // builder itself is how `VITE_FRONTEND_ERROR_REPORTING` got dropped from `build`: the script
  // shadows the declaration, and under vp the variable is stripped and the wrong value ships.
  it("reaches codegen through its task rather than invoking the builder", () => {
    for (const { name, path, command } of deployScripts) {
      for (const builder of ["build-gatekeeper-configurator.ts", "build-app.mjs"]) {
        assert.ok(
          !command.includes(builder),
          `${name} (${path}) invokes ${builder} directly while deploying: ${command}\n` +
            "Run the task that declares its env instead (vp run --no-cache <task>).");
      }
    }
  });
});
