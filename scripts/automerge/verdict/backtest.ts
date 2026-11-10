// Replays the Opus verdict runner over the regression set and past merged pull requests. Bonk's
// verdict comes only from a live Bonk job, so it has no replay here.
//   node scripts/automerge/verdict/backtest.ts [--past <n>] [--no-regression]
//       [--out <file.jsonl>] [--ref <ref>] [--policy-ref <ref>] [--confirm-spend]
// Without --confirm-spend it prints a token and cost estimate and calls no model. With it, it needs
// OPENCODE_BIN and the CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_GATEWAY_ID and CLOUDFLARE_API_TOKEN values,
// and writes one line per review to --out.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { field, list, parseJson } from "./json.ts";
import { buildVerdict, prepareInputs, runReview } from "./verdict.ts";

interface Case {
  id: string;
  title: string;
  headSha: string;
  baseSha: string;
  linesChanged: number;
  /** Null for a past pull request, which is not a known escape. */
  catchable: boolean | null;
}

/** Opus's USD per million tokens, from models.dev's `cloudflare-ai-gateway` entry on 2026-11-02. */
const PRICE = { input: 4, output: 20, cacheRead: 0.2 };

// Assumptions, not measurements: each verdict artifact records `details.tokens`, so replace these
// with the medians of the first live reviews.
const TOKENS_PER_CHANGED_LINE = 15;
/** Files the reviewer reads beyond the diff, as a multiple of the diff, with a floor. */
const READ_MULTIPLE = 2;
const READ_FLOOR_TOKENS = 20_000;
/** Model turns per review; each turn re-sends the context so far, mostly from the prompt cache. */
const TURNS = 20;
const OUTPUT_TOKENS = 20_000;
const CHARS_PER_TOKEN = 4;

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 }).trim();
}

function regressionCases(file: string): Case[] {
  return list(field(parseJson(readFileSync(file, "utf8")), "cases")).map(entry => {
    const id = field(entry, "id");
    const title = field(entry, "title");
    const headSha = field(entry, "head_sha");
    const baseSha = field(entry, "base_sha");
    const linesChanged = field(entry, "lines_changed");
    const catchable = field(entry, "code_reader_could_catch");
    if (typeof id !== "string" || typeof title !== "string" || typeof headSha !== "string" ||
      typeof baseSha !== "string" || typeof linesChanged !== "number" || typeof catchable !== "boolean") {
      throw new Error(`${file} has a malformed case: ${JSON.stringify(entry)}`);
    }
    return { id, title, headSha, baseSha, linesChanged, catchable };
  });
}

