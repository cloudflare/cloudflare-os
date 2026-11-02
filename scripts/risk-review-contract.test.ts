import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  PRODUCERS,
  bindingError,
  newestRun,
  parseProducerArtifact,
  pickArtifact,
  readArtifactFile,
  type Artifact,
  type ProducerName,
  type WorkflowRun,
} from "./risk-review-contract.ts";
import { BASE, HEAD, verdictJson, zip } from "./risk-review-fixtures/artifacts.ts";

const OTHER = "c".repeat(40);

const expected: { name: ProducerName; headSha: string; baseSha: string } = { name: "sol", headSha: HEAD, baseSha: BASE };

describe("parseProducerArtifact", () => {
  it("accepts a well-formed verdict for this head and base", () => {
    const input = parseProducerArtifact(verdictJson(), expected);
    assert.ok("artifact" in input, JSON.stringify(input));
    assert.equal(input.artifact.kind, "verdict");
  });

  it("accepts a round-limit verdict with no score and a finding with no location", () => {
    const input = parseProducerArtifact(verdictJson({
      merge_confidence: null,
      needs_person: ["round limit"],
      findings: [{ severity: "P3", title: "Nit", path: null, line: null }],
      round: 4,
    }), expected);
    assert.ok("artifact" in input, JSON.stringify(input));
  });

  it("accepts a proof with holds", () => {
    const proof = JSON.stringify({ schema: 1, kind: "proof", name: "proof-deps", head_sha: HEAD, base_sha: BASE, status: "ok", holds: true, details: {} });
    const input = parseProducerArtifact(proof, { name: "proof-deps", headSha: HEAD, baseSha: BASE });
    assert.ok("artifact" in input && input.artifact.kind === "proof" && input.artifact.holds);
  });

  // Every one of these must count as absent, which sends the pull request to a person.
  const malformed: [string, string][] = [
    ["not JSON", "{"],
    ["not an object", "[]"],
    ["another schema", verdictJson({ schema: 2 })],
    ["another kind", verdictJson({ kind: "proof" })],
    ["another producer's name", verdictJson({ name: "opus" })],
    ["another head", verdictJson({ head_sha: OTHER })],
    ["another base", verdictJson({ base_sha: OTHER })],
    ["a short head", verdictJson({ head_sha: "abc" })],
    ["an unknown status", verdictJson({ status: "pass" })],
    ["a score above 10", verdictJson({ merge_confidence: 11 })],
    ["a fractional score", verdictJson({ merge_confidence: 7.5 })],
    ["a score as text", verdictJson({ merge_confidence: "8" })],
    ["a missing score", verdictJson({ merge_confidence: undefined })],
    ["an untagged finding", verdictJson({ findings: [{ title: "x", path: null, line: null }] })],
    ["an unknown severity", verdictJson({ findings: [{ severity: "P4", title: "x", path: null, line: null }] })],
    ["needs_person not a list", verdictJson({ needs_person: "round limit" })],
    ["round zero", verdictJson({ round: 0 })],
    ["a missing fingerprint", verdictJson({ fingerprint: undefined })],
    ["a partial fingerprint", verdictJson({ fingerprint: { model: "m" } })],
    ["a malformed review_from_sha", verdictJson({ review_from_sha: "HEAD~1" })],
  ];
  for (const [what, text] of malformed) {
    it(`treats ${what} as absent`, () => {
      assert.ok("absent" in parseProducerArtifact(text, expected));
    });
  }

  it("treats a proof without holds as absent", () => {
    const proof = JSON.stringify({ schema: 1, kind: "proof", name: "proof-tests", head_sha: HEAD, base_sha: BASE, status: "ok", details: {} });
    assert.ok("absent" in parseProducerArtifact(proof, { name: "proof-tests", headSha: HEAD, baseSha: BASE }));
  });
});

// A real `pull_request` run of preview.yml, recorded from the Actions API on 2026-11-02.
const recorded: WorkflowRun = JSON.parse(readFileSync(new URL("./risk-review-fixtures/producer-run.json", import.meta.url), "utf8"));
const binding = {
  producer: PRODUCERS["preview-smoke"],
  headSha: recorded.head_sha,
  repository: "cloudflare/cloudflare-os",
  defaultBranch: "main",
};

