import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { table as realTable } from "../generated/commands.ts";
import { UsageError } from "./output.ts";
import {
  accessToken,
  connect,
  defaultInstance,
  passwordHash,
  resolveAuth,
  resolveTarget,
  USER_AGENT,
  webSocketConnection,
  type SessionDeps,
  type SpawnCloudflared,
} from "./session.ts";
import { callsOf, fixtureRoot, messagePortServer, serverLog, type FixtureOptions } from "./test-server.ts";

const SALT = [1, 2, 254, 255];

test("--url is the instance's origin: wss:// for https, ws:// only for an explicit http://", () => {
  assert.deepEqual(resolveTarget("https://os.example.com/some/path", {}), { origin: "https://os.example.com", url: "wss://os.example.com/api" });
  assert.deepEqual(resolveTarget("http://localhost:8787", {}), { origin: "http://localhost:8787", url: "ws://localhost:8787/api" });
  assert.throws(() => resolveTarget("ftp://os.example.com", {}), /must be an https:\/\/ origin/);
  assert.throws(() => resolveTarget("os.example.com", {}), /is not a URL/);
});

/** What cloudflare-os-starter's `cf-os` says when its deployment names no instance. */
const REASON = "deployment.jsonc is not configured yet (https://<your-domain>): pass --url <origin>.";

test("without --url, the instance is CFOS_API_URL's, else CFOS_API_URL_UNAVAILABLE's reason fails, else the dev server", () => {
  const local = { origin: "http://localhost:8787", url: "ws://localhost:8787/api" };
  assert.deepEqual(resolveTarget(undefined, {}), local);
  assert.deepEqual(resolveTarget(undefined, { CFOS_API_URL: "https://os.example.com/x" }),
    { origin: "https://os.example.com", url: "wss://os.example.com/api" });
  // --url wins over both, and CFOS_API_URL over the reason.
  assert.deepEqual(resolveTarget("http://localhost:9999", { CFOS_API_URL: "https://a.example", CFOS_API_URL_UNAVAILABLE: REASON }),
    { origin: "http://localhost:9999", url: "ws://localhost:9999/api" });
  assert.deepEqual(resolveTarget(undefined, { CFOS_API_URL: "https://a.example", CFOS_API_URL_UNAVAILABLE: REASON }),
    { origin: "https://a.example", url: "wss://a.example/api" });

  // The reason is the whole message, as the caller wrote it; an empty variable is unset.
  const theReason = (error: unknown) => error instanceof UsageError && error.message === REASON;
  assert.throws(() => resolveTarget(undefined, { CFOS_API_URL_UNAVAILABLE: REASON }), theReason);
  assert.throws(() => resolveTarget(undefined, { CFOS_API_URL: "", CFOS_API_URL_UNAVAILABLE: REASON }), theReason);
  assert.deepEqual(resolveTarget(undefined, { CFOS_API_URL_UNAVAILABLE: "" }), local);

  // CFOS_API_URL is validated as --url is, its failures naming it.
  assert.throws(() => resolveTarget(undefined, { CFOS_API_URL: "os.example.com" }),
    (error: unknown) => error instanceof UsageError && error.message.startsWith("CFOS_API_URL os.example.com is not a URL"));
  assert.throws(() => resolveTarget(undefined, { CFOS_API_URL: "ftp://x" }),
    (error: unknown) => error instanceof UsageError && error.message.startsWith("CFOS_API_URL ftp://x must be an https:// origin"));
});

test("the default instance is the environment's, as data for the help", () => {
  const devServer = { kind: "url", url: "http://localhost:8787", from: "dev-server" };
  assert.deepEqual(defaultInstance({}), devServer);
  assert.deepEqual(defaultInstance({ CFOS_API_URL: "https://a.example" }), { kind: "url", url: "https://a.example", from: "CFOS_API_URL" });
  assert.deepEqual(defaultInstance({ CFOS_API_URL_UNAVAILABLE: "r" }), { kind: "unavailable", reason: "r" });
  assert.deepEqual(defaultInstance({ CFOS_API_URL: "", CFOS_API_URL_UNAVAILABLE: "" }), devServer);
});

