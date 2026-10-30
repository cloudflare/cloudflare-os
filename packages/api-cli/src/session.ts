// Connecting `cf-os api` to an instance: where its API is, which credential to present, and the
// Cap'n Web session over its `/api` WebSocket.
//
// The backend (packages/workshop-backend/src/server.ts) serves the API at `/api`. Behind Access it
// requires the request's Origin to be its own and a valid Access JWT, which Access's edge derives
// from a `cf-access-token` header; the session then authenticates with `authenticateFromCfAccess()`.
// A dev server has neither check, and signs in with a token or a password instead. Secrets come from
// the environment or `cloudflared`, never from argv. Without `--url`, the instance is the one the
// environment names ({@link defaultInstance}): a caller such as cloudflare-os-starter's `cf-os api`
// names its deployment's, and otherwise it is the local dev server.

import { spawnSync } from "node:child_process";
import { connect as connectSocket } from "node:net";
import { newWebSocketRpcSession } from "capnweb";
import { UsageError } from "./output.ts";

/** How the session signs in. */
export type AuthMode = "access" | "token" | "password";

/** The modes `--auth` accepts. */
export const AUTH_MODES: readonly AuthMode[] = ["access", "token", "password"];

/** The sign-in a session makes, without its secret. */
export interface AuthChoice {
  mode: AuthMode;
  /** `--username`, for `password`. */
  username?: string;
}

/** Where the API is. */
export interface ApiTarget {
  /** The instance's origin, `https://os.example.com`: the Origin header and Access's app. */
  origin: string;
  /** The API's WebSocket URL, `wss://os.example.com/api`. */
  url: string;
}

/**
 * A capability on the far side, as the runtime hands it around: untyped, because the command table,
 * not TypeScript, says what it offers.
 */
export type Remote = any;

/** An open transport. */
export interface Connection {
  /** The peer's main capability (`PublicApi`). Disposing it closes the connection. */
  main: Remote;
  /** Whether the transport ever opened: a failure before it did is diagnosed over plain HTTP. */
  opened(): boolean;
}

/** Opens a session to `url`, sending `headers` with the upgrade. Swapped out by tests. */
export type OpenConnection = (url: string, headers: Record<string, string>) => Connection;

/** What of `spawnSync` the Access mode uses to ask `cloudflared` for a token. */
export type SpawnCloudflared = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; env: NodeJS.ProcessEnv; timeout?: number },
) => { status: number | null; stdout: string; stderr: string; error?: Error };

