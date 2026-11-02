#!/usr/bin/env node

// evidence-deploy-dry-run: every Worker the pull request can change still bundles for deploy.
//
// Picks the deployable packages the change reaches (workspace.ts), builds the workspace once
// (`pnpm build`, which the configurator and app bundles need), then runs
// `wrangler deploy --dry-run --outdir <tmp>` in each, the bundling half of `wrangler deploy`
// without the upload. It holds when every one of them bundles.
//
// This job runs the pull request's code and holds no secrets.
//
//   node scripts/automerge/evidence/deploy-dry-run.ts   (env: AUTOMERGE_HEAD_SHA, AUTOMERGE_BASE_SHA)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decide, notApplicable, runProducer, type Outcome } from "../proofs/artifact.ts";
import { pullRequestDiff } from "../proofs/git.ts";
import type { JsonObject } from "../proofs/json.ts";
import { runCommand, type CommandResult } from "./exec.ts";
import { affectedDeployables, readWorkspace } from "./workspace.ts";

/** One package's dry run, as the artifact records it. */
export interface DryRun {
  package: string;
  result: CommandResult;
}

/** Holds when the build and every dry run succeeded. */
export function evaluateDryRuns(build: CommandResult, runs: DryRun[]): Outcome {
  const failed = runs.filter((run) => !run.result.ok);
  const reasons = [
    ...(build.ok ? [] : [`pnpm build exited ${String(build.code)}`]),
    ...failed.map((run) => `wrangler deploy --dry-run failed for ${run.package} (exit ${String(run.result.code)})`),
  ];
  const packages: JsonObject = {};
  for (const run of runs) {
    packages[run.package] = run.result.ok
      ? { ok: true, seconds: run.result.seconds }
      : { ok: false, seconds: run.result.seconds, code: run.result.code, tail: run.result.tail };
  }
  return decide(reasons, {
    build: build.ok ? { ok: true, seconds: build.seconds } : { ok: false, code: build.code, tail: build.tail },
    packages,
  });
}

async function main(): Promise<void> {
  await runProducer("evidence", "evidence-deploy-dry-run", async ({ head, base }) => {
    const changed = pullRequestDiff(base, head).map((file) => file.path);
    const targets = affectedDeployables(readWorkspace("."), changed);
    if (targets.length === 0) return notApplicable("changes no deployable package or its inputs");
    const build = runCommand("pnpm", ["build"], ".");
    if (!build.ok) return evaluateDryRuns(build, []);
    const out = mkdtempSync(join(tmpdir(), "automerge-dry-run-"));
    try {
      const runs = targets.map((dir) => ({
        package: dir,
        result: runCommand("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", join(out, dir)], join("packages", dir)),
      }));
      return evaluateDryRuns(build, runs);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
