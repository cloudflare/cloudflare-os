#!/usr/bin/env node

// The preview smoke: the workers answer on their two public paths.
//
//   GET /             the router serves the frontend (200, HTML)
//   GET /api/version  the router reaches the backend over its service binding, and the backend's
//                     module loads (200, JSON with a `version` field)
//
// Two modes, two records:
//
//   node scripts/automerge/proofs/smoke.ts local
//       `preview-smoke`, for the risk-review gate. Builds and runs the pull request's workers on
//       this machine (scripts/run-local.ts: `wrangler dev` over every worker, in workerd) and
//       smokes http://localhost:LOCAL_PORT. Needs no secret and deploys nothing, so it runs for
//       every pull request, Dependabot's included. A server that exits, or that is not ready
//       within LOCAL_READY_MINUTES, is status `error`.
//
//   node scripts/automerge/proofs/smoke.ts deploy <preview origin>
//       `preview-deploy`, a maintainer preview's record (preview.yml), which evidence-preview-e2e
//       reads `backend_version` from. Previews sit behind Cloudflare Access, so this sends the
//       Access service token PREVIEW_ACCESS_CLIENT_ID / PREVIEW_ACCESS_CLIENT_SECRET; without one
//       the result is status `error`.
//
//   env: AUTOMERGE_HEAD_SHA, AUTOMERGE_BASE_SHA

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { decide, errored, runProducer, type Outcome } from "./artifact.ts";
import { isObject, parseJson } from "./json.ts";

/** One response, as much of it as the checks read. */
export interface Answer {
  status: number;
  contentType: string;
  location: string;
  body: string;
}

const ACCESS_LOGIN = /^https:\/\/[^/]+\.cloudflareaccess\.com\//;
export const LOCAL_PORT = 8799;
const LOCAL_READY_MINUTES = 15;

/** Judges the answers to `GET /` and `GET /api/version`. */
export function evaluateSmoke(url: string, root: Answer, version: Answer): Outcome {
  if ([root, version].some((answer) => answer.status === 302 && ACCESS_LOGIN.test(answer.location))) {
    return errored("Cloudflare Access turned the request away: the Access service token is missing " +
      "or the preview's Access application does not admit it", { url });
  }
  const reasons: string[] = [];
  if (root.status !== 200 || !root.contentType.startsWith("text/html")) {
    reasons.push(`GET / answered ${root.status} ${root.contentType}`);
  }
  let backend = "";
  if (version.status === 200) {
    const body = parseJson(version.body);
    if (isObject(body) && "version" in body) backend = String(body.version);
    else reasons.push("GET /api/version answered 200 without a version field");
  } else {
    reasons.push(`GET /api/version answered ${version.status}`);
  }
  return decide(reasons, { url, root_status: root.status, version_status: version.status, backend_version: backend });
}

async function get(url: string, headers: Record<string, string>): Promise<Answer> {
  const response = await fetch(url, { headers, redirect: "manual" });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    location: response.headers.get("location") ?? "",
    body: await response.text(),
  };
}

async function smoke(origin: string, headers: Record<string, string>): Promise<Outcome> {
  return evaluateSmoke(origin, await get(`${origin}/`, headers), await get(`${origin}/api/version`, headers));
}

/** Whether a line of the local server's output says it is listening on `port`. */
export function isReadyLine(line: string, port: number): boolean {
  return new RegExp(`Ready on http://localhost:${port}(?!\\d)`).test(line);
}

/**
 * Starts `command` in its own process group and resolves once it prints a ready line, or with an
 * error outcome when it exits first or `deadline` passes. `stop` kills the whole group, workerd
 * included.
 */
export function startServer(command: string, args: string[], port: number, deadline: number):
  { ready: Promise<Outcome | undefined>; stop: () => void } {
  const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  const { promise, resolve } = Promise.withResolvers<Outcome | undefined>();
  let pending = "";
  child.stdout.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    const lines = (pending + chunk.toString("utf8")).split("\n");
    pending = lines.pop() ?? "";
    if (lines.some((line) => isReadyLine(line, port))) resolve(undefined);
  });
  const timer = setTimeout(() => resolve(errored(`the local server was not ready within ${LOCAL_READY_MINUTES} minutes`)),
    Math.max(0, deadline - Date.now()));
  child.on("error", (error) => resolve(errored(`the local server did not start: ${error.message}`)));
  child.on("exit", (code, signal) => resolve(errored(`the local server exited with ${code ?? signal} before it was ready`)));
  return {
    ready: promise.finally(() => clearTimeout(timer)),
    stop: () => {
      child.stdout.destroy();
      child.unref();
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        // ESRCH: the group is already gone.
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    },
  };
}

async function local(): Promise<Outcome> {
  const origin = `http://localhost:${LOCAL_PORT}`;
  const server = startServer(process.execPath, ["scripts/run-local.ts", "--port", String(LOCAL_PORT)], LOCAL_PORT,
    Date.now() + LOCAL_READY_MINUTES * 60_000);
  try {
    const failed = await server.ready;
    return failed ?? await smoke(origin, {});
  } finally {
    server.stop();
  }
}

async function deployed(origin: string): Promise<Outcome> {
  if (!/^https:\/\/[^/]+$/.test(origin)) throw new Error(`expected the preview origin, got "${origin}"`);
  const id = process.env.PREVIEW_ACCESS_CLIENT_ID ?? "";
  const secret = process.env.PREVIEW_ACCESS_CLIENT_SECRET ?? "";
  if (id === "" || secret === "") {
    return errored("PREVIEW_ACCESS_CLIENT_ID and PREVIEW_ACCESS_CLIENT_SECRET are not configured", { url: origin });
  }
  return smoke(origin, { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret });
}

async function main(): Promise<void> {
  const [mode, origin] = process.argv.slice(2);
  if (mode === "local") await runProducer("evidence", "preview-smoke", local);
  else if (mode === "deploy") await runProducer("evidence", "preview-deploy", () => deployed(origin ?? ""));
  else throw new Error("usage: smoke.ts local | smoke.ts deploy <preview origin>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