/** What of `fetch` a failed handshake is diagnosed with. */
export type FetchStatus = (
  url: string,
  init: { headers: Record<string, string>; redirect: "manual"; signal: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

/**
 * What a plain-text HTTP request to `host`:`port` met, within `timeoutMs`: no connection (`closed`),
 * a connection that answered with an HTTP status line (`http`), or one that answered nothing such
 * (`silent`), as a TLS server, or a hung one, does.
 */
export type PortProbe = { kind: "closed" } | { kind: "silent" } | { kind: "http"; status: number };

/** Probes a port with a plain-text HTTP request ({@link PortProbe}); never rejects. Swapped out by tests. */
export type ProbePort = (host: string, port: number, timeoutMs: number) => Promise<PortProbe>;

/** What connecting needs from the world. */
export interface SessionDeps {
  env: NodeJS.ProcessEnv;
  open: OpenConnection;
  spawn: SpawnCloudflared;
  fetch: FetchStatus;
  probe: ProbePort;
}

/** The real transport: Node's WebSocket, which takes request headers, under capnweb. */
export const webSocketConnection: OpenConnection = (url, headers) => {
  // Node's WebSocket (undici) takes `{ headers }` where the DOM's takes protocols.
  const socket = new WebSocket(url, { headers } as unknown as string[]);
  let opened = false;
  socket.addEventListener("open", () => {
    opened = true;
  });
  return { main: newWebSocketRpcSession(socket), opened: () => opened };
};

/**
 * The real probe: a TCP connection sending `HEAD /` in plain text, with no credentials, read up to
 * its status line.
 */
export const probePlainHttp: ProbePort = (host, port, timeoutMs) => new Promise((resolve) => {
  let connected = false;
  let head = "";
  const socket = connectSocket({ host, port });
  const done = (probe?: PortProbe) => {
    clearTimeout(timer);
    socket.destroy();
    resolve(probe ?? (connected ? { kind: "silent" } : { kind: "closed" }));
  };
  const timer = setTimeout(done, timeoutMs);
  socket.on("connect", () => {
    connected = true;
    socket.write(`HEAD / HTTP/1.1\r\nHost: ${host.includes(":") ? `[${host}]` : host}:${port}\r\nConnection: close\r\n\r\n`);
  });
  socket.on("data", (chunk: Buffer) => {
    head += chunk.toString("latin1");
    const status = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head);
    if (status) done({ kind: "http", status: Number(status[1]) });
    // Bytes that cannot start a status line (a TLS alert), or a line too long for one, are no HTTP answer.
    else if (head.length >= 16 || !"HTTP/".startsWith(head.slice(0, 5))) done();
  });
  socket.on("error", () => done());
  socket.on("close", () => done());
});

/** The world as it is: process environment, real WebSocket, `cloudflared` on PATH, `fetch`, a TCP probe. */
export function defaultSessionDeps(): SessionDeps {
  return { env: process.env, open: webSocketConnection, spawn: spawnSync, fetch, probe: probePlainHttp };
}

/** Where cloudflare-os's `pnpm dev-server` listens: the default instance when the environment names none. */
export const DEV_SERVER_URL = "http://localhost:8787";

/** The instance a run calls without `--url`, as the environment makes it. */
export type DefaultInstance =
  | { kind: "url"; url: string; from: "CFOS_API_URL" | "dev-server" }
  | { kind: "unavailable"; reason: string };

/**
 * The instance a run without `--url` calls. `CFOS_API_URL` is how a caller names it:
 * cloudflare-os-starter's `cf-os` is to set it to its deployment's public origin, and anyone may
 * set it for a fixed instance. It is held only to what `--url` is (http:// for a local instance
 * only, a path dropped), so a caller naming a deployment checks first that its origin is https://
 * and exactly an origin. `CFOS_API_URL_UNAVAILABLE` is how a caller with no instance says why, in a
 * message that names `--url`: the starter's case when its deployment file is unreadable, names no origin, is not
 * configured, or names one that is not an https:// origin. A caller sets exactly one of the two, so
 * it never falls back to the dev server. Empty values count as unset.
 */
export function defaultInstance(env: NodeJS.ProcessEnv): DefaultInstance {
  if (env.CFOS_API_URL) return { kind: "url", url: env.CFOS_API_URL, from: "CFOS_API_URL" };
  if (env.CFOS_API_URL_UNAVAILABLE) return { kind: "unavailable", reason: env.CFOS_API_URL_UNAVAILABLE };
  return { kind: "url", url: DEV_SERVER_URL, from: "dev-server" };
}

/**
 * The API's location: `--url` when given (an `http://` one only for a local instance), else the
 * default instance ({@link defaultInstance}). With none, the caller's reason is the whole failure.
 * api.ts calls it only for a run that needs an instance, after help, search and types have
 * returned, so `CFOS_API_URL_UNAVAILABLE` fails exactly those runs.
 */
export function resolveTarget(url: string | undefined, env: NodeJS.ProcessEnv): ApiTarget {
  if (url !== undefined) return parseTarget(url, "--url");
  const instance = defaultInstance(env);
  if (instance.kind === "unavailable") throw new UsageError(instance.reason);
  return instance.from === "CFOS_API_URL" ? parseTarget(instance.url, "CFOS_API_URL") : targetFor(instance.url);
}

/**
 * `url` as a target, or a usage error naming where it came from (`source`) and the URL, shown
 * without any credentials in it. `http://` is refused but for a local instance
 * ({@link isLocalHost}): a sign-in over it would carry its token or password hash in plain text.
 */
function parseTarget(url: string, source: string): ApiTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`${source} ${redacted(url)} is not a URL. Give the instance's origin, such as https://os.example.com.`);
  }
  // A scheme-less `user:secret@host` parses too, as scheme `user` with no host, so a value with no
  // host is shown as one that is not a URL: its scheme may be a credential.
  if (!parsed.host) {
    throw new UsageError(`${source} ${redacted(url)} is not an origin. Give the instance's scheme and host, such as https://os.example.com.`);
  }
  const shown = `${parsed.protocol}//${parsed.host}`;
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UsageError(`${source} ${shown} must be an https:// origin (http:// for a local instance).`);
  }
  if (parsed.protocol === "http:" && !isLocalHost(parsed.hostname)) {
    throw new UsageError(`${source} ${shown} would send credentials in plain text: use https://${parsed.host}. ` +
      "http:// is for a local instance only (localhost, *.localhost, 127.0.0.0/8 or [::1]).");
  }
  return targetFor(parsed.origin);
}

