// Boots the pinned workerd against the fixture config and asserts the three services behave
// through real bindings.
//
// This cannot live in `packages/integration-tests`: that harness boots via wrangler -> miniflare,
// and miniflare supplies its OWN KV/R2 implementations, so it would test Cloudflare's services
// rather than ours. Only a standalone-workerd boot exercises the binding protocol these services
// implement.
//
// It is also the workerd-upgrade canary. The protocol framings are unversioned workerd internals;
// if a bump changes them, this suite fails and `plans/workerd-probe/echo.js` re-derives them.

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixture");

/** Set once workerd reports the port it bound. */
let base = "";

/** Resolve the pinned binary rather than whatever `workerd` resolves to — two versions are in the
 * store, and the protocol framings are valid for this one exactly.
 *
 * `import.meta.resolve` returns a file: URL string. It is passed straight to fileURLToPath because
 * this package loads both @types/node and @cloudflare/workers-types, whose `URL` types are not
 * mutually assignable, and constructing one here would pick the wrong global. */
const WORKERD = fileURLToPath(import.meta.resolve("workerd/bin/workerd"));

/** @type {import("node:child_process").ChildProcess | undefined} */
let child;

/**
 * Boot workerd and resolve once it reports the port it bound.
 *
 * Binds port 0 so the OS assigns a free one — a fixed port makes the suite fail whenever anything
 * else holds it, including a parallel CI job or a leftover process from a manual run. `--control-fd`
 * makes workerd write a JSON line naming the chosen port once it is listening, which also removes
 * the need to poll for readiness.
 *
 * workerd refuses to boot if the DO storage directory is absent, so create it first.
 */
async function startWorkerd() {
  mkdirSync(join(FIXTURE_DIR, "dodata"), { recursive: true });
  const proc = spawn(
    WORKERD,
    ["serve", "fixture.capnp", "--socket-addr=http=127.0.0.1:0", "--control-fd=3"],
    { cwd: FIXTURE_DIR, stdio: ["ignore", "pipe", "pipe", "pipe"] },
  );
  proc.stderr?.on("data", (b) => process.env.DEBUG_WORKERD && console.error(String(b)));

  const port = await new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("workerd did not report a port")), 20_000);
    proc.stdio[3]?.on("data", (chunk) => {
      buffered += String(chunk);
      for (const line of buffered.split("\n")) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.event === "listen" && event.port) {
          clearTimeout(timer);
          resolve(event.port);
          return;
        }
      }
    });
    proc.on("exit", (code) => reject(new Error(`workerd exited early with code ${code}`)));
  });

  base = `http://127.0.0.1:${port}`;
  return proc;
}

beforeAll(async () => {
  rmSync(join(FIXTURE_DIR, "dodata"), { recursive: true, force: true });
  child = await startWorkerd();
  // Seed the values the restart test reads back.
  await fetch(base + "/seed");
}, 30_000);

afterAll(() => {
  child?.kill();
  rmSync(join(FIXTURE_DIR, "dodata"), { recursive: true, force: true });
});

test("KV, R2 and asset services behave through real workerd bindings", async () => {
  const results = await (await fetch(base + "/run")).json();
  // Report every failure at once rather than dying on the first, so a protocol change after a
  // workerd bump shows its full blast radius.
  const failed = results.filter((/** @type {{ok: boolean}} */ r) => !r.ok);
  expect(failed, `${failed.length} of ${results.length} checks failed`).toEqual([]);
  expect(results.length).toBeGreaterThan(15);
});

test("state survives a workerd restart", async () => {
  // Seeded in beforeAll's readiness probe; kill without a clean shutdown so this also proves the
  // SQLite WAL is durable rather than merely flushed on exit.
  child?.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 500));

  child = await startWorkerd();

  const results = await (await fetch(base + "/verify-restart")).json();
  const failed = results.filter((/** @type {{ok: boolean}} */ r) => !r.ok);
  expect(failed, "state did not survive restart").toEqual([]);
}, 30_000);
