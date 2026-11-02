import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { asObject, parseJson } from "./json.ts";
import { evaluateSmoke, type Answer } from "./smoke.ts";

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

  it("writes status error without the Access service token, before any request", () => {
    const out = mkdtempSync(join(tmpdir(), "smoke-test-"));
    try {
      execFileSync(process.execPath, [fileURLToPath(new URL("./smoke.ts", import.meta.url)), PREVIEW], {
        env: {
          PATH: process.env.PATH, AUTOMERGE_OUT_DIR: out,
          AUTOMERGE_HEAD_SHA: "a".repeat(40), AUTOMERGE_BASE_SHA: "b".repeat(40),
          AUTOMERGE_TRIGGER_RUN_ID: "123", AUTOMERGE_TRIGGER_RUN_ATTEMPT: "2",
        },
        stdio: "pipe",
      });
      const artifact = asObject(parseJson(readFileSync(join(out, "automerge-preview-smoke.json"), "utf8")), "artifact");
      assert.equal(artifact.status, "error");
      assert.equal(artifact.holds, false);
      assert.deepEqual(asObject(artifact.details, "details").trigger, { run_id: 123, run_attempt: 2 });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
