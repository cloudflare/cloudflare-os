import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { PRODUCERS, isProducerName, type Producer, type ProducerName } from "./automerge/producers.ts";
import {
  bindingError,
  modelProvider,
  newestRun,
  parseProducerArtifact,
  pickArtifact,
  readArtifactFile,
  type Artifact,
  type WorkflowRun,
} from "./risk-review-contract.ts";
import { BASE, HEAD, MODELS, proofJson, verdictJson, zip } from "./risk-review-fixtures/artifacts.ts";

const OTHER = "c".repeat(40);

const expected: { name: ProducerName; headSha: string; baseSha: string } = { name: "bonk", headSha: HEAD, baseSha: BASE };

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

  it("accepts an error verdict that names no model, since none ran", () => {
    const input = parseProducerArtifact(verdictJson({ status: "error", merge_confidence: null, model: "" }), expected);
    assert.ok("artifact" in input && input.artifact.kind === "verdict" && input.artifact.model === "", JSON.stringify(input));
  });

  it("accepts a proof with holds", () => {
    const input = parseProducerArtifact(proofJson("proof-deps", true), { name: "proof-deps", headSha: HEAD, baseSha: BASE });
    assert.ok("artifact" in input && input.artifact.kind === "proof" && input.artifact.holds);
  });

  it("treats every producer's artifact made for another head or base as absent", () => {
    for (const name of Object.keys(PRODUCERS).filter(isProducerName)) {
      const json = (overrides: Record<string, string>) =>
        PRODUCERS[name].kind === "verdict" ? verdictJson({ name, ...overrides }) : proofJson(name, true, overrides);
      const bound = { name, headSha: HEAD, baseSha: BASE };
      assert.ok("artifact" in parseProducerArtifact(json({}), bound), name);
      assert.ok("absent" in parseProducerArtifact(json({ head_sha: OTHER }), bound), `${name}: another head`);
      assert.ok("absent" in parseProducerArtifact(json({ base_sha: OTHER }), bound), `${name}: another base`);
    }
  });

  // Every one of these must count as absent, which sends the pull request to a person.
  const malformed: [string, string][] = [
    ["not JSON", "{"],
    ["not an object", "[]"],
    ["another schema", verdictJson({ schema: 2 })],
    ["another kind", verdictJson({ kind: "proof" })],
    ["another producer's name", verdictJson({ name: "opus" })],
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
    ["a missing model", verdictJson({ model: undefined })],
    ["a model that is not text", verdictJson({ model: { id: MODELS.bonk } })],
    ["a malformed review_from_sha", verdictJson({ review_from_sha: "HEAD~1" })],
  ];
  for (const [what, text] of malformed) {
    it(`treats ${what} as absent`, () => {
      assert.ok("absent" in parseProducerArtifact(text, expected));
    });
  }

  it("treats a proof without holds as absent", () => {
    const proof = proofJson("proof-tests", true, { holds: undefined });
    assert.ok("absent" in parseProducerArtifact(proof, { name: "proof-tests", headSha: HEAD, baseSha: BASE }));
  });
});

// A real `pull_request` run, recorded from the Actions API on 2026-11-03, and a producer that
// publishes from the workflow file it ran.
const recorded: WorkflowRun = JSON.parse(readFileSync(new URL("./risk-review-fixtures/evals-run.json", import.meta.url), "utf8"));
const producer: Producer = { kind: "proof", workflow: recorded.path };
const binding = {
  producer,
  headSha: recorded.head_sha,
  repository: "cloudflare/cloudflare-os",
  pullNumber: 976,
  defaultBranch: "main",
  headBranch: recorded.head_branch ?? "",
  notBefore: 0,
  siblingFence: undefined,
};

describe("bindingError", () => {
  it("binds a real pull_request run of the expected workflow on the head", () => {
    assert.equal(bindingError(recorded, binding), undefined);
  });

  it("rejects a run from another workflow file, head, repository or event", () => {
    assert.ok(bindingError(recorded, { ...binding, producer: PRODUCERS.opus }), "another workflow file");
    assert.ok(bindingError(recorded, { ...binding, headSha: HEAD }), "another head");
    assert.ok(bindingError({ ...recorded, head_repository: { full_name: "someone/cloudflare-os" } }, binding), "another repository");
    for (const event of ["pull_request_target", "push", "workflow_run"]) {
      assert.ok(bindingError({ ...recorded, event }, binding), event);
    }
  });

  it("rejects a run GitHub ties to another pull request, or to this head into another branch", () => {
    assert.ok(bindingError(recorded, { ...binding, pullNumber: 977 }));
    // Recorded: a real pull_request run of preview.yml, which GitHub ties to #965 into main.
    const preview: WorkflowRun = JSON.parse(readFileSync(new URL("./risk-review-fixtures/preview-run.json", import.meta.url), "utf8"));
    const onHead = { ...binding, producer: { ...producer, workflow: preview.path }, headSha: preview.head_sha, headBranch: preview.head_branch ?? "" };
    assert.equal(bindingError(preview, { ...onHead, pullNumber: 965 }), undefined);
    assert.ok(bindingError(preview, { ...onHead, pullNumber: 966 }));
    // The same run, as GitHub would report it for #965 retargeted to a branch with a replaced workflow.
    const elsewhere = { ...preview, pull_requests: preview.pull_requests.map((pull) => ({ ...pull, base: { ...pull.base, ref: "release" } })) };
    assert.ok(bindingError(elsewhere, { ...onHead, pullNumber: 965 }));
    assert.ok(bindingError({ ...recorded, pull_requests: [] }, binding));
  });

  it("rejects a run for another head branch, or created before the pull request's base last changed", () => {
    assert.ok(bindingError({ ...recorded, head_branch: "attacker/same-commit" }, binding));
    assert.ok(bindingError(recorded, { ...binding, notBefore: Date.parse(recorded.created_at) }));
    assert.equal(bindingError(recorded, { ...binding, notBefore: Date.parse(recorded.created_at) - 1 }), undefined);
    const fence = (at: number) => ({ ...binding, siblingFence: { at, reason: "#8 from the same branch targeted evil" } });
    assert.ok(bindingError(recorded, fence(Date.parse(recorded.created_at)))?.includes("#8"), "the error names the sibling");
    assert.equal(bindingError(recorded, fence(Date.parse(recorded.created_at) + 1)), undefined);
  });

  it("rejects an unfinished or unsuccessful latest attempt", () => {
    // Each of the two checks stands alone: a run that has not completed binds under no conclusion.
    for (const status of ["queued", "in_progress"]) {
      assert.ok(bindingError({ ...recorded, status, conclusion: null }, binding), status);
      assert.ok(bindingError({ ...recorded, status, conclusion: "success" }, binding), `${status}, concluded`);
    }
    for (const conclusion of ["failure", "cancelled", "timed_out", "skipped"]) {
      assert.ok(bindingError({ ...recorded, conclusion }, binding), conclusion);
    }
  });
});

