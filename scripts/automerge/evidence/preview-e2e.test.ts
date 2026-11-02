import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { asObject, parseJson, type Json } from "../proofs/json.ts";
import { E2E_CONFIG, evaluateE2e, previewRun } from "./preview-e2e.ts";
import { summarizeReport } from "./vitest.ts";

// Real inputs recorded 2026-11-02: vitest JSON reports of the e2e suite against `pnpm dev-server`
// (all ten flows green; red with the phone menu button's label changed, so the three phone flows
// that open the menu fail; and a suite that never started its flows), and the Actions API listing
// of preview.yml runs for #966's head 218afd5be.
const DIR = new URL("./testdata/e2e/", import.meta.url);
const load = (name: string): Json => parseJson(readFileSync(new URL(name, DIR), "utf8"));
const run = (name: string, exitOk: boolean) => summarizeReport(E2E_CONFIG, [], asObject(load(name), name), exitOk, 10, "");

const PR966_HEAD = "218afd5bef73a888911dd07e5afdb4b27f62d5db";
const REPO = "cloudflare/cloudflare-os";

describe("evaluateE2e", () => {
  it("holds when all ten flows pass", () => {
    assert.equal(evaluateE2e(run("dev-server-green.json", true), {}).holds, true);
  });

  it("does not hold when phone flows fail", () => {
    const outcome = evaluateE2e(run("dev-server-red.json", false), {});
    assert.equal(outcome.holds, false);
    assert.deepEqual(asObject(outcome.details.run, "run").failures, [
      "Workshop on a phone opens Workspaces from the navigation",
      "Workshop on a phone opens Profile from the profile menu",
      "Workshop on a phone drafts a message on Home",
    ]);
  });

  it("does not hold when the suite failed before any flow ran", () => {
    const outcome = evaluateE2e(run("dev-server-suite-error.json", false), {});
    assert.deepEqual(outcome.details.reasons, ["0 flow(s) failed and 3 suite(s) failed"]);
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
