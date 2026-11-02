#!/usr/bin/env node

// evidence-preview-e2e: the pull request's preview passes the core Workshop flows at a desktop and
// a phone size (packages/workshop-frontend/e2e, run under its vitest.e2e.config.ts).
//
// The preview is what .github/workflows/preview.yml deployed for the head. This waits for that
// workflow's newest `pull_request` run on exactly the head SHA to finish, and requires that it
// succeeded, so the flows run against the head's deployment and not an earlier push's. Previews
// sit behind Cloudflare Access, and the backend keys each user by the email in the Access token,
// which a service token does not carry: the run needs an Access application token for a user with
// an email, as E2E_ACCESS_TOKEN. Without it the producer reports `error`.
//
// With --local it runs against a Workshop already serving at --base-url (`pnpm dev-server` and
// `pnpm dev-client`), signing up a fresh password account, and waits for no preview.
//
// This job holds the Access token, so it checks out the base: the flows and this script are the
// base's, and only the deployed preview is the head's.
//
//   node scripts/automerge/evidence/preview-e2e.ts --base-url <url> [--local]
//   env: AUTOMERGE_HEAD_SHA, AUTOMERGE_BASE_SHA; without --local also GITHUB_TOKEN,
//        GITHUB_REPOSITORY, E2E_ACCESS_TOKEN

import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { decide, errored, runProducer, type Outcome } from "../proofs/artifact.ts";
import { asArray, asNumber, asObject, asString, isObject, parseJson, type Json, type JsonObject } from "../proofs/json.ts";
import { runDetails, runTests, type TestRun } from "./vitest.ts";

export const E2E_CONFIG = "packages/workshop-frontend/vitest.e2e.config.ts";
const PREVIEW_WORKFLOW = ".github/workflows/preview.yml";
const POLL_MS = 30_000;
const DEADLINE_MS = 45 * 60 * 1000;
/** Flows per viewport times viewports; fewer means the suite did not run every flow. */
export const EXPECTED_TESTS = 10;

/** Where the head's preview deploy stands. */
export type PreviewRun = { state: "absent" } | { state: "pending" } | { state: "done"; id: number; conclusion: string };

/** When a run's latest attempt started; a re-run makes an old run the newest. */
function attemptStarted(run: JsonObject): number {
  return Date.parse(asString(run.run_started_at ?? run.created_at, "run start"));
}

/** The preview deploy run for `headSha`, from a workflow-runs listing: the newest attempt wins. */
export function previewRun(listing: Json, headSha: string, repository: string): PreviewRun {
  const runs = asArray(asObject(listing, "workflow runs").workflow_runs, "workflow_runs")
    .map((run) => asObject(run, "run"))
    .filter((run) => run.path === PREVIEW_WORKFLOW && run.event === "pull_request" && run.head_sha === headSha &&
      isObject(run.head_repository) && run.head_repository.full_name === repository);
  if (runs.length === 0) return { state: "absent" };
  const newest = runs.toSorted((a, b) => attemptStarted(b) - attemptStarted(a))[0];
  if (newest.status !== "completed") return { state: "pending" };
  return { state: "done", id: asNumber(newest.id, "run id"), conclusion: String(newest.conclusion) };
}

/** Holds when every flow ran and passed. */
export function evaluateE2e(run: TestRun, details: JsonObject): Outcome {
  const reasons: string[] = [];
  if (!run.passed) reasons.push(`${run.failedTests} flow(s) failed and ${run.failedSuites} suite(s) failed`);
  if (run.passed && run.tests < EXPECTED_TESTS) reasons.push(`ran ${run.tests} of ${EXPECTED_TESTS} flows`);
  return decide(reasons, { ...details, run: runDetails(run) });
}

async function github(path: string): Promise<Json> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub ${path}: ${response.status} ${text.slice(0, 300)}`);
  return parseJson(text);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "base-url": { type: "string" }, local: { type: "boolean" } } });
  await runProducer("evidence", "evidence-preview-e2e", async ({ head }): Promise<Outcome> => {
    const baseUrl = values["base-url"];
    if (!baseUrl) throw new Error("--base-url is required");
    const env: NodeJS.ProcessEnv = { ...process.env, E2E_BASE_URL: baseUrl };
    if (values.local) {
      delete env.E2E_ACCESS_TOKEN;
      return evaluateE2e(runTests(E2E_CONFIG, [], env), { base_url: baseUrl, mode: "local" });
    }
    if (!env.E2E_ACCESS_TOKEN) {
      return errored("E2E_ACCESS_TOKEN is not set: a preview needs an Access token for a user with an email (AUTOMERGE_PREVIEW_E2E_ACCESS_TOKEN)");
    }
    const repository = process.env.GITHUB_REPOSITORY;
    if (!repository) throw new Error("GITHUB_REPOSITORY is required");
    const deadline = Date.now() + DEADLINE_MS;
    for (;;) {
      const preview = previewRun(await github(
        `repos/${repository}/actions/workflows/preview.yml/runs?head_sha=${head}&event=pull_request&per_page=100`,
      ), head, repository);
      if (preview.state === "done") {
        if (preview.conclusion !== "success") return errored(`the preview deploy for ${head} concluded ${preview.conclusion}`, { preview_run: preview.id });
        return evaluateE2e(runTests(E2E_CONFIG, [], env), { base_url: baseUrl, mode: "preview", preview_run: preview.id });
      }
      if (Date.now() > deadline) return errored(`no finished preview deploy for ${head} within ${DEADLINE_MS / 60_000} minutes (${preview.state})`);
      // The preview workflow runs beside this one; poll the Actions API until its run finishes.
      await delay(POLL_MS);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
