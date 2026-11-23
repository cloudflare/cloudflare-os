import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { parseWorkflow, stepsOf } from "../../risk-review-fixtures/workflow.ts";
import { git } from "../git.ts";
import { buildBonkVerdict, type BonkInputs } from "./bonk.ts";

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
      assert.notEqual(verdict.details.reason, null);
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

describe("bonk-pr.yml", () => {
  // The job runs bonk.ts from a copy of the base commit's judge code, outside the checkout, so a
  // module the copy leaves out is missing only there.
  it("copies every module bonk.ts imports to where it runs it", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const scripts = stepsOf(parseWorkflow(readFileSync(join(root, ".github/workflows/bonk-pr.yml"), "utf8")))
      .flatMap(({ run }) => (typeof run === "string" ? [run] : []));
    const [copy, ...otherCopies] = scripts.filter((script) => script.includes("git archive"));
    const started = new Set(scripts.flatMap((script) => /^node (\$RUNNER_TEMP\/\S+)/.exec(script)?.[1] ?? []));
    assert.ok(copy !== undefined && otherCopies.length === 0 && started.size > 0, "one step copies the scripts, and later steps run them");

    const temp = mkdtempSync(join(tmpdir(), "automerge-judge-"));
    try {
      // The working tree's judge code as a tree, written to a scratch object store.
      const env = {
        ...process.env,
        GIT_INDEX_FILE: join(temp, "index"),
        GIT_OBJECT_DIRECTORY: join(temp, "objects"),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: git(["rev-parse", "--path-format=absolute", "--git-path", "objects"], root).trim(),
      };
      mkdirSync(env.GIT_OBJECT_DIRECTORY);
      execFileSync("git", ["add", "--all", "--", "scripts/automerge"], { cwd: root, env });
      const tree = execFileSync("git", ["write-tree"], { cwd: root, env, encoding: "utf8" }).trim();
      execFileSync("bash", ["-e", "-c", copy], { cwd: root, env: { ...env, BASE_SHA: tree, RUNNER_TEMP: temp } });
      for (const script of started) {
        const url = pathToFileURL(script.replace("$RUNNER_TEMP", temp)).href;
        // Imported rather than run: that loads every module the script imports and starts nothing.
        execFileSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(url)});`], { stdio: "pipe" });
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
