// Compare two Workshop eval result files and write the comparison JSON and Markdown:
//   node scripts/evals/compare-results.ts \
//     <baseline-results.json> <candidate-results.json> <comparison.json> <comparison.md> <definitions-changed>
// This file runs under Node's native TypeScript stripping, so imports name real .ts files and only
// erasable syntax may appear here.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  compareEvalResults, renderEvalComparison,
} from "../../packages/workshop-evals/src/comparison.ts";

const USAGE = "Usage: node scripts/evals/compare-results.ts " +
  "<baseline-results.json> <candidate-results.json> <comparison.json> <comparison.md> " +
  "<definitions-changed>";

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

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  if (argv.length !== 5) {
    throw new Error(`expected 5 arguments but received ${argv.length}\n${USAGE}`);
  }
  const [baselinePath, candidatePath, jsonPath, markdownPath, definitionsChanged] = argv;
  if (definitionsChanged !== "true" && definitionsChanged !== "false") {
    throw new Error(`definitions-changed must be true or false\n${USAGE}`);
  }
  const report = compareEvalResults(
    await readResults("baseline", baselinePath),
    await readResults("candidate", candidatePath),
    definitionsChanged === "true");
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