/**
 * `url`, a value not read as an origin, shown as far as it can be without what may be credentials:
 * anything up to an `@`, a query or a fragment. An `@` can stand on either side of a `?` or `#` (a
 * password holding one, a query holding an address), so when the two readings differ only the
 * scheme is shown.
 */
function redacted(url: string): string {
  const scheme = /^[a-z][\w+.-]*:\/\//i.exec(url)?.[0] ?? "";
  const query = /[?#][^]*$/;
  const noUser = (text: string) => text.includes("@") ? `${scheme}${text.slice(text.lastIndexOf("@") + 1)}` : text;
  const plain = noUser(url.replace(query, ""));
  return plain === noUser(url).replace(query, "") ? plain : `${scheme}…`;
}

/** Whether `hostname`, a URL's, is this machine: where plain `http://` reaches no network. */
function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

function targetFor(origin: string): ApiTarget {
  const url = new URL("/api", origin);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return { origin, url: url.href };
}

/**
 * The sign-in to make at `origin`: `--auth` when given, else inferred. `--username` means a password;
 * a `CFOS_API_TOKEN` in the environment means a token; otherwise Access, a deployment's default, for
 * an https:// origin, and a token for an http:// one (a dev server, which Access never fronts; a
 * `public` chain needs none).
 */
export function resolveAuth(flags: { auth?: string; username?: string }, env: NodeJS.ProcessEnv, origin: string): AuthChoice {
  const { auth, username } = flags;
  if (auth !== undefined && !AUTH_MODES.includes(auth as AuthMode)) {
    throw new UsageError(`--auth must be one of ${AUTH_MODES.join(", ")}; got "${auth}".`);
  }
  const plain = origin.startsWith("http:");
  if (auth === "access" && plain) {
    throw new UsageError(`--auth access sends a Cloudflare Access token, which ${origin} would carry in plain text; ` +
      "Access fronts https:// origins only.");
  }
  const mode = (auth as AuthMode | undefined) ??
    (username !== undefined ? "password" : env.CFOS_API_TOKEN || plain ? "token" : "access");
  if (mode === "password") {
    if (!username) throw new UsageError("--auth password needs --username <name>; the password comes from CFOS_API_PASSWORD.");
    return { mode, username };
  }
  if (username !== undefined) throw new UsageError(`--username is for --auth password, not ${mode}.`);
  return { mode };
}

/**
 * argon2id of `password`, as the frontend hashes it (packages/workshop-frontend/src/passwordHash.ts):
 * salt `SERVICE_SALT` ++ utf8(username), one lane, three passes, 64 MiB, 32 bytes. The server stores
 * and compares these bytes as they are, so any other parameters are a wrong password.
 */
export async function passwordHash(username: string, password: string, serviceSalt: readonly number[]): Promise<Uint8Array> {
  const { argon2id } = await import("hash-wasm");
  const name = new TextEncoder().encode(username);
  const salt = new Uint8Array(serviceSalt.length + name.length);
  salt.set(serviceSalt);
  salt.set(name, serviceSalt.length);
  return argon2id({
    password,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 65536,
    hashLength: 32,
    outputType: "binary",
  });
}

/** The command that signs `cloudflared` in to the instance's Access application. */
export function accessLoginHint(origin: string): string {
  return `cloudflared access login ${origin}`;
}

/** An Access token's shape: a JWT. */
const ACCESS_JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/**
 * What cloudflared's stderr says when it could not reach the origin: Go's network errors, and its TLS
 * ones, a handshake with a server that answered (a certificate it refused, or no TLS at all).
 */
const UNREACHABLE = /dial tcp|no such host|connection refused|connection reset|network is unreachable|i\/o timeout|handshake timeout|deadline exceeded|\btls: |\bx509: |server gave HTTP response to HTTPS client/i;

/** What cloudflared's stderr says when the origin's TLS server sent a certificate Go refused: x509's errors. */
const GO_CERT_REFUSED = /\bx509: /i;

/** What cloudflared's stderr says when what answered its TLS handshake was no TLS record, or was HTTP. */
const GO_NOT_TLS = /first record does not look like a TLS handshake|oversized record received|server gave HTTP response to HTTPS client/i;

/** What cloudflared's stderr says when nothing is there at all: no such host, or nothing listening. */
const NOTHING_THERE = /no such host|connection refused|network is unreachable/i;

/** cloudflared's failure to reach `origin`, as {@link accessToken} throws it; `why` is what cloudflared said. */
class CloudflaredUnreachable extends Error {
  readonly why: string;
  constructor(origin: string, why: string) {
    super(`could not reach ${origin} (${why}). ${unreachableNext(origin)}`);
    this.why = why;
  }
}

/** The next step after `origin` could not be reached: start the dev server, or name another instance. */
function unreachableNext(origin: string): string {
  return isLocalHost(new URL(origin).hostname)
    ? `Start the instance (\`pnpm dev-server\` serves ${DEV_SERVER_URL}), or name another with --url <origin>.`
    : "Check that the instance is up and its origin right, or name another with --url <origin>.";
}

/**
 * The Access token for `origin`: `CF_ACCESS_TOKEN`, else `cloudflared access token`, which prints
 * the one `cloudflared access login` saved. Spawned without a shell: the origin is an argument.
 * Throws {@link UsageError} for no token, and an Error when cloudflared could not reach `origin` or
 * ran past `timeoutMs`. cloudflared runs synchronously, which no timer can interrupt, so `timeoutMs`
 * (the run's `--timeout`) is its own: it is killed once that has passed.
 */
export function accessToken(origin: string, deps: Pick<SessionDeps, "env" | "spawn">, timeoutMs?: number): string {
  const fromEnv = deps.env.CF_ACCESS_TOKEN?.trim();
  if (fromEnv) {
    // Checked here, by name only: a value no header can carry would otherwise fail in the WebSocket
    // constructor, whose message quotes it.
    if (!ACCESS_JWT.test(fromEnv)) throw new UsageError("CF_ACCESS_TOKEN is not an Access token (a JWT, three dot-separated parts).");
    return fromEnv;
  }
  const result = deps.spawn("cloudflared", ["access", "token", `-app=${origin}`],
    { encoding: "utf8", env: deps.env, ...timeoutMs === undefined ? {} : { timeout: timeoutMs } });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error(`timed out after ${timeoutMs! / 1000}s, while cloudflared looked up the Access token for ${origin}.`);
  }
  const succeeded = result.status === 0 && !result.error;
  const token = succeeded ? result.stdout.trim().split("\n").at(-1)?.trim() ?? "" : "";
  if (ACCESS_JWT.test(token)) return token;
  // Its stdout is not repeated when it ran: whatever it printed may hold a token.
  const why = result.error
    ? `cloudflared could not run (${result.error.message})`
    : succeeded ? "cloudflared printed no token"
    : (result.stderr.trim() || `cloudflared exited with status ${result.status}`);
  // cloudflared looks the origin up before it reads a saved token, so a network or TLS error of Go's
  // is an instance that could not be reached, as diagnose says for the other modes, not a missing login.
  if (!result.error && UNREACHABLE.test(why)) {
    throw new CloudflaredUnreachable(origin, why);
  }
  // Nothing was sent: the run must wait for a login, as for a missing variable (requireEnv).
  throw new UsageError(`no Access token for ${origin}: ${why}. Run \`${accessLoginHint(origin)}\`, or set CF_ACCESS_TOKEN.`);
}