describe("bindingError", () => {
  it("binds a real pull_request run of the expected workflow on the head", () => {
    assert.equal(bindingError(recorded, binding), undefined);
  });

  it("rejects a run from another workflow file, head, repository or event", () => {
    assert.match(bindingError(recorded, { ...binding, producer: PRODUCERS.sol }) ?? "", /not \.github\/workflows\/review-verdict\.yml/);
    assert.match(bindingError(recorded, { ...binding, headSha: HEAD }) ?? "", /another head/);
    assert.match(bindingError({ ...recorded, head_repository: { full_name: "someone/cloudflare-os" } }, binding) ?? "", /another repository/);
    assert.match(bindingError({ ...recorded, event: "pull_request_target" }, binding) ?? "", /pull_request_target/);
    assert.match(bindingError({ ...recorded, event: "push" }, binding) ?? "", /push/);
  });

  it("rejects an unfinished or unsuccessful latest attempt", () => {
    assert.match(bindingError({ ...recorded, status: "in_progress", conclusion: null }, binding) ?? "", /still running/);
    for (const conclusion of ["failure", "cancelled", "timed_out", "skipped"]) {
      assert.match(bindingError({ ...recorded, conclusion }, binding) ?? "", new RegExp(conclusion));
    }
  });

  it("accepts a workflow_run run on the default branch only for a producer that allows it", () => {
    const onMain = { ...recorded, event: "workflow_run", head_branch: "main", head_sha: OTHER };
    assert.equal(bindingError(onMain, binding), undefined);
    assert.match(bindingError({ ...onMain, head_branch: "topic" }, binding) ?? "", /not main/);
    const verdicts = { ...binding, producer: PRODUCERS.sol };
    assert.match(bindingError({ ...onMain, path: PRODUCERS.sol.workflow }, verdicts) ?? "", /workflow_run/);
  });
});

describe("newestRun", () => {
  it("lets a re-run of an older run beat a newer run's success", () => {
    const older = { ...recorded, id: 1, created_at: "2026-11-02T10:00:00Z", run_started_at: "2026-11-02T12:00:00Z", conclusion: "failure" };
    const newer = { ...recorded, id: 2, created_at: "2026-11-02T11:00:00Z", run_started_at: "2026-11-02T11:00:00Z", conclusion: "success" };
    assert.equal(newestRun([newer, older])?.id, 1);
  });

  it("lets a newer failed run beat an older success", () => {
    const older = { ...recorded, id: 1, created_at: "2026-11-02T15:00:00Z", conclusion: "success" };
    const newer = { ...recorded, id: 2, created_at: "2026-11-02T16:00:00Z", conclusion: "failure" };
    const picked = newestRun([older, newer]);
    assert.equal(picked?.id, 2);
    assert.ok(picked && bindingError(picked, binding));
  });
});

function artifact(overrides: Partial<Artifact>): Artifact {
  return { id: 1, name: "automerge-sol", size_in_bytes: 500, expired: false, created_at: "2026-11-02T16:00:00Z", ...overrides };
}

describe("pickArtifact", () => {
  const run = { ...recorded, run_started_at: "2026-11-02T15:30:00Z" };

  it("picks the newest artifact of the name made during the latest attempt", () => {
    assert.equal(pickArtifact([artifact({ id: 1 }), artifact({ id: 2, created_at: "2026-11-02T16:05:00Z" })], "automerge-sol", run)?.id, 2);
  });

  it("ignores an earlier attempt's artifact, an expired one, another name and an oversized one", () => {
    assert.equal(pickArtifact([artifact({ created_at: "2026-11-02T15:00:00Z" })], "automerge-sol", run), undefined);
    assert.equal(pickArtifact([artifact({ expired: true })], "automerge-sol", run), undefined);
    assert.equal(pickArtifact([artifact({ name: "automerge-opus" })], "automerge-sol", run), undefined);
    assert.equal(pickArtifact([artifact({ size_in_bytes: 2_000_000 })], "automerge-sol", run), undefined);
  });
});

describe("readArtifactFile", () => {
  it("reads the one file in a deflated or stored archive", () => {
    assert.deepEqual(readArtifactFile(zip({ "automerge-sol.json": verdictJson() }), "automerge-sol.json"), { text: verdictJson() });
    assert.deepEqual(readArtifactFile(zip({ "automerge-sol.json": "{}" }, 0), "automerge-sol.json"), { text: "{}" });
  });

  it("rejects another file, several files, and bytes that are not an archive", () => {
    assert.ok("absent" in readArtifactFile(zip({ "verdict.json": "{}" }), "automerge-sol.json"));
    assert.ok("absent" in readArtifactFile(zip({ "automerge-sol.json": "{}", "extra.json": "{}" }), "automerge-sol.json"));
    assert.ok("absent" in readArtifactFile(new Uint8Array(Buffer.from("not a zip")), "automerge-sol.json"));
  });
});
