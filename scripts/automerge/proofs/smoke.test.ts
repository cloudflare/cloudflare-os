import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { asObject, parseJson } from "./json.ts";
import { evaluateSmoke, isReadyLine, startServer, type Answer } from "./smoke.ts";
import { parseWorkflow } from "./workflow.ts";

const PREVIEW = "https://pr966-preview-router.example.workers.dev";
const html: Answer = { status: 200, contentType: "text/html; charset=utf-8", location: "", body: "<!doctype html>" };
const version: Answer = { status: 200, contentType: "application/json", location: "", body: '{"version":"r000966-91f4e70"}' };
// What pr966's preview answered without a token on 2026-11-02.
const accessLogin: Answer = {
  status: 302, contentType: "", body: "",
  location: "https://cf-cloudflare-os-previews.cloudflareaccess.com/cdn-cgi/access/login/pr966-preview-router.example.workers.dev",
};

describe("preview-smoke", () => {
  it("holds when / serves HTML and /api/version names a version", () => {
    const outcome = evaluateSmoke(PREVIEW, html, version);
    assert.equal(outcome.holds, true, JSON.stringify(outcome.details));
    assert.equal(outcome.details.backend_version, "r000966-91f4e70");
  });

  it("is an error, not a failure, when Access turns the request away", () => {
    for (const [root, api] of [[accessLogin, accessLogin], [html, accessLogin]]) {
      const outcome = evaluateSmoke(PREVIEW, root, api);
      assert.equal(outcome.status, "error");
      assert.equal(outcome.holds, false);
    }
  });

  it("fails when the backend is down behind the router", () => {
    const outcome = evaluateSmoke(PREVIEW, html, { ...version, status: 502, body: "Bad Gateway" });
    assert.deepEqual(outcome.details.reasons, ["GET /api/version answered 502"]);
  });

  it("fails when /api/version answers without a version", () => {
    const outcome = evaluateSmoke(PREVIEW, html, { ...version, body: '{"ok":true}' });
    assert.deepEqual(outcome.details.reasons, ["GET /api/version answered 200 without a version field"]);
  });

  it("fails when / is not the frontend", () => {
    const outcome = evaluateSmoke(PREVIEW, { ...html, contentType: "application/json" }, version);
    assert.deepEqual(outcome.details.reasons, ["GET / answered 200 application/json"]);
  });

  it("fails a redirect that is not the Access login", () => {
    const outcome = evaluateSmoke(PREVIEW, { ...accessLogin, location: "https://evil.example/" }, version);
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.holds, false);
  });

  it("records a maintainer preview as preview-deploy, status error without the Access service token", () => {
    const out = mkdtempSync(join(tmpdir(), "smoke-test-"));
    try {
      execFileSync(process.execPath, [fileURLToPath(new URL("./smoke.ts", import.meta.url)), "deploy", PREVIEW], {
        env: { PATH: process.env.PATH, AUTOMERGE_OUT_DIR: out, AUTOMERGE_HEAD_SHA: "a".repeat(40), AUTOMERGE_BASE_SHA: "b".repeat(40) },
        stdio: "pipe",
      });
      const artifact = asObject(parseJson(readFileSync(join(out, "automerge-preview-deploy.json"), "utf8")), "artifact");
      assert.equal(artifact.name, "preview-deploy");
      assert.equal(artifact.status, "error");
      assert.equal(artifact.holds, false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
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

  it("deploys no bot preview and records maintainer previews as preview-deploy", () => {
    const preview = workflow("preview.yml");
    const on = parseWorkflow(preview).entries.get("on");
    assert.ok(on?.kind === "map" && !on.entries.has("workflow_run"), "preview.yml runs on workflow_run");
    assert.doesNotMatch(preview, /PREVIEW_BOT|prebuilt|bot-deploy/);
    assert.match(preview, /smoke\.ts deploy "\$\(cat output\/preview-url\)"/);
    assert.match(preview, /name: automerge-preview-deploy-\$\{\{ github\.event\.pull_request\.head\.sha \}\}\n/);
    assert.doesNotMatch(workflow("automerge-evidence.yml"), /automerge-bot-preview-release/);
  });
});