/**
 * {@link accessToken}, but when cloudflared could not reach `origin` and does not say nothing is
 * there, what it says, and a probe of its port, say what is likely, as {@link diagnose} does for the
 * other modes: starting the instance is the next step only when nothing is listening. A refused
 * certificate came from a TLS server that answered, so it is told at once, unprobed.
 */
async function probedAccessToken(origin: string, deps: Pick<SessionDeps, "env" | "spawn" | "probe">,
    timeoutMs?: number): Promise<string> {
  try {
    return accessToken(origin, deps, timeoutMs);
  } catch (error) {
    if (!(error instanceof CloudflaredUnreachable) || NOTHING_THERE.test(error.why)) throw error;
    const http = new URL(origin);
    const where = http.host;
    const failed = (next: string) => new Error(`could not reach ${origin} (${error.why}): ${next}`, { cause: error });
    if (GO_CERT_REFUSED.test(error.why)) {
      throw failed(`${where} speaks TLS, but cloudflared refused its certificate. Check the origin; an instance Access does ` +
        "not front, as a local one, signs in with --auth token or --username <name> instead (with NODE_EXTRA_CA_CERTS set to " +
        "its certificate authority's PEM file, for one Node does not trust). Or name another with --url <origin>.");
    }
    const found = await probePort(http, deps.probe);
    if (found.kind === "closed") throw error;
    // A server that is known to speak no TLS and answers HTTP serves plain HTTP, whatever its status.
    const notTls = GO_NOT_TLS.test(error.why);
    throw failed(servesPlainHttp(http.protocol === "https:", found) || (notTls && found.kind === "http")
      ? `${where} answers plain HTTP, not HTTPS. ${plainNext(http)}`
      : notTls ? `something is listening at ${where} but does not speak TLS, nor answer plain HTTP: it is not an instance. ` +
        "Check the origin's port, or name another with --url <origin>."
      : /\btls: /i.test(error.why) ? `something is listening at ${where}, but the TLS handshake with it failed. Check the ` +
        "origin and its TLS setup, or name another with --url <origin>."
      : `something is listening at ${where} but did not answer as an instance does. It may be slow or hung, or another ` +
        "server: check it, or name another with --url <origin>.");
  }
}

