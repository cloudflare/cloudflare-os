import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
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
  probePlainHttp,
  webSocketConnection,
  type PortProbe,
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

  // cloudflared could not reach the origin: an instance that could not be reached (exit 1), not a missing login.
  const down = spawn({ status: 1, stdout: "", stderr: 'failed to get app info: Head "https://os.example.com": dial tcp: lookup os.example.com: no such host' });
  assert.throws(() => accessToken("https://os.example.com", { env: {}, spawn: down }), (error: Error) => !(error instanceof UsageError) &&
    /^could not reach https:\/\/os\.example\.com \(failed to get app info: .*no such host\)\. Check that the instance is up/.test(error.message) &&
    !error.message.includes("cloudflared access login"));
});

test("cloudflared's timeout reaching a listening origin is not told to start it: the port probe says what is likely", async () => {
  const timeout = 'failed to get app info: Head "https://localhost:8787": context deadline exceeded (Client.Timeout exceeded while awaiting headers)';
  const reasonFor = async (stderr: string, found: PortProbe | undefined, origin = "https://localhost:8787") => {
    const deps: SessionDeps = {
      env: {},
      open: () => assert.fail("opened"),
      spawn: () => ({ status: 1, stdout: "", stderr }),
      fetch: async () => assert.fail("fetched"),
      probe: async () => found ?? assert.fail("probed"),
    };
    const target = { origin, url: `${origin.replace(/^http/, "ws")}/api` };
    const error = await connect(target, { mode: "access" }, { serviceSalt: SALT, needsSignIn: true }, deps).then(() => assert.fail("connected"), (e: Error) => e);
    assert.ok(!(error instanceof UsageError));
    return error.message;
  };
  assert.equal(await reasonFor(timeout, { kind: "http", status: 404 }),
    `could not reach https://localhost:8787 (${timeout}): localhost:8787 answers plain HTTP, not HTTPS. Use --url http://localhost:8787.`);
  assert.equal(await reasonFor(timeout, { kind: "silent" }),
    `could not reach https://localhost:8787 (${timeout}): something is listening at localhost:8787 but did not answer as an ` +
    "instance does. It may be slow or hung, or another server: check it, or name another with --url <origin>.");
  // Nothing listening, by the probe or by what cloudflared says (unprobed), is still to start the instance.
  assert.match(await reasonFor(timeout, { kind: "closed" }), /\. Start the instance \(`pnpm dev-server` serves/);
  assert.match(await reasonFor("dial tcp [::1]:8787: connect: connection refused", undefined), /\. Start the instance \(`pnpm dev-server` serves/);

  // A TLS failure from a server that answered is no missing login (exit 1, not 2): a plain-HTTP server, whatever its
  // status, a certificate cloudflared refuses (unprobed), or another failed handshake.
  const notTls = 'failed to get app info: Head "https://localhost:8787": tls: first record does not look like a TLS handshake';
  assert.equal(await reasonFor(notTls, { kind: "http", status: 400 }),
    `could not reach https://localhost:8787 (${notTls}): localhost:8787 answers plain HTTP, not HTTPS. Use --url http://localhost:8787.`);
  assert.match(await reasonFor(notTls, { kind: "silent" }), /: something is listening at localhost:8787 but does not speak TLS, nor answer plain HTTP/);
  const selfSigned = 'failed to get app info: Head "https://localhost:8787": tls: failed to verify certificate: x509: certificate signed by unknown authority';
  const refused = await reasonFor(selfSigned, undefined);
  assert.match(refused, /: localhost:8787 speaks TLS, but cloudflared refused its certificate\. Check the origin; .*--auth token/);
  assert.doesNotMatch(refused, /cloudflared access login|Start the instance/);
  const alert = 'failed to get app info: Head "https://localhost:8787": remote error: tls: handshake failure';
  assert.match(await reasonFor(alert, { kind: "silent" }), /: something is listening at localhost:8787, but the TLS handshake with it failed/);
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
    probe: async () => assert.fail("probed with the connection open"),
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
    probe: probePlainHttp,
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
  const deps: SessionDeps = { env: { CFOS_API_TOKEN: "t" }, open: webSocketConnection, spawn: () => assert.fail("spawned"), fetch, probe: probePlainHttp };
  const session = await connect(local, { mode: "token" }, { serviceSalt: SALT, needsSignIn: true }, deps);
  const failure = await (await session.authenticate()).api.then(() => assert.fail("connected"), (error: unknown) => error);
  const explained = await session.explain(failure) as Error;
  session.main[Symbol.dispose]();
  assert.match(explained.message, /refused with HTTP 401: check CFOS_API_TOKEN/);
  assert.doesNotMatch(explained.message, /cloudflared/);
});

test("http:// is for a local instance only: a plain-text sign-in to any other host is refused, naming https://", () => {
  for (const url of ["http://localhost:8787", "http://127.0.0.5:9", "http://[::1]:8787", "http://app.localhost:8787", "http://LOCALHOST:1"]) {
    assert.equal(resolveTarget(url, {}).origin, new URL(url).origin, url);
  }
  const plain = (error: unknown) => error instanceof UsageError && error.message.startsWith(
    "--url http://os.example.com would send credentials in plain text: use https://os.example.com. http:// is for a local instance only");
  assert.throws(() => resolveTarget("http://os.example.com", {}), plain);
  assert.throws(() => resolveTarget(undefined, { CFOS_API_URL: "http://10.0.0.1:8787" }),
    (error: unknown) => error instanceof UsageError && error.message.startsWith("CFOS_API_URL http://10.0.0.1:8787 would send credentials in plain text"));
  // A failure never repeats credentials embedded in the URL.
  assert.throws(() => resolveTarget("ftp://user:hunter2@os.example.com", {}), (error: Error) => !error.message.includes("hunter2"));
  for (const url of ["https://u:hunter2@exa mple.com", "https://u:hun/ter2@exa mple.com", "https://exa mple.com/?token=hunter2"]) {
    assert.throws(() => resolveTarget(undefined, { CFOS_API_URL: url }), (error: Error) => error instanceof UsageError &&
      error.message.startsWith("CFOS_API_URL https://exa mple.com") && error.message.includes("is not a URL") && !error.message.includes("hunter2"), url);
  }
  // A scheme-less `user:secret@host` parses as a URL whose scheme is `user` and has no host: what it
  // shows is no more than what follows the `@`.
  for (const url of ["a1b2c3d4e5f6:x-oauth-basic@os.example.com", "admin:hunter2@os.example.com"]) {
    for (const [given, env, source] of [[url, {}, "--url"], [undefined, { CFOS_API_URL: url }, "CFOS_API_URL"]] as const) {
      assert.throws(() => resolveTarget(given, env), (error: Error) => error instanceof UsageError &&
        error.message.startsWith(`${source} os.example.com is not an origin`) && !/a1b2|oauth|admin|hunter2/.test(error.message), url);
    }
  }
  // An `@` in a query or fragment, or a `?` in a password, shows no more than the scheme.
  for (const url of ["https://exa mple.com/?token=alice@hunter2", "https://exa mple.com/#a@hunter2", "https://u:hun?ter2@exa mple.com"]) {
    assert.throws(() => resolveTarget(undefined, { CFOS_API_URL: url }), (error: Error) => error instanceof UsageError &&
      error.message.startsWith("CFOS_API_URL https://… is not a URL") && !/hunter2|hun|ter2/.test(error.message), url);
  }
});

test("a credential missing from the environment is a usage error: nothing was sent", async (t) => {
  const bare = sessionDeps(t, {});
  await assert.rejects(connect(target, { mode: "token" }, { serviceSalt: SALT, needsSignIn: true }, bare.deps),
    (error: Error) => error instanceof UsageError && /reads the secret from CFOS_API_TOKEN, which is not set/.test(error.message));
  await assert.rejects(connect(target, { mode: "password", username: "a" }, { serviceSalt: SALT, needsSignIn: true }, bare.deps),
    (error: Error) => error instanceof UsageError && /reads the secret from CFOS_API_PASSWORD/.test(error.message));
  assert.throws(() => accessToken("https://os.example.com", { env: {}, spawn: () => ({ status: 1, stdout: "", stderr: "no token" }) }), UsageError);
  assert.equal(bare.log.headers.length, 0);
});

test("an instance that cannot be reached is named with the cause, and the next step", async () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED ::1:8799"), { code: "ECONNREFUSED" });
  const notFound = Object.assign(new Error("getaddrinfo ENOTFOUND os.example.com"), { code: "ENOTFOUND" });
  const unreachable = (origin: string, cause: Error) => {
    const deps: SessionDeps = {
      env: { CFOS_API_TOKEN: "t" },
      open: () => ({ main: {}, opened: () => false }),
      spawn: () => assert.fail("spawned"),
      fetch: async () => {
        throw new TypeError("fetch failed", { cause });
      },
      // No server is there, which the request's code says: no probe is needed to tell.
      probe: async () => ({ kind: "closed" }),
    };
    const url = new URL("/api", origin);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    return connect({ origin, url: url.href }, { mode: "token" }, { serviceSalt: SALT, needsSignIn: true }, deps)
      .then(async (session) => (await session.explain(new Error("WebSocket error")) as Error).message);
  };
  // localhost has two addresses, so its refusal is an AggregateError with no message of its own.
  assert.equal(await unreachable("http://localhost:8799", new AggregateError([refused], "")),
    "could not reach ws://localhost:8799/api (connect ECONNREFUSED ::1:8799): nothing is listening there. " +
    "Start the instance (`pnpm dev-server` serves http://localhost:8787), or name another with --url <origin>.");
  assert.equal(await unreachable("https://os.example.com", notFound),
    "could not reach wss://os.example.com/api (getaddrinfo ENOTFOUND os.example.com). " +
    "Check that the instance is up and its origin right, or name another with --url <origin>.");
});

/**
 * What `session.explain` says of a WebSocket that never opened to `origin`, given what the plain
 * request (`fetch`) and the port probe (`probe`) meet.
 */
async function explanation(origin: string, fetch: SessionDeps["fetch"], probe: SessionDeps["probe"]): Promise<string> {
  const deps: SessionDeps = { env: { CFOS_API_TOKEN: "t" }, open: () => ({ main: {}, opened: () => false }), spawn: () => assert.fail("spawned"), fetch, probe };
  const url = new URL("/api", origin);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const session = await connect({ origin, url: url.href }, { mode: "token" }, { serviceSalt: SALT, needsSignIn: true }, deps);
  return (await session.explain(new Error("WebSocket error")) as Error).message;
}

/** A request that waits until it is aborted, then fails as `fetch` does: a TLS handshake a plain server never answers. */
const hanging: SessionDeps["fetch"] = (_url, { signal }) => new Promise((_resolve, reject) => {
  signal.addEventListener("abort", () => reject(new TypeError("fetch failed", { cause: signal.reason })));
});

test("an instance that is up but does not answer is not told to be started: the port probe says what is likely", async () => {
  const probing = (found: PortProbe): SessionDeps["probe"] => async () => found;
  const timedOut: SessionDeps["fetch"] = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  // https:// against a local server speaking plain http: said at once, without waiting for the request.
  const started = Date.now();
  assert.equal(await explanation("https://localhost:8787", hanging, probing({ kind: "http", status: 404 })),
    "could not reach wss://localhost:8787/api: localhost:8787 answers plain HTTP, not HTTPS. Use --url http://localhost:8787.");
  assert.ok(Date.now() - started < 1000, "waited for the request");
  // Another host may not be named with http://, so its port is the one to check.
  assert.equal(await explanation("https://os.example.com:8443", hanging, probing({ kind: "http", status: 200 })),
    "could not reach wss://os.example.com:8443/api: os.example.com:8443 answers plain HTTP, not HTTPS. " +
    "Check the origin's port, or name another with --url <origin>.");
  // A TLS server answers a plain request with 400, which says nothing of plain HTTP; nor does a silent port.
  for (const found of [{ kind: "http", status: 400 }, { kind: "silent" }] as PortProbe[]) {
    assert.equal(await explanation("https://localhost:8787", timedOut, probing(found)),
      "could not reach wss://localhost:8787/api (no answer in 10 s): something is listening at localhost:8787 but did not " +
      "answer as an instance's API does. It may be slow or hung, or another server: check it, or name another with --url <origin>.");
  }
  // Nor does a redirect, which a TLS server may give a plain request (to https://): the HTTPS answer is the one told.
  const badGateway: SessionDeps["fetch"] = async () => ({ status: 502, headers: { get: () => null } });
  assert.equal(await explanation("https://localhost:8443", badGateway, probing({ kind: "http", status: 301 })),
    "could not open wss://localhost:8443/api (HTTP 502): WebSocket error");
  assert.doesNotMatch(await explanation("https://localhost:8443", timedOut, probing({ kind: "http", status: 301 })), /answers plain HTTP/);
  // A failed handshake is named by its cause; a plain http:// origin is never said to want http://.
  const tls: SessionDeps["fetch"] = async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }) });
  };
  for (const found of [{ kind: "http", status: 400 }, { kind: "silent" }] as PortProbe[]) {
    assert.equal(await explanation("https://localhost:8787", tls, probing(found)),
      "could not reach wss://localhost:8787/api (self-signed certificate): localhost:8787 speaks TLS, but its certificate was " +
      "refused. Check the origin; for a certificate you trust that Node does not (a local instance's own), set " +
      "NODE_EXTRA_CA_CERTS to its authority's PEM file. Or name another with --url <origin>.");
  }
  // Another TLS failure is a failed handshake, not a slow or hung instance.
  const handshake: SessionDeps["fetch"] = async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("unsupported protocol"), { code: "ERR_SSL_UNSUPPORTED_PROTOCOL" }) });
  };
  assert.equal(await explanation("https://os.example.com", handshake, probing({ kind: "silent" })),
    "could not reach wss://os.example.com/api (unsupported protocol): something is listening at os.example.com, but the TLS " +
    "handshake with it failed. Check the origin and its TLS setup, or name another with --url <origin>.");
  // https://'s default port is named in the http:// to use, which would otherwise mean port 80.
  assert.equal(await explanation("https://localhost", hanging, probing({ kind: "http", status: 404 })),
    "could not reach wss://localhost/api: localhost answers plain HTTP, not HTTPS. Use --url http://localhost:443.");
  assert.doesNotMatch(await explanation("http://localhost:8787", timedOut, probing({ kind: "http", status: 200 })), /answers plain HTTP|Start the instance/);
  // Nothing accepting a connection is nothing there: then starting the instance is the next step.
  assert.equal(await explanation("http://localhost:8787", timedOut, probing({ kind: "closed" })),
    "could not reach ws://localhost:8787/api (no answer in 10 s): nothing answered at localhost:8787. " +
    "Start the instance (`pnpm dev-server` serves http://localhost:8787), or name another with --url <origin>.");
});

