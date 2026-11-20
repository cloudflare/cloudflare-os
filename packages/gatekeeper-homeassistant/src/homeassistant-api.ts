// Helper wrapping Home Assistant's REST and WebSocket APIs.
//
// Home Assistant exposes two complementary APIs:
//   - REST  (/api/...)      — service calls, template render, history, logbook, fire events
//   - WebSocket (/api/websocket) — registries (areas, labels, devices, entities, floors),
//     dashboards (lovelace), state subscriptions
//
// We use both. WebSocket connections are short-lived: each `withConnection()` call opens a
// connection, performs one or more commands, and closes it. This is simple and adequate for
// Phase 1; Phase 2 may add persistent WebSocket connections to support push-based hooks.
//
// Every call of either API goes through `homeassistantUpstream` (see `homeassistant-upstream.ts`),
// which counts it, and times a REST request and sends a GET again after a transient failure.

import type { CallAnswer, UpstreamRequestInit } from "@gadgets/gatekeeper-kit/upstream";
import {
  HA_BULK_READ_TIMEOUT_MS, HA_REST_TIMEOUT_MS, WS_CONNECT_OPERATION, homeassistantUpstream,
  wsOperation, type WsCommandType,
} from "./homeassistant-upstream";

// ---------------------------------------------------------------------------
// Errors

export class HomeAssistantError extends Error {
  readonly status?: number;
  /** When true, this error indicates the LLAT is invalid or revoked. */
  readonly isAuthError: boolean;

  constructor(message: string, opts: { status?: number; isAuthError?: boolean } = {}) {
    super(message);
    this.status = opts.status;
    this.isAuthError = opts.isAuthError ?? false;
  }
}

// ---------------------------------------------------------------------------
// REST API

export interface HomeAssistantCredentials {
  /** Base URL of the HA instance, with no trailing slash (e.g. "http://homeassistant.local:8123"). */
  baseUrl: string;
  /** A long-lived access token. */
  token: string;
}

function joinUrl(baseUrl: string, path: string): string {
  if (path.startsWith("/")) path = path.slice(1);
  return `${baseUrl}/${path}`;
}

/** Default timeout for the WebSocket auth handshake. After auth, individual `send()` commands
 * are not separately timed out — long-running registry / dashboard commands legitimately take
 * a few seconds on big HA instances. If you need a per-command timeout, race manually. */
const HA_WS_AUTH_TIMEOUT_MS = 15_000;

/** Cap on the number of bytes of an HA error-response body we include in a thrown error
 * message. HA itself doesn't echo request headers, but a misbehaving reverse proxy in front
 * of HA might. We also strip any `Authorization` / `Bearer ...` substrings as a final guard
 * so the long-lived access token can never end up in error logs / UI text. */
const HA_ERROR_BODY_MAX_BYTES = 200;

function sanitizeErrorBody(text: string, token: string): string {
  let clean = text.slice(0, HA_ERROR_BODY_MAX_BYTES).replace(/\s+/g, " ").trim();
  // Belt-and-suspenders: scrub anything that looks like the bearer token or an Authorization
  // header echo. We replace the literal token with [redacted-token] first, then any
  // remaining "Bearer ..." / "Authorization: ..." substrings.
  if (token) {
    clean = clean.split(token).join("[redacted-token]");
  }
  clean = clean.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [redacted]");
  clean = clean.replace(/Authorization\s*:\s*[^\s,;]+/gi, "Authorization: [redacted]");
  return clean;
}

/** The `name` of what was thrown, where it has one. */
function errorName(error: unknown): unknown {
  return typeof error === "object" && error !== null && "name" in error ? error.name : undefined;
}

/** The `message` of what was thrown, or what was thrown itself where it has none. */
function errorMessage(error: unknown): unknown {
  const message = typeof error === "object" && error !== null && "message" in error
    ? error.message : undefined;
  return message ?? error;
}

