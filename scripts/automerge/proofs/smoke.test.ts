import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateSmoke, isReadyLine, startServer, type Answer } from "./smoke.ts";

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
