// Compare two Workshop eval result files and write the comparison JSON and Markdown:
//   node scripts/evals/compare-results.ts <keys.json> \
//     <baseline-results.json> <candidate-results.json> <comparison.json> <comparison.md>
// <keys.json> is scripts/evals/eval-keys.ts's output for the pull request's base and head. Besides
// naming the two commits, it decides which tasks cannot be compared: those whose definition
// differs between them, since a change to the eval code moves the goalposts without touching the
// product under test.
// This file runs under Node's native TypeScript stripping, so imports name real .ts files and only
// erasable syntax may appear here.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  compareEvalResults, renderEvalComparison,
} from "../../packages/workshop-evals/src/comparison.ts";

const USAGE = "Usage: node scripts/evals/compare-results.ts <keys.json> " +
  "<baseline-results.json> <candidate-results.json> <comparison.json> <comparison.md>";

const CommitSchema = z.object({
  sha: z.string(),
  tasks: z.record(z.string(), z.object({ definition: z.string() })),
});

const KeysSchema = z.object({
  commits: z.tuple([CommitSchema, CommitSchema]),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readInput(what: string, path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${what} at ${path}: ${errorMessage(error)}`, { cause: error });
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
  const [keysPath, baselinePath, candidatePath, jsonPath, markdownPath] = argv;
  const { commits: [baseline, candidate] } =
    KeysSchema.parse(JSON.parse(await readInput("eval keys", keysPath)));
  const report = compareEvalResults(
    await readInput("baseline results", baselinePath),
    await readInput("candidate results", candidatePath),
    {
      baselineSha: baseline.sha,
      candidateSha: candidate.sha,
      // Both sides have a key for every compared task: results name each task after its file.
      definitionsChanged: taskId =>
        baseline.tasks[taskId]?.definition !== candidate.tasks[taskId]?.definition,
    });
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