test("a port that answers TLS with something else is said to speak no TLS, its cause on one line", async () => {
  const probing = (found: PortProbe): SessionDeps["probe"] => async () => found;
  // OpenSSL's text, as Node's fetch gives it: one line of codes and a source file, ending in a newline.
  const wrongVersion: SessionDeps["fetch"] = async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("80BF740402000000:error:0A00010B:SSL routines:" +
      "tls_validate_record_header:wrong version number:../deps/openssl/openssl/ssl/record/methods/tlsany_meth.c:78:\n"),
    { code: "ERR_SSL_WRONG_VERSION_NUMBER" }) });
  };
  assert.equal(await explanation("https://127.0.0.1:18912", wrongVersion, probing({ kind: "silent" })),
    "could not reach wss://127.0.0.1:18912/api (wrong version number): something is listening at 127.0.0.1:18912 but does " +
    "not speak TLS, nor answer plain HTTP: it is not an instance. Check the origin's port, or name another with --url <origin>.");
  // One that speaks no TLS and answers HTTP serves plain HTTP, even with the 400 a TLS server gives a plain request.
  assert.equal(await explanation("https://localhost:8787", wrongVersion, probing({ kind: "http", status: 400 })),
    "could not reach wss://localhost:8787/api (wrong version number): localhost:8787 answers plain HTTP, not HTTPS. " +
    "Use --url http://localhost:8787.");
  // Nothing there by the time of the probe is nothing there.
  assert.match(await explanation("https://localhost:8787", wrongVersion, probing({ kind: "closed" })), /nothing answered at localhost:8787\. Start the instance/);
  // Any other cause is put on one line too.
  const multiLine: SessionDeps["fetch"] = async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("first line\n  second line\n"), { code: "EOTHER" }) });
  };
  assert.match(await explanation("https://localhost:8787", multiLine, probing({ kind: "silent" })), /^could not reach wss:\/\/localhost:8787\/api \(first line second line\): /);
});