/** The last `count` squash-merged pull requests on the first-parent history of `ref`. */
function pastCases(repo: string, ref: string, count: number): Case[] {
  if (count === 0) return [];
  const cases: Case[] = [];
  for (const line of git(repo, ["log", "--first-parent", "--format=%H%x09%s", ref]).split("\n")) {
    const [sha, subject] = line.split("\t");
    const pr = /\(#(\d+)\)$/.exec(subject ?? "");
    if (!pr) continue;
    const linesChanged = git(repo, ["show", "--numstat", "--format=", sha]).split("\n")
      .map(stat => stat.split("\t")).filter(([added]) => added !== "-" && added !== "")
      .reduce((sum, [added, removed]) => sum + Number(added) + Number(removed), 0);
    cases.push({ id: `past-${pr[1]}`, title: subject, headSha: sha, baseSha: `${sha}^1`, linesChanged, catchable: null });
    if (cases.length === count) break;
  }
  return cases;
}

function estimateUsd(promptTokens: number, linesChanged: number): { tokens: number; usd: number } {
  const diff = linesChanged * TOKENS_PER_CHANGED_LINE;
  const finalContext = promptTokens + diff + Math.max(diff * READ_MULTIPLE, READ_FLOOR_TOKENS);
  const sent = TURNS * finalContext / 2;
  const fresh = finalContext;
  const cached = sent - fresh;
  const usd = (fresh * PRICE.input + cached * PRICE.cacheRead + OUTPUT_TOKENS * PRICE.output) / 1_000_000;
  return { tokens: sent + OUTPUT_TOKENS, usd };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      past: { type: "string", default: "0" },
      "no-regression": { type: "boolean", default: false },
      out: { type: "string", default: "backtest.jsonl" },
      "confirm-spend": { type: "boolean", default: false },
      ref: { type: "string", default: "origin/main" },
      // The rules every replayed review runs under, so results compare across cases.
      "policy-ref": { type: "string", default: "origin/main" },
    },
  });
  const repo = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const past = Number(values.past);
  if (!Number.isInteger(past) || past < 0) throw new Error(`--past must be a whole number, got ${values.past}`);
  const cases = [
    ...(values["no-regression"] ? [] : regressionCases(join(import.meta.dirname, "regression-set.json"))),
    ...pastCases(repo, values.ref, past),
  ];

  const promptTokens = Math.ceil(readFileSync(join(repo, "REVIEW.md"), "utf8").length / CHARS_PER_TOKEN) + 1_000;
  console.log(`${cases.length} Opus reviews`);
  console.log(`assumptions: ${TOKENS_PER_CHANGED_LINE} tokens per changed line, reads ${READ_MULTIPLE}x the diff ` +
    `(at least ${READ_FLOOR_TOKENS}), ${TURNS} turns, ${OUTPUT_TOKENS} output tokens, ${promptTokens} prompt tokens`);
  let tokens = 0;
  let usd = 0;
  for (const { linesChanged } of cases) {
    const estimate = estimateUsd(promptTokens, linesChanged);
    tokens += estimate.tokens;
    usd += estimate.usd;
  }
  console.log(`about ${(tokens / 1_000_000).toFixed(1)}M tokens, $${usd.toFixed(2)}`);

  if (!values["confirm-spend"]) {
    console.log("No model was called. Pass --confirm-spend once the spend is approved.");
    return;
  }
  const opencodeBin = process.env.OPENCODE_BIN;
  const gateway = {
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    CLOUDFLARE_GATEWAY_ID: process.env.CLOUDFLARE_GATEWAY_ID ?? "",
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? "",
  };
  if (!opencodeBin || Object.values(gateway).some(value => value === "")) {
    throw new Error("--confirm-spend needs OPENCODE_BIN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_GATEWAY_ID and CLOUDFLARE_API_TOKEN");
  }
  const policySha = git(repo, ["rev-parse", values["policy-ref"]]);
  console.log(`reviewing under REVIEW.md and instruction files from ${policySha}`);
  for (const testCase of cases) {
    const missing = [testCase.headSha, testCase.baseSha]
      .filter(sha => spawnSync("git", ["-C", repo, "cat-file", "-e", `${sha}^{commit}`]).status !== 0);
    if (missing.length > 0) git(repo, ["fetch", "--no-tags", "origin", ...missing]);
    const baseSha = git(repo, ["rev-parse", testCase.baseSha]);
    const workDir = mkdtempSync(join(tmpdir(), `backtest-${testCase.id}-`));
    const started = Date.now();
    const pr = { headSha: testCase.headSha, baseSha, title: testCase.title, body: "" };
    // A named case: one case that cannot be prepared or reviewed is recorded, and the rest run.
    let runnerError: string | null = null;
    try {
      prepareInputs(repo, workDir, pr, { round: 1, reviewFromSha: null }, policySha);
      runReview(workDir, opencodeBin, gateway);
    } catch (error) {
      runnerError = error instanceof Error ? error.message : String(error);
    }
    try {
      const verdict = buildVerdict(workDir, pr);
      appendFileSync(values.out, `${JSON.stringify({ case: testCase.id, catchable: testCase.catchable,
        lines_changed: testCase.linesChanged, wall_ms: Date.now() - started, runner_error: runnerError, verdict })}\n`);
      console.log(`${testCase.id}: ${verdict.status} confidence ${verdict.merge_confidence}, ` +
        `${verdict.findings.filter(finding => finding.severity === "P0" || finding.severity === "P1").length} P0/P1, ` +
        `needs a person ${verdict.needs_person.length}, tokens ${JSON.stringify(verdict.details.tokens)}` +
        (runnerError === null ? "" : `, runner error: ${runnerError}`));
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

main();
