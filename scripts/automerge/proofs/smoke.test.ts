import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { evaluateSmoke, get, isReadyLine, startServer, type Answer } from "./smoke.ts";

const ORIGIN = "http://localhost:8799";
const html: Answer = { status: 200, contentType: "text/html; charset=utf-8", body: '<!DOCTYPE html>\n<html lang="en">\n</html>\n' };
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
    assert.deepEqual([outcome.status, outcome.holds, outcome.details.version_status], ["ok", false, 500]);
  });

  it("fails when /api/version answers without a version, or with one that is not a non-blank string", () => {
    for (const body of ['{"ok":true}', '{"version":null}', '{"version":""}', '{"version":"  "}', '{"version":7}', '{"version":{"id":"x"}}', '"118f3e9a"', "[]"]) {
      const outcome = evaluateSmoke(ORIGIN, html, { ...version, body });
      assert.deepEqual([outcome.status, outcome.holds, outcome.details.backend_version], ["ok", false, ""], body);
    }
  });

  it("fails when / is not the frontend's document, a redirect included", () => {
    assert.equal(evaluateSmoke(ORIGIN, { ...html, contentType: "application/json" }, version).holds, false);
    assert.equal(evaluateSmoke(ORIGIN, { status: 302, contentType: "", body: "" }, version).holds, false);
    for (const body of ["", "Internal error", '{"error":"no assets"}']) {
      assert.equal(evaluateSmoke(ORIGIN, { ...html, body }, version).holds, false, body);
    }
  });
});

const node = (script: string) => ["-e", script];

// A loopback server on the real clock: what is under test is that a request that never finishes
// ends at the timeout.
describe("smoke request", () => {
  for (const [what, answer] of [
    ["never answers", (_response: ServerResponse) => {}],
    ["sends headers but never the body", (response: ServerResponse) => response.writeHead(200, { "content-type": "text/html" })],
  ] satisfies [string, (response: ServerResponse) => void][]) {
    it(`gives up on a server that ${what}`, async () => {
      const held: ServerResponse[] = [];
      const server = createServer((_request, response) => {
        held.push(response);
        answer(response);
      }).listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address !== null && typeof address === "object");
      try {
        const started = Date.now();
        await assert.rejects(get(`http://127.0.0.1:${address.port}/`, 300));
        assert.ok(Date.now() - started >= 250, "rejected before the timeout");
      } finally {
        for (const response of held) response.destroy();
        server.close();
      }
    });
  }
});

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
  });

  it("is an error when it is not ready by the deadline", async () => {
    const server = startServer(process.execPath, node("setInterval(() => {}, 1000)"), 8799, Date.now() + 300);
    const outcome = await server.ready;
    server.stop();
    assert.equal(outcome?.status, "error");
  });

  it("matches only the ready line for its port", () => {
    assert.equal(isReadyLine("[wrangler:info] Ready on http://localhost:8799", 8799), true);
    assert.equal(isReadyLine("[wrangler:info] Ready on http://localhost:87990", 8799), false);
    assert.equal(isReadyLine("Starting local server at http://localhost:8799 ...", 8799), false);
  });
});