test("the sign-in is --auth, else a password for --username, a token for CFOS_API_TOKEN, else Access over https", () => {
  const https = "https://os.example.com";
  assert.deepEqual(resolveAuth({}, {}, https), { mode: "access" });
  assert.deepEqual(resolveAuth({}, { CFOS_API_TOKEN: "t" }, https), { mode: "token" });
  assert.deepEqual(resolveAuth({ username: "alice" }, { CFOS_API_TOKEN: "t" }, https), { mode: "password", username: "alice" });
  assert.deepEqual(resolveAuth({ auth: "access" }, { CFOS_API_TOKEN: "t" }, https), { mode: "access" });
  assert.throws(() => resolveAuth({ auth: "oauth" }, {}, https), /--auth must be one of access, token, password/);
  assert.throws(() => resolveAuth({ auth: "password" }, {}, https), /needs --username/);
  assert.throws(() => resolveAuth({ auth: "token", username: "alice" }, {}, https), /--username is for --auth password/);
  // Access never fronts a dev server, and its token is not for a plain-text origin.
  const http = "http://localhost:8787";
  assert.deepEqual(resolveAuth({}, {}, http), { mode: "token" });
  assert.deepEqual(resolveAuth({ username: "alice" }, {}, http), { mode: "password", username: "alice" });
  assert.throws(() => resolveAuth({ auth: "access" }, {}, http), /plain text; Access fronts https:\/\/ origins only/);
});

test("the password hash is the frontend's argon2id over SERVICE_SALT ++ the username", async () => {
  // Computed once with hash-wasm's argon2id: password "correct horse", salt the API's
  // SERVICE_SALT followed by utf8("alice"), parallelism 1, 3 iterations, 64 MiB, 32 bytes.
  const hash = await passwordHash("alice", "correct horse", realTable.constants.SERVICE_SALT);
  assert.equal(Buffer.from(hash).toString("hex"), "53ecb1a9a75da3f7e034e02d429f26482da87fd75c5fd967bac332a6ae6ac093");
});

