import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { asObject, parseJson, type Json } from "../proofs/json.ts";
import {
  deployedVersion, E2E_CONFIG, evaluateE2e, laterDeploy, previewRun, servedVersion, servingError, testEnvironment,
} from "./preview-e2e.ts";
import { fileResults, type TestRun } from "./vitest.ts";

// Real inputs: vitest JSON reports of the e2e suite against `pnpm dev-server` (all ten flows
// green; red with the phone menu button's label changed, so the three phone flows that open the
// menu fail; and a suite whose hook failed before any flow ran), the Actions API listings of
// preview.yml runs for #966's head 218afd5be and for its branch (four heads; 249e3f4fa's run
// started after 218afd5be's), the record smoke.ts wrote for #966's preview without the Access
// service token, and the 302 #966's preview gives `/api/version` without Access (recorded
// 2026-11-02 and 2026-11-03).
const DIR = new URL("./testdata/e2e/", import.meta.url);
const load = (name: string): Json => parseJson(readFileSync(new URL(name, DIR), "utf8"));
const run = (name: string): TestRun => ({
  config: E2E_CONFIG, files: [], results: fileResults(asObject(load(name), name), "/workspace/packages/workshop-frontend"),
  exitOk: name.includes("green"), seconds: 10, tail: "",
});

const PR966_HEAD = "218afd5bef73a888911dd07e5afdb4b27f62d5db";
const REPO = "cloudflare/cloudflare-os";
const BRANCH = "stop-agent-not-an-error";
const BRANCH_RUNS = load("preview-runs-branch-stop-agent-not-an-error.json");
const BACKEND = "8a1f3c2e-5b7d-4e19-9c0a-2f6d4b8e1a37";

/** #966's recorded smoke record, under the deploy record's name and as it would read with the service token set. */
function deployWith(version: string): Json {
  const record = asObject(load("smoke-pr966-no-token.json"), "record");
  return { ...record, name: "preview-deploy", status: "ok", holds: true, details: { ...asObject(record.details, "details"), backend_version: version } };
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

  it("errors when vitest exited non-zero though all ten flows passed", () => {
    const outcome = evaluateE2e({ ...run("dev-server-green.json"), exitOk: false }, {});
    assert.equal(outcome.status, "error");
    assert.equal(outcome.details.error, "vitest exited non-zero with no failing flow");
  });

  it("errors when the suite left no readable report", () => {
    assert.equal(evaluateE2e({ ...run("dev-server-green.json"), results: undefined }, {}).status, "error");
  });
});

describe("binding to the head's deploy", () => {
  it("reads the backend version the head's deploy recorded", () => {
    assert.deepEqual(deployedVersion(deployWith(BACKEND), PR966_HEAD), { version: BACKEND });
  });

  it("has no version from #966's real record, which ran without the service token", () => {
    const record = { ...asObject(load("smoke-pr966-no-token.json"), "record"), name: "preview-deploy" };
    assert.deepEqual(deployedVersion(record, PR966_HEAD), { error: "the head's deploy record has status error, so no version was recorded" });
  });

  it("has no version from another head's record, or from a record under another name", () => {
    assert.match(String(Object.values(deployedVersion(deployWith(BACKEND), "0".repeat(40)))), /is for 218afd5b/);
    assert.deepEqual(deployedVersion(load("smoke-pr966-no-token.json"), PR966_HEAD), { error: "the record is not a preview-deploy artifact" });
  });

  it("accepts the backend only while it serves the head's version", () => {
    assert.equal(servingError(BACKEND, BACKEND, "before"), undefined);
    assert.equal(servingError(BACKEND, "00000000-older-deploy", "after"), `after the flows, the backend served 00000000-older-deploy, not the head's ${BACKEND}`);
    assert.equal(servingError(BACKEND, undefined, "before"), "before the flows, GET /api/version named no version");
  });

  it("errors when a preview run for the branch started after the head's (#966: 249e3f4fa after 218afd5be)", () => {
    const head = previewRun(load("preview-runs-pr966-218afd5be.json"), PR966_HEAD, REPO);
    assert.equal(head.state, "done");
    const started = head.state === "done" ? head.started : 0;
    assert.equal(laterDeploy(BRANCH_RUNS, BRANCH, REPO, started, "after"),
      "after the flows, preview run(s) 41519319069 (249e3f4fa) started after the head's");
  });

  it("finds no later run for the branch's newest head", () => {
    assert.equal(laterDeploy(BRANCH_RUNS, BRANCH, REPO, Date.parse("2026-11-02T20:27:14Z"), "before"), undefined);
  });

  it("reads no version from #966's real Access redirect or a null version", () => {
    const redirect = asObject(load("api-version-pr966-unauthenticated.json"), "answer");
    assert.equal(servedVersion({ status: Number(redirect.status), body: "" }), undefined);
    assert.equal(servedVersion({ status: 200, body: '{"version":null}' }), undefined);
    assert.equal(servedVersion({ status: 200, body: JSON.stringify({ version: BACKEND }) }), BACKEND);
  });

  it("keeps the GitHub tokens out of the e2e suite's environment", () => {
    const env = testEnvironment({ GITHUB_TOKEN: "ghs_x", GH_TOKEN: "ghs_y", E2E_ACCESS_TOKEN: "jwt", PATH: "/usr/bin" }, "https://preview.example");
    assert.deepEqual(env, { E2E_ACCESS_TOKEN: "jwt", PATH: "/usr/bin", E2E_BASE_URL: "https://preview.example" });
  });
});

describe("previewRun", () => {
  it("finds #966's finished preview deploy for its head", () => {
    assert.deepEqual(previewRun(load("preview-runs-pr966-218afd5be.json"), PR966_HEAD, REPO), {
      state: "done", id: 41468082170, conclusion: "success", started: Date.parse("2026-11-02T15:05:03Z"),
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
