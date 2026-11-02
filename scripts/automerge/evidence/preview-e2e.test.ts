import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { asObject, parseJson, type Json } from "../proofs/json.ts";
import { deployedVersion, E2E_CONFIG, evaluateE2e, previewRun, servingError, type VersionAnswer } from "./preview-e2e.ts";
import { fileResults, type TestRun } from "./vitest.ts";

// Real inputs: vitest JSON reports of the e2e suite against `pnpm dev-server` (all ten flows
// green; red with the phone menu button's label changed, so the three phone flows that open the
// menu fail; and a suite whose hook failed before any flow ran), the Actions API listing of
// preview.yml runs for #966's head 218afd5be, the smoke artifact smoke.ts wrote for #966's preview
// without the Access service token, and the 302 #966's preview gives `/api/version` without Access
// (recorded 2026-11-02 and 2026-11-03).
const DIR = new URL("./testdata/e2e/", import.meta.url);
const load = (name: string): Json => parseJson(readFileSync(new URL(name, DIR), "utf8"));
const run = (name: string): TestRun => ({
  config: E2E_CONFIG, files: [], results: fileResults(asObject(load(name), name), "/workspace/packages/workshop-frontend"),
  exitOk: name.includes("green"), seconds: 10, tail: "",
});

const PR966_HEAD = "218afd5bef73a888911dd07e5afdb4b27f62d5db";
const REPO = "cloudflare/cloudflare-os";
const VERSION = "8a1f3c2e-5b7d-4e19-9c0a-2f6d4b8e1a37";
const ok = (version: string): VersionAnswer => ({ status: 200, body: JSON.stringify({ version }) });

/** #966's recorded smoke artifact as it would read had the service token been set. */
function smokeWith(version: string): Json {
  const smoke = asObject(load("smoke-pr966-no-token.json"), "smoke");
  return { ...smoke, status: "ok", holds: true, details: { ...asObject(smoke.details, "details"), backend_version: version } };
}

describe("evaluateE2e", () => {
  it("holds when all ten flows pass", () => {
    assert.equal(evaluateE2e(run("dev-server-green.json"), {}).holds, true);
  });

  it("does not hold when phone flows fail", () => {
    const outcome = evaluateE2e(run("dev-server-red.json"), {});
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.holds, false);
    assert.match(String(outcome.details.reasons), /^3 flow\(s\) failed: Workshop on a phone opens Workspaces/);
  });

  it("errors when the suite failed before any flow ran, instead of failing", () => {
    const outcome = evaluateE2e(run("dev-server-suite-error.json"), {});
    assert.equal(outcome.status, "error");
    assert.match(String(outcome.details.error), /^ran 0 of 10 flows; e2e\/workshop\.e2e\.ts did not finish/);
  });

  it("errors when the suite left no readable report", () => {
    assert.equal(evaluateE2e({ ...run("dev-server-green.json"), results: undefined }, {}).status, "error");
  });
});

describe("binding to the head's deploy", () => {
  it("reads the version the head's smoke recorded", () => {
    assert.deepEqual(deployedVersion(smokeWith(VERSION), PR966_HEAD), { version: VERSION });
  });

  it("has no version from #966's real smoke, which ran without the service token", () => {
    assert.deepEqual(deployedVersion(load("smoke-pr966-no-token.json"), PR966_HEAD), {
      error: "the head's smoke has status error, so no version was recorded",
    });
  });

  it("has no version from another head's smoke", () => {
    assert.match(String(Object.values(deployedVersion(smokeWith(VERSION), "0".repeat(40)))), /is for 218afd5b/);
  });

  it("accepts the URL only while it serves the head's version", () => {
    assert.equal(servingError(VERSION, ok(VERSION), "before"), undefined);
    assert.match(String(servingError(VERSION, ok("00000000-older-deploy"), "after")), /served backend version 00000000-older-deploy/);
  });

  it("errors on #966's real Access redirect and on a null version", () => {
    const redirect = asObject(load("api-version-pr966-unauthenticated.json"), "answer");
    assert.match(String(servingError(VERSION, { status: Number(redirect.status), body: "" }, "before")), /answered 302 with no version/);
    assert.match(String(servingError(VERSION, { status: 200, body: '{"version":null}' }, "before")), /answered 200 with no version/);
  });
});

describe("previewRun", () => {
  it("finds #966's finished preview deploy for its head", () => {
    assert.deepEqual(previewRun(load("preview-runs-pr966-218afd5be.json"), PR966_HEAD, REPO), {
      state: "done", id: 41468082170, conclusion: "success",
    });
  });

  it("finds nothing for another head or another repository", () => {
    assert.deepEqual(previewRun(load("preview-runs-pr966-218afd5be.json"), "0".repeat(40), REPO), { state: "absent" });
    assert.deepEqual(previewRun(load("preview-runs-pr966-218afd5be.json"), PR966_HEAD, "someone/fork"), { state: "absent" });
  });

  it("waits while the newest attempt is still running", () => {
    const listing = asObject(load("preview-runs-pr966-218afd5be.json"), "listing");
    const [recorded] = Array.isArray(listing.workflow_runs) ? listing.workflow_runs : [];
    const rerun = { ...asObject(recorded, "run"), status: "in_progress", conclusion: null, run_started_at: "2026-11-02T16:00:00Z" };
    assert.deepEqual(previewRun({ workflow_runs: [recorded, rerun] }, PR966_HEAD, REPO), { state: "pending" });
  });
});