/**
 * The User-Agent of every request `cf-os api` makes: `cf-os-api/<version>`, the version in this
 * package's package.json (session.test.ts checks). Except on a local instance, the Workshop lets
 * a session that sends it act only as a deployment admin, a speed bump rather than a boundary.
 */
export const USER_AGENT = "cf-os-api/1.0.0";

/** A connected session, before and after signing in. */
export interface Session {
  /** `PublicApi`. Disposing it closes the connection. */
  main: Remote;
  /**
   * `AuthenticatedApi`, wrapped so that awaiting this does not await the RPC: in the Access and token
   * modes it is pipelined on `main` with nothing awaited; a password sign-in awaits `login` first.
   */
  authenticate(): Promise<{ api: Remote }>;
  /** `error` explained, when the connection never opened: the HTTP status and what to do about it. */
  explain(error: unknown): Promise<unknown>;
}

/**
 * Opens a session to `target` signed in as `auth` chooses. For `public` chains (`authenticate` never
 * called) only the transport's credential is gathered: the Access token, which Access's edge needs
 * before the request reaches the API at all. `timeoutMs`, the run's `--timeout`, bounds the Access
 * token's lookup, which blocks the run's own timer ({@link accessToken}).
 */
export async function connect(
  target: ApiTarget,
  auth: AuthChoice,
  { serviceSalt, needsSignIn, timeoutMs }: { serviceSalt: readonly number[]; needsSignIn: boolean; timeoutMs?: number },
  deps: SessionDeps,
): Promise<Session> {
  const headers: Record<string, string> = { Origin: target.origin, "User-Agent": USER_AGENT };
  let signIn: (main: Remote) => Promise<{ api: Remote }>;
  if (auth.mode === "access") {
    headers["cf-access-token"] = await probedAccessToken(target.origin, deps, timeoutMs);
    signIn = async (main) => ({ api: main.authenticateFromCfAccess() });
  } else if (auth.mode === "token") {
    const token = needsSignIn
      ? requireEnv(deps.env, "CFOS_API_TOKEN", "--auth token", " (or sign in with --username <name> and CFOS_API_PASSWORD)")
      : "";
    signIn = async (main) => ({ api: main.authenticate(token) });
  } else {
    const username = auth.username!;
    // Hashed before connecting: argon2id takes a moment, and the socket need not idle through it.
    const hash = needsSignIn
      ? await passwordHash(username, requireEnv(deps.env, "CFOS_API_PASSWORD", "--auth password"), serviceSalt)
      : new Uint8Array();
    signIn = async (main) => {
      const token: unknown = await main.login(username, hash);
      if (typeof token !== "string") throw new Error(`wrong username or password for ${username}.`);
      return { api: main.authenticate(token) };
    };
  }
  const connection = deps.open(target.url, headers);
  return {
    main: connection.main,
    authenticate: () => signIn(connection.main),
    explain: async (error) => connection.opened() ? error : diagnose(target, auth, headers, error, deps),
  };
}

