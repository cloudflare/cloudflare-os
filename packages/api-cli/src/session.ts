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
  options: { encoding: "utf8"; env: NodeJS.ProcessEnv },
) => { status: number | null; stdout: string; stderr: string; error?: Error };

/** What of `fetch` a failed handshake is diagnosed with. */
export type FetchStatus = (
  url: string,
  init: { headers: Record<string, string>; redirect: "manual"; signal: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

/** What connecting needs from the world. */
export interface SessionDeps {
  env: NodeJS.ProcessEnv;
  open: OpenConnection;
  spawn: SpawnCloudflared;
  fetch: FetchStatus;
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

/** The world as it is: process environment, real WebSocket, `cloudflared` on PATH, `fetch`. */
export function defaultSessionDeps(): SessionDeps {
  return { env: process.env, open: webSocketConnection, spawn: spawnSync, fetch };
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
 * set it for a fixed instance. It is held only to what `--url` is (http:// accepted, a path
 * dropped), so a caller naming a deployment checks first that its origin is https:// and exactly an
 * origin. `CFOS_API_URL_UNAVAILABLE` is how a caller with no instance says why, in a message that
 * names `--url`: the starter's case when its deployment file is unreadable, names no origin, is not
 * configured, or names one that is not an https:// origin. A caller sets exactly one of the two, so
 * it never falls back to the dev server. Empty values count as unset.
 */
export function defaultInstance(env: NodeJS.ProcessEnv): DefaultInstance {
  if (env.CFOS_API_URL) return { kind: "url", url: env.CFOS_API_URL, from: "CFOS_API_URL" };
  if (env.CFOS_API_URL_UNAVAILABLE) return { kind: "unavailable", reason: env.CFOS_API_URL_UNAVAILABLE };
  return { kind: "url", url: DEV_SERVER_URL, from: "dev-server" };
}

/**
 * The API's location: `--url` when given (an `http://` one only for a local dev server), else the
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

/** `url` as a target, or a usage error naming where it came from (`source`). */
function parseTarget(url: string, source: string): ApiTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`${source} ${url} is not a URL. Give the instance's origin, such as https://os.example.com.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UsageError(`${source} ${url} must be an https:// origin (http:// for a local dev server).`);
  }
  return targetFor(parsed.origin);
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
 * The Access token for `origin`: `CF_ACCESS_TOKEN`, else `cloudflared access token`, which prints
 * the one `cloudflared access login` saved. Spawned without a shell: the origin is an argument.
 */
export function accessToken(origin: string, deps: Pick<SessionDeps, "env" | "spawn">): string {
  const fromEnv = deps.env.CF_ACCESS_TOKEN?.trim();
  if (fromEnv) {
    // Checked here, by name only: a value no header can carry would otherwise fail in the WebSocket
    // constructor, whose message quotes it.
    if (!ACCESS_JWT.test(fromEnv)) throw new UsageError("CF_ACCESS_TOKEN is not an Access token (a JWT, three dot-separated parts).");
    return fromEnv;
  }
  const result = deps.spawn("cloudflared", ["access", "token", `-app=${origin}`], { encoding: "utf8", env: deps.env });
  const succeeded = result.status === 0 && !result.error;
  const token = succeeded ? result.stdout.trim().split("\n").at(-1)?.trim() ?? "" : "";
  if (ACCESS_JWT.test(token)) return token;
  // Its stdout is not repeated when it ran: whatever it printed may hold a token.
  const why = result.error
    ? `cloudflared could not run (${result.error.message})`
    : succeeded ? "cloudflared printed no token"
    : (result.stderr.trim() || `cloudflared exited with status ${result.status}`);
  throw new Error(`no Access token for ${origin}: ${why}. Run \`${accessLoginHint(origin)}\`, or set CF_ACCESS_TOKEN.`);
}

/**
 * The User-Agent of every request `cf-os api` makes: `cf-os-api/<version>`, the version in this
 * package's package.json (session.test.ts checks). Except on a local dev instance, the Workshop lets
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
 * before the request reaches the API at all.
 */
export async function connect(
  target: ApiTarget,
  auth: AuthChoice,
  { serviceSalt, needsSignIn }: { serviceSalt: readonly number[]; needsSignIn: boolean },
  deps: SessionDeps,
): Promise<Session> {
  const headers: Record<string, string> = { Origin: target.origin, "User-Agent": USER_AGENT };
  let signIn: (main: Remote) => Promise<{ api: Remote }>;
  if (auth.mode === "access") {
    headers["cf-access-token"] = accessToken(target.origin, deps);
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
    explain: async (error) => connection.opened() ? error : diagnose(target, auth, headers, error, deps.fetch),
  };
}

/** The secret in `env[name]`; unset, a failure naming `name` and what reads it (`mode`), never a value. */
export function requireEnv(env: NodeJS.ProcessEnv, name: string, mode: string, otherwise = ""): string {
  const value = env[name];
  if (!value) throw new Error(`${mode} reads the secret from ${name}, which is not set${otherwise}.`);
  return value;
}

/** How long the diagnosis waits for its answer: a host that blackholes the WebSocket may do the same to it. */
const DIAGNOSE_TIMEOUT_MS = 10_000;

/**
 * Why the WebSocket did not open, from a plain request to the same URL with the same headers: Access
 * answers it with a redirect to its login or a 401/403, which a WebSocket error never says.
 */
async function diagnose(
  target: ApiTarget,
  auth: AuthChoice,
  headers: Record<string, string>,
  error: unknown,
  fetchStatus: FetchStatus,
): Promise<Error> {
  const http = new URL(target.url);
  http.protocol = http.protocol === "ws:" ? "http:" : "https:";
  const reason = (error as Error)?.message ?? String(error);
  let response: Awaited<ReturnType<FetchStatus>>;
  try {
    response = await fetchStatus(http.href, { headers, redirect: "manual", signal: AbortSignal.timeout(DIAGNOSE_TIMEOUT_MS) });
  } catch (cause) {
    const detail = ((cause as Error).cause as Error | undefined)?.message ?? (cause as Error).message;
    return new Error(`could not reach ${target.url} (${detail}).`, { cause: error });
  }
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