test("a real listener that answers TLS with garbage is said to speak no TLS, through the real request and probe", async (t) => {
  const garbage = createNetServer((socket) => {
    socket.on("error", () => {});
    socket.on("data", () => socket.write("garbage\n"));
  });
  garbage.listen(0, "127.0.0.1");
  await once(garbage, "listening");
  t.after(() => garbage.close());
  const host = `127.0.0.1:${(garbage.address() as AddressInfo).port}`;
  const message = await explanation(`https://${host}`, fetch, probePlainHttp);
  assert.equal(message, `could not reach wss://${host}/api (wrong version number): something is listening at ${host} but does ` +
    "not speak TLS, nor answer plain HTTP: it is not an instance. Check the origin's port, or name another with --url <origin>.");
});

test("https:// against a real plain-HTTP server is diagnosed as such, through the real WebSocket, request and probe", async (t) => {
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const deps: SessionDeps = { env: { CFOS_API_TOKEN: "t" }, open: webSocketConnection, spawn: () => assert.fail("spawned"), fetch, probe: probePlainHttp };
  const session = await connect({ origin: `https://${host}`, url: `wss://${host}/api` }, { mode: "token" }, { serviceSalt: SALT, needsSignIn: true }, deps);
  const failure = await (await session.authenticate()).api.then(() => assert.fail("connected"), (error: unknown) => error);
  const message = (await session.explain(failure) as Error).message;
  session.main[Symbol.dispose]();
  assert.match(message, new RegExp(`^could not reach wss://${host}/api(?: \\([^)]*\\))?: ${host} answers plain HTTP, not HTTPS\\. Use --url http://${host}\\.$`));
});

