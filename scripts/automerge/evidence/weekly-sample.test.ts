import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { asObject, parseJson } from "../proofs/json.ts";
import { decisionFromSummary, issueFor, rung3Closed, rung3Decision, sample, type AutoMerged } from "./weekly-sample.ts";

// The bands file the gate ships (cloudflare-os-am-gate b80a51a5e), every band closed.
const SHIPPED = readFileSync(new URL("./testdata/weekly/automerge-bands.gate.json", import.meta.url), "utf8");

function opened(area: string, mode = "enforce"): string {
  const bands = asObject(parseJson(SHIPPED), "bands");
  bands.mode = mode;
  asObject(asObject(asObject(bands.areas, "areas")[area], area).low, "low").open = true;
  return JSON.stringify(bands);
}

const record = {
  schema: 1, mode: "enforce", event: "pull_request_review", sha: "a".repeat(40), policy_sha: "b".repeat(40),
  conclusion: "success", reason: "the gate's rule holds",
  pulls: [{ number: 932, head_sha: "a".repeat(40), base_sha: "b".repeat(40), band: "low", area: "kernel-small",
    approvers: [], gate: { passes: true, reason: "the gate's rule holds" },
    would: { decision: "auto", area: "kernel-small", reasons: [] } }],
};

describe("rung3Closed", () => {
  it("is closed without a bands file, which is main today", () => {
    assert.equal(rung3Closed(undefined), ".github/automerge-bands.json is missing");
  });

  it("is closed with the bands file the gate ships", () => {
    assert.equal(rung3Closed(SHIPPED), 'mode is "shadow", not enforce');
  });

  it("is closed when only rung 2 opens, or rung 3 opens in shadow mode", () => {
    assert.equal(rung3Closed(opened("scored")), "no rung 3 band is open");
    assert.equal(rung3Closed(opened("kernel-small", "shadow")), 'mode is "shadow", not enforce');
  });

  it("is open when a rung 3 band opens in enforce mode", () => {
    assert.equal(rung3Closed(opened("kernel-small")), undefined);
  });

  it("is closed on a file that is not JSON", () => {
    assert.equal(rung3Closed("{"), ".github/automerge-bands.json is not JSON");
  });
});

describe("decisions", () => {
  it("reads the decision JSON at the head of a summary", () => {
    // The summary in the shape the gate's renderOutput writes: the decision JSON fenced first.
    const parsed = decisionFromSummary("```json\n" + JSON.stringify(record) + "\n```\n\n**enforce**: the gate's rule holds");
    assert.ok(parsed);
    assert.deepEqual(rung3Decision(parsed, 932), { area: "kernel-small", band: "low" });
  });

  it("ignores another pull request, shadow mode, a person decision and rung 2", () => {
    const parsed = asObject(parseJson(JSON.stringify(record)), "record");
    assert.equal(rung3Decision(parsed, 933), undefined);
    assert.equal(rung3Decision({ ...parsed, mode: "shadow" }, 932), undefined);
    const pull = { ...record.pulls[0], would: { decision: "person", area: null, reasons: ["low score"] } };
    assert.equal(rung3Decision(asObject(parseJson(JSON.stringify({ ...record, pulls: [pull] })), "r"), 932), undefined);
    const scored = { ...record.pulls[0], would: { decision: "auto", area: "scored", reasons: [] } };
    assert.equal(rung3Decision(asObject(parseJson(JSON.stringify({ ...record, pulls: [scored] })), "r"), 932), undefined);
  });

  it("reads nothing from a summary without the fenced JSON", () => {
    assert.equal(decisionFromSummary("The gate could not decide: boom"), undefined);
  });
});

describe("sample", () => {
  const pulls: AutoMerged[] = [900, 901, 902, 903, 904, 905, 906, 907].map((number) => ({
    number, title: `PR ${number}`, url: `https://github.com/cloudflare/cloudflare-os/pull/${number}`, area: "kernel-small", band: "low",
  }));

  it("picks the same five for a rerun in the same week, in number order", () => {
    const first = sample(pulls, "2026-11-02");
    assert.equal(first.length, 5);
    assert.deepEqual(sample(pulls.toReversed(), "2026-11-02"), first);
    assert.deepEqual(first.map((pull) => pull.number), first.map((pull) => pull.number).toSorted((a, b) => a - b));
  });
  it("files one issue listing the sample", () => {
    const issue = issueFor("2026-10-26", "2026-11-02", pulls, pulls.slice(0, 2), []);
    assert.equal(issue.title, "Rung 3 weekly sample: 2026-10-26 to 2026-11-02");
    assert.match(issue.body, /^8 pull request\(s\) merged/);
    assert.match(issue.body, /- \[ \] #900 PR 900 \(kernel-small, low\)/);
    assert.doesNotMatch(issue.body, /No readable risk-review decision/);
  });

  it("lists merges with no readable decision instead of counting them as not auto-merged", () => {
    const issue = issueFor("2026-10-26", "2026-11-02", [], [], [951, 966]);
    assert.match(issue.body, /No readable risk-review decision, so whether a person approved is unknown: #951, #966\./);
  });
});