test("the Access token comes from CF_ACCESS_TOKEN, else cloudflared, spawned without a shell", () => {
  const calls: { command: string; args: string[]; options: object }[] = [];
  const spawn = (reply: ReturnType<SpawnCloudflared>): SpawnCloudflared => (command, args, options) => {
    calls.push({ command, args, options });
    return reply;
  };
  const ok = spawn({ status: 0, stdout: "aaa.bbb.ccc\n", stderr: "" });
  assert.equal(accessToken("https://os.example.com", { env: { CF_ACCESS_TOKEN: "env.token.value" }, spawn: ok }), "env.token.value");
  assert.equal(calls.length, 0);
  assert.equal(accessToken("https://os.example.com", { env: {}, spawn: ok }), "aaa.bbb.ccc");
  assert.equal(calls[0].command, "cloudflared");
  assert.deepEqual(calls[0].args, ["access", "token", "-app=https://os.example.com"]);
  assert.equal("shell" in calls[0].options, false);

  assert.throws(
    () => accessToken("https://os.example.com", { env: {}, spawn: spawn({ status: 1, stdout: "", stderr: "Unable to find token" }) }),
    /Unable to find token\. Run `cloudflared access login https:\/\/os\.example\.com`/);
  const missing = spawn({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" }) });
  assert.throws(() => accessToken("https://os.example.com", { env: {}, spawn: missing }),
    /cloudflared could not run \(spawn cloudflared ENOENT\)\. Run `cloudflared access login https:\/\/os\.example\.com`/);

  // Neither a malformed CF_ACCESS_TOKEN nor what cloudflared printed instead of a token is repeated.
  const pasted = "eyJhbGc.SECRETPAYLOAD.sig\nsecond-line";
  assert.throws(() => accessToken("https://os.example.com", { env: { CF_ACCESS_TOKEN: pasted }, spawn: ok }),
    (error: Error) => /CF_ACCESS_TOKEN is not an Access token/.test(error.message) && !error.message.includes("SECRET"));
  const noisy = spawn({ status: 0, stdout: "eyJhbGc.SECRETPAYLOAD.sig trailing\n", stderr: "" });
  assert.throws(() => accessToken("https://os.example.com", { env: {}, spawn: noisy }),
    (error: Error) => /cloudflared printed no token/.test(error.message) && !error.message.includes("SECRET"));
});

function sessionDeps(t: { after: (fn: () => void) => void }, env: NodeJS.ProcessEnv, options: FixtureOptions = {}) {
  const log = serverLog();
  const server = messagePortServer(log, () => fixtureRoot(log, options));
  t.after(() => server.close());
  const spawned: string[][] = [];
  const deps: SessionDeps = {
    env,
    open: server.open,
    spawn: (command, args) => {
      spawned.push([command, ...args]);
      return { status: 0, stdout: "from.cloudflared.token\n", stderr: "" };
    },
    fetch: async () => assert.fail("fetched with the connection open"),
  };
  return { log, deps, spawned };
}

const target = { origin: "https://os.example.com", url: "wss://os.example.com/api" };

test("Access mode sends Origin and cf-access-token, then authenticateFromCfAccess", async (t) => {
  const { log, deps, spawned } = sessionDeps(t, {});
  const session = await connect(target, { mode: "access" }, { serviceSalt: SALT, needsSignIn: true }, deps);
  const { api } = await session.authenticate();
  assert.deepEqual(await api.findNotes("q"), [{ id: 1, title: "q" }]);
  api[Symbol.dispose]();
  session.main[Symbol.dispose]();
  assert.deepEqual(log.headers,
    [{ Origin: "https://os.example.com", "User-Agent": USER_AGENT, "cf-access-token": "from.cloudflared.token" }]);
  assert.deepEqual(spawned, [["cloudflared", "access", "token", "-app=https://os.example.com"]]);
  assert.deepEqual(callsOf(log, "authenticateFromCfAccess"), [[]]);
  assert.deepEqual(callsOf(log, "authenticate"), []);
});

test("token mode authenticates with CFOS_API_TOKEN; a public chain needs no token", async (t) => {
  const { log, deps, spawned } = sessionDeps(t, { CFOS_API_TOKEN: "good-token" });
  const session = await connect(target, { mode: "token" }, { serviceSalt: SALT, needsSignIn: true }, deps);
  const { api } = await session.authenticate();
  assert.deepEqual(await api.findNotes("q"), [{ id: 1, title: "q" }]);
  session.main[Symbol.dispose]();
  assert.deepEqual(log.headers, [{ Origin: "https://os.example.com", "User-Agent": USER_AGENT }]);
  assert.deepEqual(callsOf(log, "authenticate"), [["good-token"]]);
  assert.deepEqual(spawned, []);

  const bare = sessionDeps(t, {});
  await assert.rejects(connect(target, { mode: "token" }, { serviceSalt: SALT, needsSignIn: true }, bare.deps), /reads the secret from CFOS_API_TOKEN/);
  const publicSession = await connect(target, { mode: "token" }, { serviceSalt: SALT, needsSignIn: false }, bare.deps);
  await publicSession.main.ping();
  publicSession.main[Symbol.dispose]();
});

test("password mode logs in with the argon2id hash, then authenticates with the token it returns", async (t) => {
  const hashHex = Buffer.from(await passwordHash("alice", "s3cret", SALT)).toString("hex");
  const { log, deps } = sessionDeps(t, { CFOS_API_PASSWORD: "s3cret" }, { login: { username: "alice", hashHex } });
  const session = await connect(target, { mode: "password", username: "alice" }, { serviceSalt: SALT, needsSignIn: true }, deps);
  const { api } = await session.authenticate();
  assert.deepEqual(await api.findNotes("q"), [{ id: 1, title: "q" }]);
  session.main[Symbol.dispose]();
  assert.deepEqual(callsOf(log, "login"), [["alice", hashHex]]);
  assert.deepEqual(callsOf(log, "authenticate"), [["good-token"]]);

  const wrong = sessionDeps(t, { CFOS_API_PASSWORD: "guess" }, { login: { username: "alice", hashHex } });
  const refused = await connect(target, { mode: "password", username: "alice" }, { serviceSalt: SALT, needsSignIn: true }, wrong.deps);
  await assert.rejects(refused.authenticate(), /wrong username or password for alice/);
  refused.main[Symbol.dispose]();
  assert.deepEqual(callsOf(wrong.log, "authenticate"), []);
});

/**
 * A local server refusing every WebSocket upgrade, recording its headers, and answering plain
 * requests with `status` (and `location`), as Access's edge answers an unauthenticated request.
 */
async function refusingServer(t: { after: (fn: () => void) => void }, status: number, location?: string) {
  const upgrades: IncomingHttpHeaders[] = [];
  const requests: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    requests.push(request.headers);
    response.writeHead(status, location ? { location } : {}).end();
  });
  server.on("upgrade", (request, socket) => {
    upgrades.push(request.headers);
    socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, upgrades, requests };
}

test("a refused WebSocket is diagnosed over HTTP: Access's login names cloudflared access login", async (t) => {
  const { origin, upgrades, requests } = await refusingServer(t, 302, "https://team.cloudflareaccess.com/cdn-cgi/access/login/os");
  const local = { origin, url: `${origin.replace("http:", "ws:")}/api` };
  const deps: SessionDeps = {
    env: { CF_ACCESS_TOKEN: "env.access.token" },
    open: webSocketConnection,
    spawn: () => assert.fail("spawned cloudflared with CF_ACCESS_TOKEN set"),
    fetch,
  };
  const session = await connect(local, { mode: "access" }, { serviceSalt: SALT, needsSignIn: true }, deps);
  const failure = await (await session.authenticate()).api.then(() => assert.fail("connected"), (error: unknown) => error);
  const explained = await session.explain(failure) as Error;
  session.main[Symbol.dispose]();
  assert.match(explained.message, new RegExp(`redirected to Cloudflare Access's login: run \`cloudflared access login ${origin}\``));
  assert.equal(upgrades[0].origin, origin);
  assert.equal(upgrades[0]["cf-access-token"], "env.access.token");
  assert.equal(requests[0]["cf-access-token"], "env.access.token");
  // The Workshop knows the CLI by it, on the WebSocket and the request diagnosing its refusal alike.
  assert.equal(upgrades[0]["user-agent"], USER_AGENT);
  assert.equal(requests[0]["user-agent"], USER_AGENT);
});

test("the User-Agent is cf-os-api/<this package's version>", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(USER_AGENT, `cf-os-api/${manifest.version}`);
});

test("a 401 for a token sign-in names the token, not cloudflared", async (t) => {
  const { origin } = await refusingServer(t, 401);
  const local = { origin, url: `${origin.replace("http:", "ws:")}/api` };
  const deps: SessionDeps = { env: { CFOS_API_TOKEN: "t" }, open: webSocketConnection, spawn: () => assert.fail("spawned"), fetch };
  const session = await connect(local, { mode: "token" }, { serviceSalt: SALT, needsSignIn: true }, deps);
  const failure = await (await session.authenticate()).api.then(() => assert.fail("connected"), (error: unknown) => error);
  const explained = await session.explain(failure) as Error;
  session.main[Symbol.dispose]();
  assert.match(explained.message, /refused with HTTP 401: check CFOS_API_TOKEN/);
  assert.doesNotMatch(explained.message, /cloudflared/);
});
