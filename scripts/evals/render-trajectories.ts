// Render a Workshop eval result file's trajectories as Markdown for review:
//   node scripts/evals/render-trajectories.ts <results.json> <trajectories.md>
// This file runs under Node's native TypeScript stripping, so imports name real .ts files and only
// erasable syntax may appear here.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renderTrajectories } from "../../packages/workshop-evals/src/trajectory-markdown.ts";

const USAGE = "Usage: node scripts/evals/render-trajectories.ts <results.json> <trajectories.md>";

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
  const [resultsPath, markdownPath] = argv;
  let text: string;
  try {
    text = await readFile(resultsPath, "utf8");
  } catch (error) {
    throw new Error(`cannot read results at ${resultsPath}: ${errorMessage(error)}`, { cause: error });
  }
  const markdown = renderTrajectories(text);
  await mkdir(dirname(resolve(markdownPath)), { recursive: true });
  await writeFile(markdownPath, markdown, "utf8");
  console.log(`Wrote ${markdownPath}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`render-trajectories: ${errorMessage(error)}`);
  process.exitCode = 1;
});