/**
 * The secret in `env[name]`; unset, a usage error naming `name` and what reads it (`mode`), never a
 * value: nothing has been sent, and the run must change, given the variable, before it is tried again.
 */
export function requireEnv(env: NodeJS.ProcessEnv, name: string, mode: string, otherwise = ""): string {
  const value = env[name];
  if (!value) throw new UsageError(`${mode} reads the secret from ${name}, which is not set${otherwise}.`);
  return value;
}

/**
 * What made a request fail, under the wrappers: `fetch`'s "fetch failed" holds it as its `cause`, and
 * a host with several addresses (localhost: ::1 and 127.0.0.1) as an AggregateError with no message
 * of its own, whose first error is the first address's.
 */
function innermost(failure: unknown): { message?: string; code?: string } {
  let current = failure as (Error & { code?: string }) | undefined;
  for (let depth = 0; depth < 8; depth++) {
    const inner: unknown = current instanceof AggregateError ? current.errors[0] : current?.cause;
    if (!(inner instanceof Error)) break;
    current = inner;
  }
  // A DOMException's code is a number (a timeout's is 23): only Node's string codes name a cause.
  return { message: current?.message, code: typeof current?.code === "string" ? current.code : undefined };
}

/** How long the diagnosis waits for its answer: a host that blackholes the WebSocket may do the same to it. */
const DIAGNOSE_TIMEOUT_MS = 10_000;

/** How long the port probe ({@link PortProbe}) waits: a local port answers in milliseconds. */
const PROBE_TIMEOUT_MS = 3_000;

/** The codes of a request that met no server at all: no host, no route to it, or nothing listening. */
const NO_SERVER = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

/**
 * The codes of a TLS handshake that met a server speaking something else: what it sent back was no
 * TLS record (OpenSSL's `wrong version number`, or a record too long to be one), or was HTTP.
 */
const NOT_TLS = new Set(["ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_PACKET_LENGTH_TOO_LONG", "ERR_SSL_HTTP_REQUEST",
  "ERR_SSL_UNKNOWN_PROTOCOL", "ERR_SSL_RECORD_LENGTH_MISMATCH"]);

/**
 * The codes of a TLS handshake that met a TLS server whose certificate Node does not accept: one
 * self-signed or from an authority it does not trust, expired or not yet valid, or for another host.
 */
const CERT_REFUSED = new Set(["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_UNTRUSTED", "CERT_REJECTED", "CERT_SIGNATURE_FAILURE",
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "ERR_TLS_CERT_ALTNAME_INVALID"]);

