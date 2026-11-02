#!/usr/bin/env node

// evidence-consumer-build: gadgets-internal, the internal deployment that pins this repository as
// its `public` submodule, still builds and passes its tests at the pull request's head.
//
// Triggers a gadgets-internal pipeline on its default branch with the trigger token, passing the
// head SHA as CLOUDFLARE_OS_SHA; the `public-consumer-build` job there checks the submodule out at
// exactly that commit, builds and tests, and does nothing else
// (drafts/gadgets-internal-consumer-build.patch in the automerge workspace adds it). Then polls the
// pipeline with a read-only token. The result is bound to the pipeline this run created: the
// pipeline's id, its `trigger` source, its CLOUDFLARE_OS_SHA variable and the job's own pipeline
// id must all match. It holds when that job succeeded.
//
// This job holds the two GitLab tokens and runs no pull request code: it checks out the base.
// Without either token it reports `error`, which sends the pull request to a person.
//
//   node scripts/automerge/evidence/consumer-build.ts
//   env: AUTOMERGE_HEAD_SHA, AUTOMERGE_BASE_SHA, GITLAB_TRIGGER_TOKEN, GITLAB_READ_TOKEN

import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { decide, errored, runProducer, type Outcome } from "../proofs/artifact.ts";
import { asArray, asNumber, asObject, asString, isObject, parseJson, type Json, type JsonObject } from "../proofs/json.ts";

export const GITLAB_API = "https://gitlab.cfdata.org/api/v4";
export const PROJECT_ID = 14584;
export const CONSUMER_REF = "main";
export const JOB_NAME = "public-consumer-build";
export const SHA_VARIABLE = "CLOUDFLARE_OS_SHA";
/** GitLab pipeline states after which nothing more runs. */
const FINISHED = new Set(["success", "failed", "canceled", "skipped"]);
const POLL_MS = 30_000;
const DEADLINE_MS = 60 * 60 * 1000;

/** What the trigger call returned, checked: a pipeline on the consumer's default branch. */
export function triggeredPipeline(response: Json): { id: number; url: string } {
  const pipeline = asObject(response, "trigger response");
  if (pipeline.ref !== CONSUMER_REF) throw new Error(`the trigger created a pipeline on ${String(pipeline.ref)}, not ${CONSUMER_REF}`);
  return { id: asNumber(pipeline.id, "pipeline id"), url: asString(pipeline.web_url, "pipeline url") };
}

/** Whether a pipeline has finished. */
export function finished(pipeline: JsonObject): boolean {
  return FINISHED.has(asString(pipeline.status, "pipeline status"));
}

/** Decides from a finished pipeline, its variables and its jobs, bound to `pipelineId` and `publicSha`. */
export function evaluatePipeline(
  pipelineId: number, publicSha: string, pipeline: JsonObject, variables: Json, jobs: Json, jobName = JOB_NAME,
): Outcome {
  if (pipeline.id !== pipelineId) return errored(`asked for pipeline ${pipelineId}, read ${String(pipeline.id)}`);
  if (pipeline.source !== "trigger") return errored(`pipeline ${pipelineId} has source ${String(pipeline.source)}, not trigger`);
  const pinned = asArray(variables, "pipeline variables").filter((entry) => isObject(entry) && entry.key === SHA_VARIABLE);
  const value = pinned.length === 1 && isObject(pinned[0]) ? pinned[0].value : undefined;
  if (value !== publicSha) return errored(`pipeline ${pipelineId} sets ${SHA_VARIABLE}=${String(value ?? "nothing")}, not ${publicSha}`);
  const matching = asArray(jobs, "pipeline jobs").map((entry) => asObject(entry, "job")).filter((job) => job.name === jobName);
  if (matching.length !== 1) return errored(`pipeline ${pipelineId} has ${matching.length} ${jobName} jobs; gadgets-internal needs the consumer-build job`);
  const job = matching[0];
  const jobPipeline = isObject(job.pipeline) ? job.pipeline.id : undefined;
  if (jobPipeline !== pipelineId) return errored(`job ${String(job.id)} belongs to pipeline ${String(jobPipeline)}`);
  const status = asString(job.status, "job status");
  const details = {
    pipeline_id: pipelineId, pipeline_url: asString(pipeline.web_url, "pipeline url"), public_sha: publicSha,
    consumer_sha: asString(pipeline.sha, "pipeline sha"), job_id: asNumber(job.id, "job id"),
    job_url: asString(job.web_url, "job url"), job_status: status,
  };
  if (!finished(pipeline)) return errored(`pipeline ${pipelineId} is still ${String(pipeline.status)}`, details);
  return decide(status === "success" ? [] : [`${jobName} ended ${status}`], details);
}

async function gitlab(path: string, init: { token: string; form?: URLSearchParams }): Promise<Json> {
  const response = await fetch(`${GITLAB_API}/${path}`, init.form
    ? { method: "POST", body: init.form }
    : { headers: { "PRIVATE-TOKEN": init.token } });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitLab ${path}: ${response.status} ${text.slice(0, 500)}`);
  return parseJson(text);
}

async function main(): Promise<void> {
  await runProducer("evidence", "evidence-consumer-build", async ({ head }): Promise<Outcome> => {
    const trigger = process.env.GITLAB_TRIGGER_TOKEN;
    const read = process.env.GITLAB_READ_TOKEN;
    if (!trigger) return errored("GITLAB_TRIGGER_TOKEN is not set");
    if (!read) return errored("GITLAB_READ_TOKEN is not set");

    const form = new URLSearchParams({ token: trigger, ref: CONSUMER_REF, [`variables[${SHA_VARIABLE}]`]: head });
    const { id, url } = triggeredPipeline(await gitlab(`projects/${PROJECT_ID}/trigger/pipeline`, { token: trigger, form }));
    console.log(`triggered ${url}`);
    const deadline = Date.now() + DEADLINE_MS;
    let pipeline = asObject(await gitlab(`projects/${PROJECT_ID}/pipelines/${id}`, { token: read }), "pipeline");
    while (!finished(pipeline)) {
      if (Date.now() > deadline) return errored(`pipeline ${id} did not finish in ${DEADLINE_MS / 60_000} minutes`, { pipeline_url: url });
      // GitLab offers no push notification a token-only client can wait on; poll its status.
      await delay(POLL_MS);
      pipeline = asObject(await gitlab(`projects/${PROJECT_ID}/pipelines/${id}`, { token: read }), "pipeline");
    }
    const variables = await gitlab(`projects/${PROJECT_ID}/pipelines/${id}/variables`, { token: read });
    const jobs = await gitlab(`projects/${PROJECT_ID}/pipelines/${id}/jobs?per_page=100`, { token: read });
    return evaluatePipeline(id, head, pipeline, variables, jobs);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