/**
 * Sends one REST request to the instance and reads its answer: JSON where the answer says it is
 * JSON, and text otherwise. The request goes through `homeassistantUpstream`, which gives each
 * attempt `HA_REST_TIMEOUT_MS` unless the request asks for another `timeoutMs`, sends a GET again
 * after a transient failure and follows no redirect, so a redirect is thrown as the HTTP error of
 * its status.
 * @param creds The instance's base URL and the token sent to it.
 * @param path The path under the base URL, as `api/states`.
 * @param init The request's method, body and headers, and its own options of the client. It
 * holds no `signal`: the attempt's timeout is the only thing that aborts a request.
 * @returns The answer's body.
 * @throws A `HomeAssistantError` for an instance that cannot be reached or does not answer in
 * time, for a rejected token (`isAuthError`) and for any other status that is no success; and
 * what reading the body threw, for a body that is not what its content type says.
 */
async function fetchJson<T>(
  creds: HomeAssistantCredentials,
  path: string,
  init: UpstreamRequestInit = {},
  read: (body: unknown) => T = body => body as T,
): Promise<T> {
  const url = joinUrl(creds.baseUrl, path);
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${creds.token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  // What reading the body of an answer threw, which is thrown as it is.
  let unread: { error: unknown } | undefined;
  try {
    return await homeassistantUpstream.read(url, { ...init, headers }, async (response) => {
      if (response.status === 401 || response.status === 403) {
        throw new HomeAssistantError(
          "Home Assistant rejected the access token. The token may have been revoked.",
          { status: response.status, isAuthError: true },
        );
      }
      if (!response.ok) {
        const rawText = await response.text().catch(() => "");
        const safeText = sanitizeErrorBody(rawText, creds.token);
        throw new HomeAssistantError(
          `Home Assistant returned HTTP ${response.status}: ${safeText || response.statusText}`,
          { status: response.status },
        );
      }

      try {
        const contentType = response.headers.get("Content-Type") ?? "";
        // For template render, HA returns text/plain. `read` takes what the request was sent
        // for out of the body, within the request: a body it throws on is none read.
        return read(contentType.includes("application/json") ? await response.json() : await response.text());
      } catch (error) {
        unread = { error };
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof HomeAssistantError) throw error;
    // The attempt's timeout fired, before the instance answered or while its answer was read. No
    // request has a caller's signal, so an abort under either name is that timeout: a runtime
    // may report a reading the signal cut off as an `AbortError`.
    if (errorName(error) === "TimeoutError" || errorName(error) === "AbortError") {
      const timeoutMs = typeof init.timeoutMs === "number" ? init.timeoutMs : HA_REST_TIMEOUT_MS;
      throw new HomeAssistantError(
        `Home Assistant did not respond within ${timeoutMs}ms (${creds.baseUrl}).`,
      );
    }
    if (unread && unread.error === error) throw error;
    throw new HomeAssistantError(
      `Failed to reach Home Assistant at ${creds.baseUrl}: ${errorMessage(error)}`,
    );
  }
}

// Reads an answer that is a list, which may be empty: the states of every entity, a history, a
// logbook, the services. A body that is none, a proxy's page included, is refused within the
// request, so that it is counted an error and no reader of the list meets it. `what` names the
// list in the error.
const listOf = (what: string) => (body: unknown): any[] => {
  if (!Array.isArray(body)) throw new HomeAssistantError(`Home Assistant answered ${what} with no list.`);
  return body;
};

// Whether a command that lists a registry was answered a success that holds no list, which is an
// empty list where it is one.
function misses(command: WSCommand, result: WSResult): boolean {
  return result.success === true && command.type.endsWith("/list") && !Array.isArray(result.result);
}

// The status of Home Assistant's API, as `/api/` answers it: an object with a message. A body that
// is none, a proxy's login page included, is no API that answered, and is refused within the request.
function apiStatus(body: unknown): { message: string } {
  if (typeof body !== "object" || body === null || typeof (body as { message?: unknown }).message !== "string") {
    throw new HomeAssistantError("Home Assistant answered its API's status with no status.");
  }
  return body as { message: string };
}

export class HomeAssistantRest {
  constructor(private readonly creds: HomeAssistantCredentials) {}

  async getConfig(): Promise<any> {
    return await fetchJson(this.creds, "api/config");
  }

  async getStates(): Promise<any[]> {
    return await fetchJson(this.creds, "api/states", { timeoutMs: HA_BULK_READ_TIMEOUT_MS }, listOf("its list of states"));
  }

  async getState(entityId: string): Promise<any> {
    return await fetchJson(this.creds, `api/states/${encodeURIComponent(entityId)}`);
  }

  // NOTE: Service calls and event firing go through the WebSocket API instead of REST. See
  // HomeAssistantWebSocket.callService / .fireEvent. HA's REST endpoints for these have
  // historical quirks (target fields must be flattened at the top level of the body, area /
  // label / floor targets are unevenly supported across versions). The WebSocket call_service
  // command is HA's modern path and supports the full target shape natively.

  async renderTemplate(template: string, variables?: Record<string, unknown>): Promise<string> {
    return await fetchJson(this.creds, "api/template", {
      method: "POST",
      body: JSON.stringify({ template, variables }),
    });
  }

  async getHistory(
    entityIds: string[],
    start: Date,
    end?: Date,
    minimal = true,
  ): Promise<any[][]> {
    const params = new URLSearchParams();
    params.set("filter_entity_id", entityIds.join(","));
    if (end) params.set("end_time", end.toISOString());
    if (minimal) params.set("minimal_response", "true");
    const path = `api/history/period/${start.toISOString()}?${params.toString()}`;
    return await fetchJson(this.creds, path, { timeoutMs: HA_BULK_READ_TIMEOUT_MS }, listOf("a history"));
  }

  async getLogbook(start: Date, end?: Date, entityId?: string): Promise<any[]> {
    const params = new URLSearchParams();
    if (end) params.set("end_time", end.toISOString());
    if (entityId) params.set("entity", entityId);
    const path = `api/logbook/${start.toISOString()}?${params.toString()}`;
    return await fetchJson(this.creds, path, { timeoutMs: HA_BULK_READ_TIMEOUT_MS }, listOf("a logbook"));
  }

  async getServices(): Promise<any[]> {
    return await fetchJson(this.creds, "api/services", {}, listOf("its list of services"));
  }

  /** Quick check that the API is reachable and credentials are valid. */
  async ping(): Promise<{ message: string }> {
    return await fetchJson(this.creds, "api/", {}, apiStatus);
  }
}

// ---------------------------------------------------------------------------
// WebSocket API
//
// HA's WebSocket protocol is documented at:
//   https://developers.home-assistant.io/docs/api/websocket
//
// Auth flow:
//   1. Server sends {type: "auth_required", ha_version: "..."}
//   2. Client sends {type: "auth", access_token: "..."}
//   3. Server sends {type: "auth_ok"} or {type: "auth_invalid", message: "..."}
//
// After auth, commands have an integer `id` (incrementing); results echo the id.

/** A command as its caller gives it: the `id` is `send`'s to add. */
interface WSCommand {
  /** One of the commands this gatekeeper sends, by which the command is counted. */
  type: WsCommandType;
  [key: string]: unknown;
}

interface WSResult {
  id: number;
  type: "result";
  success: boolean;
  result?: any;
  error?: { code: string; message: string };
}

function websocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    url.protocol = "ws:";
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  url.pathname += "api/websocket";
  return url.toString();
}

/** Lightweight WebSocket client for Home Assistant. Holds an authenticated connection. */
export class HomeAssistantWebSocket {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, { resolve: (result: WSResult) => void; reject: (error: unknown) => void }>();
  #closed = false;
  // Whether `close` is what closes the socket: a command left pending then was given up here,
  // and is no call the instance failed.
  #closing = false;
  #closePromise: Promise<void>;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    this.#closePromise = new Promise<void>((resolve) => {
      ws.addEventListener("close", () => {
        this.#closed = true;
        for (const { reject } of this.#pending.values()) {
          reject(new HomeAssistantError("Home Assistant WebSocket closed unexpectedly."));
        }
        this.#pending.clear();
        resolve();
      });
      ws.addEventListener("error", () => {
        this.#closed = true;
        for (const { reject } of this.#pending.values()) {
          reject(new HomeAssistantError("Home Assistant WebSocket error."));
        }
        this.#pending.clear();
      });
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      let msg: WSResult;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      if (msg.type !== "result") return;
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      // A result that reports a failure is an answer too: `send` counts it and throws it.
      pending.resolve(msg);
    });
  }

  /** Open a new authenticated WebSocket connection. */
  static async connect(creds: HomeAssistantCredentials): Promise<HomeAssistantWebSocket> {
    const wsUrl = websocketUrl(creds.baseUrl);
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e: any) {
      throw new HomeAssistantError(
        `Failed to open WebSocket to ${wsUrl}: ${e?.message ?? e}`,
      );
    }

    // We must run an auth handshake before anything else. The handshake uses raw messages
    // (without the integer id) so we wire up custom listeners temporarily.
    //
    // Race against a timeout so we don't hold the Worker open on a slow / unresponsive HA.
    //
    // The handshake is one counted call. `failure` is how the handshake's first failure is
    // counted, set where it fails: a closed word, and nothing of the error it throws.
    let failure: CallAnswer | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      await homeassistantUpstream.call(WS_CONNECT_OPERATION, () => new Promise<void>((resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          failure ??= { outcome: "error", reason: "timeout" };
          try { ws.close(); } catch { /* ignore */ }
          reject(
            new HomeAssistantError(
              `Home Assistant WebSocket auth handshake did not complete within ${HA_WS_AUTH_TIMEOUT_MS}ms (${wsUrl}).`,
            ),
          );
        }, HA_WS_AUTH_TIMEOUT_MS);

        ws.addEventListener("error", () => {
          failure ??= { outcome: "error", reason: "network" };
          reject(new HomeAssistantError(`Home Assistant WebSocket error during auth.`));
        });
        ws.addEventListener("close", (event) => {
          // A close for a policy violation (1008) is the instance turning the token away.
          failure ??= { outcome: "error", reason: event.code === 1008 ? "auth" : "network" };
          reject(
            new HomeAssistantError(
              `Home Assistant WebSocket closed before auth completed: ${event.code} ${event.reason}`,
              { isAuthError: event.code === 1008 },
            ),
          );
        });

        const onMessage = (event: MessageEvent) => {
          let msg: any;
          try {
            msg = JSON.parse(typeof event.data === "string" ? event.data : "");
          } catch {
            return;
          }
          if (msg.type === "auth_required") {
            ws.send(JSON.stringify({ type: "auth", access_token: creds.token }));
          } else if (msg.type === "auth_ok") {
            ws.removeEventListener("message", onMessage);
            resolve();
          } else if (msg.type === "auth_invalid") {
            ws.removeEventListener("message", onMessage);
            failure ??= { outcome: "error", reason: "auth" };
            reject(
              new HomeAssistantError(
                `Home Assistant rejected the access token: ${msg.message ?? "unknown"}`,
                { isAuthError: true },
              ),
            );
          }
        };
        ws.addEventListener("message", onMessage);
      }), { thrown: () => failure });
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }

    return new HomeAssistantWebSocket(ws);
  }

  /**
   * Sends a command and waits for its result. The command is one counted call, named by its
   * `type` (`wsOperation`): a result that reports a failure is an `error` with the reason `api`,
   * and a socket that closes or fails before the result one with the reason `network`, unless
   * `close` is what closed it: a command given up so is not counted. It has no timeout of its own
   * and is sent once.
   * @param command The command, without the `id` this adds.
   * @returns The `result` of the command's answer.
   * @throws A `HomeAssistantError` where the socket is closed, closes or fails before the
   * result, and where the result reports a failure.
   */
  async send<T = any>(command: WSCommand): Promise<T> {
    if (this.#closed) {
      throw new HomeAssistantError("WebSocket is closed.");
    }
    const id = this.#nextId++;
    // Whether the frame left: a command the socket threw on was not sent, and is not counted.
    let sent = false;
    const answered = await homeassistantUpstream.call(wsOperation(command.type), () => {
      const result = new Promise<WSResult>((resolve, reject) => {
        this.#pending.set(id, { resolve, reject });
      });
      try {
        this.#ws.send(JSON.stringify({ ...command, id }));
      } catch (error) {
        // No result will come for a frame that did not leave.
        this.#pending.delete(id);
        throw error;
      }
      sent = true;
      return result;
    }, {
      answer: (result) => (result.success && !misses(command, result) ? undefined : { outcome: "error", reason: "api" }),
      thrown: () => (sent && !this.#closing ? { outcome: "error", reason: "network" } : null),
    });
    if (!answered.success) {
      throw new HomeAssistantError(
        `Home Assistant WS command failed (${answered.error?.code}): ${answered.error?.message}`,
      );
    }
    if (misses(command, answered)) {
      throw new HomeAssistantError(`Home Assistant answered ${command.type} with no list.`);
    }
    return answered.result;
  }

  /** Call a Home Assistant service via the WebSocket `call_service` command.
   *
   * This is the modern path and supports every target form (entity_id, device_id, area_id,
   * label_id, floor_id), unlike the REST equivalent which has historical quirks around
   * advanced targets. */
  async callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: Record<string, unknown>,
  ): Promise<any> {
    const cmd: WSCommand = {
      type: "call_service",
      domain,
      service,
    };
    if (serviceData && Object.keys(serviceData).length > 0) {
      cmd.service_data = serviceData;
    }
    if (target && Object.keys(target).length > 0) {
      cmd.target = target;
    }
    return await this.send(cmd);
  }

  /** Fire an event on the Home Assistant event bus via the WebSocket `fire_event` command. */
  async fireEvent(eventType: string, eventData?: Record<string, unknown>): Promise<any> {
    const cmd: WSCommand = {
      type: "fire_event",
      event_type: eventType,
    };
    if (eventData && Object.keys(eventData).length > 0) {
      cmd.event_data = eventData;
    }
    return await this.send(cmd);
  }

  /**
   * Closes the socket and waits for it to have closed. A command still pending fails as one the
   * socket closed under, and is not counted.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    try {
      this.#ws.close();
    } catch {
      // ignore
    }
    await this.#closePromise;
  }
}

/** Convenience: open a WS connection, run a callback, then close. */
export async function withWebSocket<T>(
  creds: HomeAssistantCredentials,
  fn: (ws: HomeAssistantWebSocket) => Promise<T>,
): Promise<T> {
  const ws = await HomeAssistantWebSocket.connect(creds);
  try {
    return await fn(ws);
  } finally {
    await ws.close();
  }
}

// ---------------------------------------------------------------------------
// Combined helpers that touch both REST and WS

/** Aggregate snapshot of the HA registries, fetched in one round-trip per registry. */
export interface RegistrySnapshot {
  areas: any[];
  floors: any[];
  labels: any[];
  devices: any[];
  entities: any[];
  states: Map<string, any>;
}

export async function fetchRegistrySnapshot(
  creds: HomeAssistantCredentials,
): Promise<RegistrySnapshot> {
  const states = await new HomeAssistantRest(creds).getStates();
  const stateMap = new Map<string, any>();
  for (const s of states) {
    stateMap.set(s.entity_id, s);
  }

  return await withWebSocket(creds, async (ws) => {
    const [areas, floors, labels, devices, entities] = await Promise.all([
      ws.send<any[]>({ type: "config/area_registry/list" }),
      ws.send<any[]>({ type: "config/floor_registry/list" }).catch(() => []),
      ws.send<any[]>({ type: "config/label_registry/list" }).catch(() => []),
      ws.send<any[]>({ type: "config/device_registry/list" }),
      ws.send<any[]>({ type: "config/entity_registry/list" }),
    ]);
    return { areas, floors, labels, devices, entities, states: stateMap };
  });
}