/**
 * A failure's message on one line: OpenSSL's (`80BF...:error:0A00010B:SSL routines:<function>:<reason>:<file>:<line>:`,
 * ending in a newline) as its reason alone (`wrong version number`), any other with its whitespace collapsed.
 */
function oneLine(message: string): string {
  const openSsl = /:error:[0-9A-F]+:[^:]*:[^:]*:([^:]+):/.exec(message);
  return openSsl ? openSsl[1] : message.replace(/\s+/g, " ").trim();
}

/** {@link ProbePort} run on `http`'s host and port (an http:// or https:// URL), an IPv6 literal unbracketed. */
function probePort(http: URL, probe: ProbePort): Promise<PortProbe> {
  const port = Number(http.port || (http.protocol === "https:" ? 443 : 80));
  return probe(http.hostname.replace(/^\[(.*)\]$/, "$1"), port, PROBE_TIMEOUT_MS);
}

/** What {@link diagnose}'s request came to: an answer, a failure, or, first, a port probe that found plain HTTP. */
type Answer = { response: Awaited<ReturnType<FetchStatus>> } | { cause: unknown } | { plain: true };

/** Whether `found`, a probe of an https:// origin's port (`secure`), says it serves plain HTTP, and so no TLS. */
function servesPlainHttp(secure: boolean, found: PortProbe): boolean {
  // A TLS server answers a plain request with 400, as Cloudflare's edge and nginx do, or redirects it
  // to https:// (nginx's `error_page 497`): neither says the port speaks no TLS. A plain server that
  // redirects is still told by its handshake's failure ({@link NOT_TLS}).
  return secure && found.kind === "http" && found.status !== 400 && !(found.status >= 300 && found.status < 400);
}

/**
 * Why `http`, the API's URL as http:// or https://, could not be reached, after `could not reach
 * <url>`: from `answer`, the request's failure (or the probe's finding plain HTTP first), and what
 * `probed()` finds, the next step. Starting the instance is suggested only when nothing is there.
 */
async function unreachable(http: URL, answer: Exclude<Answer, { response: unknown }>, probed: () => Promise<PortProbe>): Promise<string> {
  const secure = http.protocol === "https:";
  const where = http.host;
  const origin = http.origin;
  if ("plain" in answer) return `: ${where} answers plain HTTP, not HTTPS. ${plainNext(http)}`;
  const failure = innermost(answer.cause);
  const why = (answer.cause as Error)?.name === "TimeoutError" ? `no answer in ${DIAGNOSE_TIMEOUT_MS / 1000} s`
    : oneLine(failure.message || failure.code || String(answer.cause));
  if (failure.code !== undefined && NO_SERVER.has(failure.code)) {
    return ` (${why})${failure.code === "ECONNREFUSED" ? ": nothing is listening there" : ""}. ${unreachableNext(origin)}`;
  }
  // A refused certificate came from a TLS server that answered: neither absent nor hung.
  if (failure.code !== undefined && CERT_REFUSED.has(failure.code)) {
    return ` (${why}): ${where} speaks TLS, but its certificate was refused. Check the origin; for a certificate you trust ` +
      "that Node does not (a local instance's own), set NODE_EXTRA_CA_CERTS to its authority's PEM file. Or name another with --url <origin>.";
  }
  const found = await probed();
  // A server that is known to speak no TLS and answers HTTP serves plain HTTP, whatever its status.
  const notTls = failure.code !== undefined && NOT_TLS.has(failure.code);
  if (servesPlainHttp(secure, found) || (notTls && found.kind === "http")) {
    return ` (${why}): ${where} answers plain HTTP, not HTTPS. ${plainNext(http)}`;
  }
  if (found.kind === "closed") return ` (${why}): nothing answered at ${where}. ${unreachableNext(origin)}`;
  if (notTls) {
    return ` (${why}): something is listening at ${where} but does not speak TLS, nor answer plain HTTP: it is not an ` +
      "instance. Check the origin's port, or name another with --url <origin>.";
  }
  if (failure.code?.startsWith("ERR_SSL_") || failure.code?.startsWith("ERR_TLS_")) {
    return ` (${why}): something is listening at ${where}, but the TLS handshake with it failed. Check the origin and its ` +
      "TLS setup, or name another with --url <origin>.";
  }
  return ` (${why}): something is listening at ${where} but did not answer as an instance's API does. It may be slow or ` +
    "hung, or another server: check it, or name another with --url <origin>.";
}

