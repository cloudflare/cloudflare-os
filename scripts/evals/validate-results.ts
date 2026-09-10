// Reject a Workshop eval result file that cannot be stored as the main baseline:
//   node scripts/evals/validate-results.ts <results.json> <trials>
// This file runs under Node's native TypeScript stripping, so imports name real .ts files and only
// erasable syntax may appear here.
import { readFile } from "node:fs/promises";
import { validateEvalResults } from "../../packages/workshop-evals/src/comparison.ts";

const USAGE = "Usage: node scripts/evals/validate-results.ts <results.json> <trials>";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  if (argv.length !== 2) {
    throw new Error(`expected 2 arguments but received ${argv.length}\n${USAGE}`);
  }
  const [resultsPath, rawTrials] = argv;
  const trials = Number(rawTrials);
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error(`trials must be a positive integer\n${USAGE}`);
  }
  let text: string;
  try {
    text = await readFile(resultsPath, "utf8");
  } catch (error) {
    throw new Error(`cannot read results at ${resultsPath}: ${errorMessage(error)}`, { cause: error });
  }
  validateEvalResults(text, trials);
  console.log(`${resultsPath} is a complete ${trials}-trial baseline.`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`validate-results: ${errorMessage(error)}`);
  process.exitCode = 1;
});
