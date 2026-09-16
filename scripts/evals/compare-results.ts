// Compare two Workshop eval result files and write the comparison JSON and Markdown:
//   node scripts/evals/compare-results.ts \
//     <baseline-results.json> <candidate-results.json> <comparison.json> <comparison.md> \
//     <definition-path>...
// Cohorts are non-comparable when any <definition-path> differs between the two reports' commits,
// since a change to the eval code moves the goalposts without touching the product under test.
// This file runs under Node's native TypeScript stripping, so imports name real .ts files and only
// erasable syntax may appear here.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  compareEvalResults, renderEvalComparison,
} from "../../packages/workshop-evals/src/comparison.ts";

const USAGE = "Usage: node scripts/evals/compare-results.ts " +
  "<baseline-results.json> <candidate-results.json> <comparison.json> <comparison.md> " +
  "<definition-path>...";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readResults(side: string, path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read ${side} results at ${path}: ${errorMessage(error)}`, { cause: error });
  }
}

function git(args: string[]): number {
  const result = spawnSync("git", args, { stdio: ["ignore", "ignore", "inherit"] });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** A stored baseline may predate a shallow checkout; fetch its commit on demand. */
function ensureCommit(sha: string): void {
  if (git(["cat-file", "-e", `${sha}^{commit}`]) === 0) return;
  if (git(["fetch", "--no-tags", "--depth=1", "origin", sha]) !== 0) {
    throw new Error(`cannot fetch baseline commit ${sha}`);
  }
}

function definitionsChanged(paths: string[]): (baselineSha: string, candidateSha: string) => boolean {
  return (baselineSha, candidateSha) => {
    ensureCommit(baselineSha);
    const status = git(["diff", "--quiet", baselineSha, candidateSha, "--", ...paths]);
    if (status === 0) return false;
    if (status === 1) return true;
    throw new Error(`git diff ${baselineSha} ${candidateSha} exited with ${status}`);
  };
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  if (argv.length < 5) {
    throw new Error(`expected at least 5 arguments but received ${argv.length}\n${USAGE}`);
  }
  const [baselinePath, candidatePath, jsonPath, markdownPath, ...definitionPaths] = argv;
  const report = compareEvalResults(
    await readResults("baseline", baselinePath),
    await readResults("candidate", candidatePath),
    definitionsChanged(definitionPaths));
  const markdown = renderEvalComparison(report);
  await mkdir(dirname(resolve(jsonPath)), { recursive: true });
  await mkdir(dirname(resolve(markdownPath)), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdown, "utf8");
  console.log(`Compared ${report.rows.length} task/model cohorts.`);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${markdownPath}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`compare-results: ${errorMessage(error)}`);
  process.exitCode = 1;
});