describe("modelProvider", () => {
  it("reads the provider both reviewers' model ids name, whatever its case", () => {
    assert.equal(modelProvider(MODELS.bonk), "openai");
    assert.equal(modelProvider(MODELS.opus), "anthropic");
    assert.equal(modelProvider("cloudflare-ai-gateway/Anthropic/claude-opus-5.5"), "anthropic");
  });

  it("knows no provider when no model ran, for another gateway, or for an id that routes on to another provider", () => {
    for (const model of [
      "",
      "cloudflare-ai-gateway/",
      "cloudflare-ai-gateway/anthropic",
      "cloudflare-ai-gateway/anthropic/",
      "cloudflare-ai-gateway//claude-opus-5.5",
      "anthropic/claude-opus-5.5",
      "openrouter/anthropic/claude-opus-5.5",
      "cloudflare-ai-gateway/openrouter/anthropic/claude-opus-5.5",
      "cloudflare-ai-gateway/ /claude-opus-5.5",
      "cloudflare-ai-gateway/open ai/gpt-6.1-sol",
      "cloudflare-ai-gateway/anthropic/ ",
      " cloudflare-ai-gateway/anthropic/claude-opus-5.5",
    ]) {
      assert.equal(modelProvider(model), undefined, model);
    }
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
  return { id: 1, name: "automerge-verdict-bonk", size_in_bytes: 500, expired: false, created_at: "2026-11-02T16:00:00Z", ...overrides };
}

describe("pickArtifact", () => {
  const run = { ...recorded, run_started_at: "2026-11-02T15:30:00Z" };

  it("picks the newest artifact of the name made during the latest attempt", () => {
    assert.equal(pickArtifact([artifact({ id: 1 }), artifact({ id: 2, created_at: "2026-11-02T16:05:00Z" })], "automerge-verdict-bonk", run)?.id, 2);
  });

  it("ignores an earlier attempt's artifact, an expired one, another name and an oversized one", () => {
    assert.equal(pickArtifact([artifact({ created_at: "2026-11-02T15:00:00Z" })], "automerge-verdict-bonk", run), undefined);
    assert.equal(pickArtifact([artifact({ expired: true })], "automerge-verdict-bonk", run), undefined);
    assert.equal(pickArtifact([artifact({ name: "automerge-verdict-opus" })], "automerge-verdict-bonk", run), undefined);
    assert.equal(pickArtifact([artifact({ size_in_bytes: 2_000_000 })], "automerge-verdict-bonk", run), undefined);
  });
});

describe("readArtifactFile", () => {
  it("reads the one file in a deflated or stored archive", () => {
    assert.deepEqual(readArtifactFile(zip({ "automerge-verdict-bonk.json": verdictJson() }), "automerge-verdict-bonk.json"), { text: verdictJson() });
    assert.deepEqual(readArtifactFile(zip({ "automerge-verdict-bonk.json": "{}" }, 0), "automerge-verdict-bonk.json"), { text: "{}" });
  });

  it("rejects another file, several files, a file over the size limit, and bytes that are not an archive", () => {
    assert.ok("absent" in readArtifactFile(zip({ "verdict.json": "{}" }), "automerge-verdict-bonk.json"));
    assert.ok("absent" in readArtifactFile(zip({ "automerge-verdict-bonk.json": "{}", "extra.json": "{}" }), "automerge-verdict-bonk.json"));
    assert.ok("absent" in readArtifactFile(zip({ "automerge-verdict-bonk.json": " ".repeat(1_048_577) }, 0), "automerge-verdict-bonk.json"));
    assert.ok("absent" in readArtifactFile(new Uint8Array(Buffer.from("not a zip")), "automerge-verdict-bonk.json"));
  });
});
