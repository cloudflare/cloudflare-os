import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateSmoke, isReadyLine, startServer, type Answer } from "./smoke.ts";
import { parseWorkflow } from "./workflow.ts";

const ORIGIN = "http://localhost:8799";
const html: Answer = { status: 200, contentType: "text/html; charset=utf-8", body: "<!doctype html>" };
// What the local server's /api/version answered on 2026-11-03.
const version: Answer = { status: 200, contentType: "application/json", body: '{"version":"118f3e9a-eb13-46b1-aee7-7f14bd326b9e"}' };

describe("preview-smoke", () => {
  it("holds when / serves HTML and /api/version names a version", () => {
    const outcome = evaluateSmoke(ORIGIN, html, version);
    assert.equal(outcome.holds, true, JSON.stringify(outcome.details));
    assert.equal(outcome.details.backend_version, "118f3e9a-eb13-46b1-aee7-7f14bd326b9e");
  });

  it("fails when the backend is down behind the router", () => {
    const outcome = evaluateSmoke(ORIGIN, html, { ...version, status: 500, body: "broken on purpose" });
    assert.deepEqual(outcome.details.reasons, ["GET /api/version answered 500"]);
  });

  it("fails when /api/version answers without a version", () => {
    const outcome = evaluateSmoke(ORIGIN, html, { ...version, body: '{"ok":true}' });
    assert.deepEqual(outcome.details.reasons, ["GET /api/version answered 200 without a version field"]);
  });

  it("fails when / is not the frontend, a redirect included", () => {
    assert.deepEqual(evaluateSmoke(ORIGIN, { ...html, contentType: "application/json" }, version).details.reasons,
      ["GET / answered 200 application/json"]);
    assert.deepEqual(evaluateSmoke(ORIGIN, { status: 302, contentType: "", body: "" }, version).details.reasons,
      ["GET / answered 302 "]);
  });

  it("runs only locally: there is no deployed-preview mode", () => {
    assert.throws(() => execFileSync(process.execPath,
      [fileURLToPath(new URL("./smoke.ts", import.meta.url)), "deploy", "https://pr966-preview-router.example.workers.dev"],
      { env: { PATH: process.env.PATH }, stdio: "pipe" }), /usage: smoke\.ts local/);
  });
});

const node = (script: string) => ["-e", script];

// Real child processes on the real clock: what is under test is how a server's start is detected.
describe("local preview server", () => {
  it("is ready when it prints wrangler's ready line for the port", async () => {
    const server = startServer(process.execPath,
      node("console.log('building'); console.log('[wrangler:info] Ready on http://localhost:8799'); setInterval(() => {}, 1000)"),
      8799, Date.now() + 30_000);
    try {
      assert.equal(await server.ready, undefined);
    } finally {
      server.stop();
    }
  });

  it("is an error when it exits before it is ready, or is ready on another port", async () => {
    const server = startServer(process.execPath, node("console.log('Ready on http://localhost:9999'); process.exit(1)"),
      8799, Date.now() + 30_000);
    const outcome = await server.ready;
    server.stop();
    assert.equal(outcome?.status, "error");
    assert.match(String(outcome?.details.error), /exited with 1 before it was ready/);
  });

  it("is an error when it is not ready by the deadline", async () => {
    const server = startServer(process.execPath, node("setInterval(() => {}, 1000)"), 8799, Date.now() + 300);
    const outcome = await server.ready;
    server.stop();
    assert.equal(outcome?.status, "error");
    assert.match(String(outcome?.details.error), /not ready within/);
  });

  it("matches only the ready line for its port", () => {
    assert.equal(isReadyLine("[wrangler:info] Ready on http://localhost:8799", 8799), true);
    assert.equal(isReadyLine("[wrangler:info] Ready on http://localhost:87990", 8799), false);
    assert.equal(isReadyLine("Starting local server at http://localhost:8799 ...", 8799), false);
  });
});

// The workflows that produce the two smoke records, read from this checkout.
const workflow = (name: string) => readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), "utf8");

describe("smoke workflows", () => {
  it("smokes every pull request locally in automerge-evidence.yml, holding no secret", () => {
    const jobs = parseWorkflow(workflow("automerge-evidence.yml")).entries.get("jobs");
    assert.equal(jobs?.kind, "map");
    const job = jobs.kind === "map" ? jobs.spans.get("preview-smoke") : undefined;
    assert.ok(job, "no preview-smoke job");
    const text = workflow("automerge-evidence.yml").split("\n").slice(...job).join("\n");
    assert.doesNotMatch(text, /secrets/i);
    assert.match(text, /node scripts\/automerge\/proofs\/smoke\.ts local\n/);
    assert.match(text, /name: automerge-preview-smoke\n/);
  });

  it("deploys no bot preview and leaves maintainer previews without a smoke record", () => {
    const preview = workflow("preview.yml");
    const on = parseWorkflow(preview).entries.get("on");
    assert.ok(on?.kind === "map" && !on.entries.has("workflow_run"), "preview.yml runs on workflow_run");
    assert.doesNotMatch(preview, /PREVIEW_BOT|prebuilt|bot-deploy|smoke\.ts|automerge-preview|PREVIEW_ACCESS/);
    assert.doesNotMatch(workflow("automerge-evidence.yml"), /automerge-bot-preview-release/);
  });
});