test("the port probe tells a plain HTTP server, a silent port and a closed one apart", async (t) => {
  const http = createServer((_request, response) => response.writeHead(418).end());
  const silent = createNetServer(() => {});
  // A status line that arrives in pieces is still one.
  const split = createNetServer((socket) => {
    socket.write("HTTP/1.1 4");
    setTimeout(() => socket.end("04 Not Found\r\n\r\n"), 20);
  });
  const tls = createNetServer((socket) => socket.end(Buffer.from([0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x46])));
  for (const server of [http, silent, split, tls]) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  t.after(() => {
    http.closeAllConnections();
    http.close();
    for (const server of [silent, split, tls]) server.close();
  });
  const port = (server: { address(): unknown }) => (server.address() as AddressInfo).port;
  assert.deepEqual(await probePlainHttp("127.0.0.1", port(http), 2000), { kind: "http", status: 418 });
  assert.deepEqual(await probePlainHttp("127.0.0.1", port(silent), 200), { kind: "silent" });
  assert.deepEqual(await probePlainHttp("127.0.0.1", port(split), 2000), { kind: "http", status: 404 });
  assert.deepEqual(await probePlainHttp("127.0.0.1", port(tls), 2000), { kind: "silent" });
  const closed = createNetServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const free = port(closed);
  closed.close();
  await once(closed, "close");
  assert.deepEqual(await probePlainHttp("127.0.0.1", free, 2000), { kind: "closed" });
});