/**
 * The next step for an https:// origin whose port serves plain HTTP: http://, which only a local
 * instance may use (parseTarget), on the port probed, which is named even when it is https://'s 443.
 */
function plainNext(http: URL): string {
  return isLocalHost(http.hostname) ? `Use --url http://${http.hostname}:${http.port || 443}.`
    : "Check the origin's port, or name another with --url <origin>.";
}

/**
 * Why the WebSocket did not open, from a plain request to the same URL with the same headers: Access
 * answers it with a redirect to its login or a 401/403, which a WebSocket error never says. When
 * that fails too, without a code that says no server is there, a plain-text probe of the port tells
 * nothing listening (start the instance) from something listening that did not answer (a hung
 * instance, another server, or, for an https:// origin, a server speaking plain http://). For an
 * https:// origin the probe runs beside the request, so that last case is known without waiting for
 * the request to time out: a port that answers plain HTTP with a status but the 400 or redirect a
 * TLS server may give a plain request serves no TLS. A handshake whose failure says the port spoke no TLS
 * ({@link NOT_TLS}) is told as such, at once, rather than as a hung instance, and so is one whose
 * failure says the server's certificate was refused ({@link CERT_REFUSED}), or another TLS failure.
 */
async function diagnose(
  target: ApiTarget,
  auth: AuthChoice,
  headers: Record<string, string>,
  error: unknown,
  { fetch: fetchStatus, probe }: Pick<SessionDeps, "fetch" | "probe">,
): Promise<Error> {
  const http = new URL(target.url);
  const secure = http.protocol === "wss:";
  http.protocol = secure ? "https:" : "http:";
  const reason = (error as Error)?.message ?? String(error);
  let probing: Promise<PortProbe> | undefined;
  const probed = () => probing ??= probePort(http, probe);
  const stop = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(DIAGNOSE_TIMEOUT_MS), stop.signal]);
  const requested: Promise<Answer> = fetchStatus(http.href, { headers, redirect: "manual", signal })
    .then((response) => ({ response }), (cause: unknown) => ({ cause }));
  // Only an https:// origin's port may serve the wrong protocol, so only its probe runs beside the request.
  const answer = !secure ? await requested
    : await Promise.race([requested, probed().then((found) => servesPlainHttp(secure, found) ? { plain: true as const } : requested)]);
  if (!("response" in answer)) {
    stop.abort();
    return new Error(`could not reach ${target.url}${await unreachable(http, answer, probed)}`, { cause: error });
  }
  const { response } = answer;
  const location = response.headers.get("location") ?? "";
  const toAccess = response.status >= 300 && response.status < 400 &&
    /cloudflareaccess\.com|\/cdn-cgi\/access\//.test(location);
  if (response.status === 401 || response.status === 403 || toAccess) {
    const refusal = toAccess ? "redirected to Cloudflare Access's login" : `refused with HTTP ${response.status}`;
    const fix = auth.mode === "access"
      ? `run \`${accessLoginHint(target.origin)}\` (or set CF_ACCESS_TOKEN to a current token)`
      : auth.mode === "token"
        ? "check CFOS_API_TOKEN, or use --auth access for an instance behind Cloudflare Access"
        : "check --username and CFOS_API_PASSWORD, or use --auth access for an instance behind Cloudflare Access";
    return new Error(`${target.url} ${refusal}: ${fix}.`, { cause: error });
  }
  return new Error(`could not open ${target.url} (HTTP ${response.status}${location ? `, to ${location}` : ""}): ${reason}`,
    { cause: error });
}
