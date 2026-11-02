#!/usr/bin/env node

// evidence-preview-e2e: the pull request's preview passes the core Workshop flows at a desktop and
// a phone size (packages/workshop-frontend/e2e, run under its vitest.e2e.config.ts).
//
// The preview is what .github/workflows/preview.yml deployed for the head. This waits for that
// workflow's newest `pull_request` run on exactly the head SHA to finish, and requires that it
// succeeded. The preview URL is per pull request, so a later deploy (a re-run of an older head)
// can replace what it serves; the flows are bound to the head by the backend's Worker version id.
// The preview run's smoke step (scripts/automerge/proofs/smoke.ts) records, in its
// `automerge-preview-smoke-<head sha>` artifact, the id `GET /api/version` answered right after the
// head deployed. The URL must answer that same id before and after the flows; no id, a different
// one, or no readable smoke artifact is `error`. Previews sit behind Cloudflare Access, and the
// backend keys each user by the email in the Access token, which a service token does not carry:
// the run needs an Access application token for a user with an email, as E2E_ACCESS_TOKEN.
// Without it the producer reports `error`.
//
// The flows decide only what they saw: a failing flow fails the evidence, and a missing report, a
// suite that crashed, or fewer than EXPECTED_TESTS passing flows is `error`.
//
// With --local it runs against a Workshop already serving at --base-url (`pnpm dev-server` and
// `pnpm dev-client`), signing up a fresh password account, unbound to any revision; it is for
// trying the flows, and no workflow uploads what it writes.
//
// This job holds the Access token, so it checks out the base: the flows and this script are the
// base's, and only the deployed preview is the head's.
//
//   node scripts/automerge/evidence/preview-e2e.ts --base-url <url> [--local]
//   env: AUTOMERGE_HEAD_SHA, AUTOMERGE_BASE_SHA; without --local also GITHUB_TOKEN, GH_TOKEN,
//        GITHUB_REPOSITORY, E2E_ACCESS_TOKEN

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { errored, fails, holds, runProducer, type Outcome } from "../proofs/artifact.ts";
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

/** Holds when every flow ran and passed; fails on a failing flow; errors on anything not seen. */
export function evaluateE2e(run: TestRun, details: JsonObject): Outcome {
  const all = { ...details, run: runDetails(run) };
  if (run.results === undefined) return errored("the e2e suite left no readable report", all);
  const failures = run.results.flatMap((result) => result.failures);
  const failed = run.results.reduce((sum, result) => sum + result.failed, 0);
  if (failed > 0) return fails([`${failed} flow(s) failed: ${failures.join("; ")}`], all);
  const passed = run.results.reduce((sum, result) => sum + result.passed, 0);
  const crashed = run.results.filter((result) => result.status !== "passed").map((result) => result.path);
  if (crashed.length > 0 || passed < EXPECTED_TESTS) {
    return errored(`ran ${passed} of ${EXPECTED_TESTS} flows${crashed.length > 0 ? `; ${crashed.join(", ")} did not finish` : ""}`, all);
  }
  // vitest exits non-zero for an unhandled error even when every reported flow passed.
  if (!run.exitOk) return errored("vitest exited non-zero with no failing flow", all);
  return holds(all);
}

/** The backend version id the head's smoke artifact recorded, or why there is none. */
export function deployedVersion(smoke: Json, headSha: string): { version: string } | { error: string } {
  if (!isObject(smoke) || smoke.schema !== 1 || smoke.name !== "preview-smoke") return { error: "the smoke artifact is not a preview-smoke artifact" };
  if (smoke.head_sha !== headSha) return { error: `the smoke artifact is for ${String(smoke.head_sha)}, not ${headSha}` };
  if (smoke.status !== "ok") return { error: `the head's smoke has status ${String(smoke.status)}, so no version was recorded` };
  const version = isObject(smoke.details) ? smoke.details.backend_version : undefined;
  return typeof version === "string" && version !== "" ? { version } : { error: "the head's smoke recorded no backend version" };
}

/** One answer to `GET /api/version`. */
export interface VersionAnswer {
  status: number;
  body: string;
}

/** The version id an `/api/version` answer names, or undefined. */
export function servedVersion(answer: VersionAnswer): string | undefined {
  if (answer.status !== 200) return undefined;
  try {
    const body = parseJson(answer.body);
    return isObject(body) && typeof body.version === "string" && body.version !== "" ? body.version : undefined;
  } catch {
    return undefined;
  }
}

/** Why the URL was not serving the head's deploy at one point, or undefined when it was. */
export function servingError(deployed: string, answer: VersionAnswer, when: string): string | undefined {
  const served = servedVersion(answer);
  if (served === undefined) return `${when} the flows, GET /api/version answered ${answer.status} with no version`;
  return served === deployed ? undefined : `${when} the flows, the preview served backend version ${served}, not the head's ${deployed}`;
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

async function versionAt(baseUrl: string, token: string): Promise<VersionAnswer> {
  const response = await fetch(new URL("/api/version", baseUrl), { headers: { "cf-access-token": token }, redirect: "manual" });
  return { status: response.status, body: await response.text() };
}

/** Downloads and parses the head's smoke artifact from the preview run. */
function smokeArtifact(repository: string, runId: number, head: string): Json {
  const dir = mkdtempSync(join(tmpdir(), "automerge-smoke-"));
  try {
    execFileSync("gh", ["run", "download", String(runId), "--repo", repository, "--name", `automerge-preview-smoke-${head}`, "--dir", dir], { stdio: "inherit" });
    return parseJson(readFileSync(join(dir, "automerge-preview-smoke.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "base-url": { type: "string" }, local: { type: "boolean" } } });
  await runProducer("evidence", "evidence-preview-e2e", async ({ head }): Promise<Outcome> => {
    const baseUrl = values["base-url"];
    if (!baseUrl) throw new Error("--base-url is required");
    const env: NodeJS.ProcessEnv = { ...process.env, E2E_BASE_URL: baseUrl };
    if (values.local) {
      delete env.E2E_ACCESS_TOKEN;
      return evaluateE2e(runTests(E2E_CONFIG, [], env), { base_url: baseUrl, mode: "local", bound: false });
    }
    const token = env.E2E_ACCESS_TOKEN;
    if (!token) {
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
        const details = { base_url: baseUrl, mode: "preview", preview_run: preview.id };
        if (preview.conclusion !== "success") return errored(`the preview deploy for ${head} concluded ${preview.conclusion}`, details);
        const deployed = deployedVersion(smokeArtifact(repository, preview.id, head), head);
        if ("error" in deployed) return errored(deployed.error, details);
        const bound = { ...details, backend_version: deployed.version };
        const before = servingError(deployed.version, await versionAt(baseUrl, token), "before");
        if (before) return errored(before, bound);
        const run = runTests(E2E_CONFIG, [], env);
        const after = servingError(deployed.version, await versionAt(baseUrl, token), "after");
        if (after) return errored(after, { ...bound, run: runDetails(run) });
        return evaluateE2e(run, bound);
      }
      if (Date.now() > deadline) return errored(`no finished preview deploy for ${head} within ${DEADLINE_MS / 60_000} minutes (${preview.state})`);
      // The preview workflow runs beside this one; poll the Actions API until its run finishes.
      await delay(POLL_MS);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
