import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { asObject, parseJson, type Json, type JsonObject } from "../proofs/json.ts";
import { evaluatePipeline, triggeredPipeline } from "./consumer-build.ts";

// Real gadgets-internal (project 14584) API responses recorded 2026-11-02 with `glab api`:
// merge-request pipelines 5206949 (passed) and 5206731 (its `test` job failed), their jobs and
// their variables (none). No trigger pipeline exists yet, so the bound cases take these pipelines
// with the source and variable a trigger would give them, and judge their real `test` job.
const DIR = new URL("./testdata/consumer/", import.meta.url);
const load = (name: string): Json => parseJson(readFileSync(new URL(name, DIR), "utf8"));
const PUBLIC_SHA = "91f4e707360a147ed01a69594e607d2b007dd718";

function asTriggered(id: number): { pipeline: JsonObject; variables: Json; jobs: Json } {
  return {
    pipeline: { ...asObject(load(`pipeline-${id}.json`), "pipeline"), source: "trigger" },
    variables: [{ variable_type: "env_var", key: "CLOUDFLARE_OS_SHA", value: PUBLIC_SHA }],
    jobs: load(`jobs-${id}.json`),
  };
}

describe("evaluatePipeline", () => {
  it("holds when the bound pipeline's job passed (5206949)", () => {
    const { pipeline, variables, jobs } = asTriggered(5206949);
    const outcome = evaluatePipeline(5206949, PUBLIC_SHA, pipeline, variables, jobs, "test");
    assert.equal(outcome.holds, true);
    assert.equal(outcome.details.consumer_sha, "a630970f73488d7fdde66a34847571361269f2b0");
    assert.equal(outcome.details.pipeline_url, "https://gitlab.cfdata.org/cloudflare/developers/gadgets-internal/-/pipelines/5206949");
  });

  it("does not hold when the job failed (5206731)", () => {
    const { pipeline, variables, jobs } = asTriggered(5206731);
    const outcome = evaluatePipeline(5206731, PUBLIC_SHA, pipeline, variables, jobs, "test");
    assert.equal(outcome.status, "ok");
    assert.deepEqual(outcome.details.reasons, ["test failed"]);
  });

  it("errors when the job never ran (5206949's manual preview-delete), instead of failing", () => {
    const { pipeline, variables, jobs } = asTriggered(5206949);
    const outcome = evaluatePipeline(5206949, PUBLIC_SHA, pipeline, variables, jobs, "preview-delete");
    assert.equal(outcome.status, "error");
    assert.equal(outcome.details.error, "preview-delete ended manual without running to a result");
  });

  it("errors on the recorded merge-request pipeline: not one a trigger made", () => {
    const outcome = evaluatePipeline(5206949, PUBLIC_SHA, asObject(load("pipeline-5206949.json"), "p"),
      load("variables-5206949.json"), load("jobs-5206949.json"), "test");
    assert.equal(outcome.status, "error");
    assert.match(String(outcome.details.error), /source merge_request_event, not trigger/);
  });

  it("errors when the pipeline pins another public commit, or none", () => {
    const { pipeline, jobs } = asTriggered(5206949);
    const other = [{ key: "CLOUDFLARE_OS_SHA", value: "c12807488cb5bd1f0aa1c40fa5b0a13d2b2de3a9" }];
    assert.equal(evaluatePipeline(5206949, PUBLIC_SHA, pipeline, other, jobs, "test").status, "error");
    assert.equal(evaluatePipeline(5206949, PUBLIC_SHA, pipeline, [], jobs, "test").status, "error");
  });

  it("errors when gadgets-internal has no consumer-build job yet", () => {
    const { pipeline, variables, jobs } = asTriggered(5206949);
    const outcome = evaluatePipeline(5206949, PUBLIC_SHA, pipeline, variables, jobs);
    assert.match(String(outcome.details.error), /has 0 public-consumer-build jobs/);
  });

  it("errors on a pipeline other than the one triggered", () => {
    const { pipeline, variables, jobs } = asTriggered(5206949);
    assert.equal(evaluatePipeline(5206731, PUBLIC_SHA, pipeline, variables, jobs, "test").status, "error");
  });
});

describe("triggeredPipeline", () => {
  it("rejects a pipeline on another ref", () => {
    assert.throws(() => triggeredPipeline(load("pipeline-5206949.json")), /refs\/merge-requests\/636\/head, not main/);
  });

  it("reads the id and URL of a main pipeline", () => {
    const response = { ...asObject(load("pipeline-5206949.json"), "p"), ref: "main" };
    assert.deepEqual(triggeredPipeline(response), {
      id: 5206949, url: "https://gitlab.cfdata.org/cloudflare/developers/gadgets-internal/-/pipelines/5206949",
    });
  });
});
