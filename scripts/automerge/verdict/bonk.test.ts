import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { dig, parseWorkflow } from "../../risk-review-fixtures/workflow.ts";
import { git } from "../git.ts";
import { createTestRepo } from "../test-repo.ts";
import { JOB_NAME, REVIEW_STEP, buildBonkVerdict, type BonkInputs } from "./bonk.ts";

const MODEL = "cloudflare-ai-gateway/openai/gpt-6.1-sol";

function inputs(overrides: Partial<BonkInputs>): BonkInputs {
  return { headSha: "h", baseSha: "b", reviewedSha: "h", round: 1, report: null, model: MODEL, ...overrides };
}

const CLEAN = "## Findings\n\nNone.\n\n## Summary\n\nNothing to fix.\nMERGE-CONFIDENCE: 9\n";

describe("buildBonkVerdict", () => {
  it("is an error when Bonk's report file is missing, empty or not in the report format", () => {
    for (const report of [null, "", "LGTM!\n", "## Findings\n\nNone.\n\n## Summary\n\nFine.\n"]) {
      const verdict = buildBonkVerdict(inputs({ report }));
      assert.equal(verdict.status, "error", String(report));
      assert.equal(verdict.merge_confidence, null);
      assert.ok(verdict.details.reason, "the verdict says why");
    }
  });

  // The pinned opencode runner checks out the pull request's branch by name, which a push during
  // the job moves past the head this artifact is bound to.
  it("is an error when the checkout Bonk reviewed is not the event's head", () => {
    const verdict = buildBonkVerdict(inputs({ report: CLEAN, reviewedSha: "newer" }));
    assert.equal(verdict.status, "error");
    assert.equal(verdict.head_sha, "h");
    assert.equal(verdict.merge_confidence, null);
    assert.match(verdict.details.reason ?? "", /newer/);
  });

  it("turns a clean review with no findings into an ok verdict", () => {
    const verdict = buildBonkVerdict(inputs({ report: CLEAN }));
    assert.equal(verdict.status, "ok");
    assert.equal(verdict.name, "bonk");
    assert.deepEqual(verdict.findings, []);
    assert.deepEqual(verdict.needs_person, []);
    assert.equal(verdict.merge_confidence, 9);
    assert.equal(verdict.review_from_sha, null);
    assert.equal(verdict.details.reason, null);
    assert.equal(verdict.model, MODEL);
  });

  it("keeps findings and NEEDS-A-PERSON lines from the report", () => {
    const verdict = buildBonkVerdict(inputs({ report:
      "## Findings\n\n### [P1] Lost write\n`src/a.ts:3`\nThe await is missing.\n\n## Summary\n\nNEEDS-A-PERSON: the API shape\nMERGE-CONFIDENCE: 3\n" }));
    assert.deepEqual(verdict.findings, [{ severity: "P1", title: "Lost write", path: "src/a.ts", line: 3 }]);
    assert.deepEqual(verdict.needs_person, ["the API shape"]);
  });

  it("carries the round limit from round 4, as the Opus runner does", () => {
    assert.deepEqual(buildBonkVerdict(inputs({ report: CLEAN, round: 3 })).needs_person, []);
    const limited = buildBonkVerdict(inputs({ report: CLEAN, round: 4 }));
    assert.equal(limited.status, "ok");
    assert.equal(limited.round, 4);
    assert.equal(limited.needs_person.length, 1);
    assert.equal(buildBonkVerdict(inputs({ report: CLEAN, round: 6 })).needs_person.length, 1);
  });
});

describe("bonk.ts prepare", () => {
  // Bonk reads its working tree, so an instruction file left there is one it follows.
  it("gives Bonk the judge commit's rules, in its prompt and in its checkout", () => {
    const origin = createTestRepo();
    const temp = mkdtempSync(join(tmpdir(), "bonk-prepare-"));
    try {
      const base = origin.commit({ "REVIEW.md": "base rules", "AGENTS.md": "base guide", "src/a.ts": "1\n" });
      const head = origin.commit({ "REVIEW.md": "head rules", "AGENTS.md": "head guide", "src/a.ts": "2\n" });
      origin.git("checkout", "-q", "-b", "merged-onto", base);
      const judge = origin.commit({ "REVIEW.md": "main rules", "AGENTS.md": "main guide", "src/a.ts": "1\n" });
      // The job's checkout: the head alone, at depth 1.
      const workspace = join(temp, "workspace");
      mkdirSync(workspace);
      git(["init", "-q"], workspace);
      git(["remote", "add", "origin", pathToFileURL(origin.dir).href], workspace);
      git(["fetch", "-q", "--no-tags", "--depth=1", "origin", head], workspace);
      git(["checkout", "-q", "--detach", "FETCH_HEAD"], workspace);
      const event = join(temp, "event.json");
      writeFileSync(event, JSON.stringify({
        pull_request: { number: 7, head: { sha: head, ref: "feature" }, base: { sha: base }, title: "Change a", body: null, draft: false },
      }));
      const output = join(temp, "output");
      execFileSync(process.execPath, [fileURLToPath(new URL("bonk.ts", import.meta.url)), "prepare"], {
        env: { ...process.env, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temp, GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output,
          AUTOMERGE_JUDGE_SHA: judge },
        stdio: "pipe",
      });
      const prompt = readFileSync(output, "utf8");
      assert.match(prompt, /main rules/);
      assert.doesNotMatch(prompt, /base rules|head rules/);
      assert.equal(readFileSync(join(workspace, "AGENTS.md"), "utf8"), "main guide");
    } finally {
      origin.remove();
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe("bonk-pr.yml", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const workflow = parseWorkflow(readFileSync(join(root, ".github/workflows/bonk-pr.yml"), "utf8"));

  // A head counts as a round only when this job's review step succeeded on it. Under another
  // name no head would count, and the round limit would never send a pull request to a person.
  it("has the job and the step Bonk's rounds are counted from", () => {
    const job = dig(workflow, "jobs", JOB_NAME);
    assert.equal(dig(job, "name") ?? JOB_NAME, JOB_NAME);
    const steps = dig(job, "steps");
    assert.ok(Array.isArray(steps) && steps.some((step) => dig(step, "name") === REVIEW_STEP));
  });
});
