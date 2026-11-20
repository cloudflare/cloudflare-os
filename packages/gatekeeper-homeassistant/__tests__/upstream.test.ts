// The calls this gatekeeper makes to a Home Assistant instance, the name each is counted under,
// and how each is sent and counted. The REST names come from the path under the instance's
// `/api/` and the WebSocket names from a closed table, so these check the names with no request
// made, then drive the real client against a stubbed fetch and a scripted socket and read the
// points it writes.
import { env as bindings } from "cloudflare:workers";
import { unreachedRouteEnds } from "@gadgets/gatekeeper-kit/route-operation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS } from "../../observability/src/metrics-schema";
import { HomeAssistantGatekeeperImpl } from "../src/homeassistant";
import {
  HomeAssistantError, HomeAssistantRest, HomeAssistantWebSocket, fetchRegistrySnapshot, withWebSocket,
} from "../src/homeassistant-api";
import {
  HA_ROOT_OPERATION, HA_ROUTES, WS_COMMAND_OPERATIONS, WS_CONNECT_OPERATION, WS_OPERATIONS,
  WS_OTHER_OPERATION, apiAddress, homeassistantUpstream, wsOperation, type WsCommandType,
} from "../src/homeassistant-upstream";

// The gatekeeper's Durable Object is driven as a plain class, beside the shared stub's `env`.
vi.mock("cloudflare:workers", async importOriginal => ({
  ...await importOriginal<typeof import("cloudflare:workers")>(),
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
  RpcTarget: vi.fn(),
  WorkerEntrypoint: vi.fn(),
}));
vi.mock("capnweb-validate", () => ({
  validateRpc: () => (target: unknown) => target,
  skipRpcValidation: () => (target: unknown) => target,
}));
vi.mock("../src/types.txt", () => ({ default: "" }));
vi.mock("../src/generated/instance-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/area-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/label-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/device-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/entity-configurator-ui.txt", () => ({ default: "" }));

const BASE = "http://homeassistant.local:8123";
const TOKEN = "long-lived-token";
const creds = { baseUrl: BASE, token: TOKEN };
const START = new Date("2024-01-01T00:00:00.000Z");
const END = new Date("2024-01-02T12:30:00.000Z");

// Each kind of REST request the gatekeeper makes: its HTTP method, its path and query under an
// instance's `/api/`, the name it is counted under, and the method of the client that sends it.
const REQUESTS: [method: string, path: string, name: string, call: (rest: HomeAssistantRest) => Promise<unknown>][] = [
  ["GET", "", HA_ROOT_OPERATION, rest => rest.ping()],
  ["GET", "config", "config.get", rest => rest.getConfig()],
  ["GET", "states", "states.list", rest => rest.getStates()],
  ["GET", "states/light.kitchen", "states.get", rest => rest.getState("light.kitchen")],
  ["GET", "services", "services.list", rest => rest.getServices()],
  ["POST", "template", "template", rest => rest.renderTemplate("{{ 1 + 1 }}", { unit: "C" })],
  ["GET", "history/period/2024-01-01T00:00:00.000Z?filter_entity_id=light.kitchen&end_time=2024-01-02T12%3A30%3A00.000Z&minimal_response=true",
    "period.get", rest => rest.getHistory(["light.kitchen"], START, END)],
  ["GET", "logbook/2024-01-01T00:00:00.000Z?end_time=2024-01-02T12%3A30%3A00.000Z&entity=light.kitchen",
    "logbook.get", rest => rest.getLogbook(START, END, "light.kitchen")],
];

// The bases a user may give: a host with a port, an address, a host over TLS, and base paths, one
// of which holds an `/api/` of its own.
const BASES = [
  BASE, "http://192.168.1.20:8123", "https://home.example.com", "https://example.com/homeassistant",
  "https://example.com/api/v2/home",
];

// Each WebSocket command the gatekeeper sends, by its `type`, and the name it is counted under.
const COMMANDS: [type: WsCommandType, name: string][] = [
  ["config/area_registry/list", "ws.areas.list"],
  ["config/floor_registry/list", "ws.floors.list"],
  ["config/label_registry/list", "ws.labels.list"],
  ["config/device_registry/list", "ws.devices.list"],
  ["config/entity_registry/list", "ws.entities.list"],
  ["call_service", "ws.services.call"],
  ["fire_event", "ws.events.fire"],
  ["lovelace/dashboards/list", "ws.dashboards.list"],
  ["lovelace/resources", "ws.dashboard-resources.list"],
  ["lovelace/config", "ws.dashboard-config.get"],
  ["lovelace/config/save", "ws.dashboard-config.save"],
];

type Point = { blobs?: unknown[]; doubles?: unknown[] };
type Sent = [url: string, init: RequestInit];

const ambient = bindings as { METRICS?: { writeDataPoint(point: Point): void }; SUBSERVICE_METRICS?: string };
let points: Point[];

beforeEach(() => {
  points = [];
  ambient.METRICS = { writeDataPoint: point => void points.push(point) };
  ambient.SUBSERVICE_METRICS = "true";
  home = { auth: "ok", answer: frame => result(frame, []) };
  sockets = [];
});

afterEach(() => {
  delete ambient.METRICS;
  delete ambient.SUBSERVICE_METRICS;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A written point's value in one column.
function column(point: Point, slot: string) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

// Each point written, as its operation, outcome, reason and HTTP status.
function counted() {
  return points.map(point => [
    SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason,
    SUBSERVICE_V1_SLOTS.httpStatus,
  ].map(slot => column(point, slot)));
}

// One column of each point written.
function columnOf(slot: string) {
  return points.map(point => column(point, slot));
}

// How many calls each point written stands for, by its operation.
function callsByOperation() {
  return points.map(point => [column(point, SUBSERVICE_V1_SLOTS.operation), column(point, SUBSERVICE_V1_SLOTS.calls)])
    .toSorted(([a], [b]) => String(a).localeCompare(String(b)));
}

// A global fetch that gives each of `answers` in turn, and the last to every later request. An
// error is thrown.
function answering(...answers: (Response | Error)[]) {
  const fetch = vi.fn(async (..._sent: Sent) => {
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next === undefined) throw new Error("the test listed no answer");
    if (next instanceof Error) throw next;
    return next.clone();
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// The method and URL of each request sent.
function sent(fetch: ReturnType<typeof answering>) {
  return fetch.mock.calls.map(([url, init]) => [init.method ?? "GET", url]);
}

const again = { "Retry-After": "0" };
const outage = () => new Response("", { status: 503, headers: again });
const rest = () => new HomeAssistantRest(creds);
const timedOut = () => new DOMException("The operation timed out.", "TimeoutError");

type Frame = { id: number; type: string; [key: string]: unknown };
type Home = {
  // How the instance answers the token: with a message, by closing with a code, by failing, or
  // not at all.
  auth: "ok" | "invalid" | { close: number } | "error" | "silent";
  // What the instance answers a command with: a message, `"close"` to drop the socket, or
  // undefined to leave the command unanswered.
  answer: (frame: Frame) => unknown;
  // Whether the socket throws on a command's frame.
  refuses?: boolean;
};
let home: Home;
let sockets: ScriptedSocket[];

// A WebSocket that plays a Home Assistant instance as `home` scripts it.
class ScriptedSocket extends EventTarget {
  readonly frames: Frame[] = [];
  constructor(readonly url: string) {
    super();
    sockets.push(this);
    queueMicrotask(() => this.#message({ type: "auth_required", ha_version: "2024.1.0" }));
  }
  #message(message: unknown) {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(message) }));
  }
  #closed(code: number) {
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" }));
  }
  send(data: string) {
    const frame = JSON.parse(data) as Frame;
    if (frame.type !== "auth" && home.refuses) throw new Error("the socket is closing");
    this.frames.push(frame);
    queueMicrotask(() => {
      if (frame.type !== "auth") {
        const answer = home.answer(frame);
        if (answer === "close") this.#closed(1006);
        else if (answer !== undefined) this.#message(answer);
      } else if (home.auth === "ok") this.#message({ type: "auth_ok" });
      else if (home.auth === "invalid") this.#message({ type: "auth_invalid", message: "Invalid access token" });
      else if (home.auth === "error") this.dispatchEvent(new Event("error"));
      else if (home.auth !== "silent") this.#closed(home.auth.close);
    });
  }
  close() {
    queueMicrotask(() => this.#closed(1000));
  }
}

const result = (frame: Frame, value: unknown) => ({ id: frame.id, type: "result", success: true, result: value });
const failure = (frame: Frame) => ({
  id: frame.id, type: "result", success: false, error: { code: "unknown_command", message: "Unknown command." },
});

// The gatekeeper's Durable Object over a map for its storage, with `rows` stored.
function gatekeeper(rows: Record<string, unknown>) {
  const kv = new Map<string, unknown>(Object.entries(rows));
  const ctx = {
    props: { userObjectId: "user", resourceKind: "instance" },
    exports: { UserAccount: { idFromString: (id: string) => id, get: () => ({ getCredentials: async () => creds }) } },
    storage: {
      kv: {
        get: (key: string) => structuredClone(kv.get(key)),
        put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
        delete: (key: string) => kv.delete(key),
        list: ({ prefix }: { prefix: string }) => [...kv].filter(([key]) => key.startsWith(prefix)),
      },
    },
  };
  return { gk: new HomeAssistantGatekeeperImpl(ctx as never, {} as never), kv };
}

describe("the names of Home Assistant's REST requests", () => {
  it("counts every call under the source and service of the vendor", () => {
    expect(homeassistantUpstream.vendorId).toBe("homeassistant");
    expect(homeassistantUpstream.source).toBe("gatekeeper.homeassistant.api");
  });

  it.each(REQUESTS)("names %s %s as %s, whatever the instance's base", (method, path, name) => {
    expect(BASES.map(base => homeassistantUpstream.operationOf(method, `${base}/api/${path}`)))
      .toEqual(BASES.map(() => name));
  });

  it("reaches every end of the route tree with a request of the table", () => {
    const rows = REQUESTS.map(([method, path]) => [method, apiAddress(new URL(`${BASE}/api/${path}`)) ?? ""] as const);
    expect(unreachedRouteEnds(HA_ROUTES, rows)).toEqual([]);
  });

  it("reads a timestamp as the rest of its path, colons included", () => {
    expect(homeassistantUpstream.operationOf("GET", `${BASE}/api/logbook/2024-01-01T00:00:00.000Z`)).toBe("logbook.get");
    expect(homeassistantUpstream.operationOf("GET", `${BASE}/api/history/period/2024-01-01T00:00:00.000Z`)).toBe("period.get");
  });

  it.each([
    ["GET", `${BASE}/api/error_log`, "GET"],
    ["POST", `${BASE}/api/services/light/turn_on`, "POST"],
    ["GET", `${BASE}/api/template`, "GET"],
    ["POST", `${BASE}/api/`, "POST"],
    ["GET", `${BASE}/auth/token`, "GET"],
    ["GET", `${BASE}/`, "GET"],
  ])("names %s %s, which the gatekeeper does not send, by its method", (method, url, name) => {
    expect(homeassistantUpstream.operationOf(method, url)).toBe(name);
  });
});

describe("the names of Home Assistant's WebSocket commands", () => {
  it.each(COMMANDS)("names the command %s as %s", (type, name) => {
    expect(wsOperation(type)).toBe(name);
  });

  it("names every command of the table, and no other", () => {
    expect(COMMANDS.map(([type]) => type).toSorted()).toEqual(Object.keys(WS_COMMAND_OPERATIONS).toSorted());
  });

  it.each(["supervisor/api", "config/area_registry/delete", "constructor", "__proto__", ""])(
    "names the command %j, which is not in the table, as any other", type => {
      expect(wsOperation(type)).toBe(WS_OTHER_OPERATION);
    });

  it("uses every name of the union, and lists none twice", () => {
    const used = [WS_CONNECT_OPERATION, ...COMMANDS.map(([, name]) => name), WS_OTHER_OPERATION];
    expect(used.toSorted()).toEqual(WS_OPERATIONS.toSorted());
    expect(new Set(WS_OPERATIONS).size).toBe(WS_OPERATIONS.length);
  });
});

describe("how a REST request is sent", () => {
  // An answer that each request takes for one: a list where it reads one, an object otherwise.
  const LISTS = ["states.list", "period.get", "logbook.get", "services.list"];
  const plain = (name: string) => Response.json(LISTS.includes(name) ? [] : name === "api.get" ? { message: "API running." } : {});

  it.each(REQUESTS)("sends %s /api/%s once, with the token, and counts it as %s", async (method, path, name, call) => {
    const fetch = answering(plain(name));
    await call(rest());
    expect(sent(fetch)).toEqual([[method, `${BASE}/api/${path}`]]);
    const [[, init]] = fetch.mock.calls;
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(init.headers).get("Content-Type")).toBe(method === "POST" ? "application/json" : null);
    expect(init.redirect).toBe("manual");
    expect(counted()).toEqual([[name, "success", "", 200]]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.service)).toEqual(["homeassistant"]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.source)).toEqual(["gatekeeper.homeassistant.api"]);
  });

  it.each<[string, () => Response]>([
    ["an object", () => Response.json({})],
    ["nothing", () => Response.json(null)],
    ["a proxy's page", () => new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } })],
  ])("counts the list of states answered 200 with %s as a body that could not be read, sent once", async (_name, answer) => {
    const fetch = answering(answer());
    const thrown = await rest().getStates().catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(HomeAssistantError);
    expect(thrown).toMatchObject({ message: "Home Assistant answered its list of states with no list." });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["states.list", "error", "parse", 200]]);
  });

  it.each<[string, string, (api: HomeAssistantRest) => Promise<unknown>]>([
    ["period.get", "a history", api => api.getHistory(["light.kitchen"], new Date(0))],
    ["logbook.get", "a logbook", api => api.getLogbook(new Date(0))],
    ["services.list", "its list of services", api => api.getServices()],
  ])("counts %s answered 200 with a proxy's page as a body that could not be read, and an empty list as a success", async (name, what, call) => {
    const fetch = answering(
      new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } }), Response.json([]));
    const thrown = await call(rest()).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(HomeAssistantError);
    expect(thrown).toMatchObject({ message: `Home Assistant answered ${what} with no list.` });
    await expect(call(rest())).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(counted()).toEqual([[name, "error", "parse", 200], [name, "success", "", 200]]);
  });

  it.each<[string, () => Response]>([
    ["a proxy's login page", () => new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } })],
    ["an object with no message", () => Response.json({})],
  ])("counts a check of the API answered 200 with %s as a body that could not be read", async (_name, answer) => {
    answering(answer());
    const thrown = await rest().ping().catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(HomeAssistantError);
    expect(thrown).toMatchObject({ message: "Home Assistant answered its API's status with no status." });
    expect(counted()).toEqual([["api.get", "error", "parse", 200]]);
  });

  it("counts a check of the API answered its status as a success", async () => {
    answering(Response.json({ message: "API running." }));
    await expect(rest().ping()).resolves.toEqual({ message: "API running." });
    expect(counted()).toEqual([["api.get", "success", "", 200]]);
  });

  it("counts an empty list of states as a success", async () => {
    answering(Response.json([]));
    await expect(rest().getStates()).resolves.toEqual([]);
    expect(counted()).toEqual([["states.list", "success", "", 200]]);
  });

  it("sends a template and its variables as the JSON body of a POST", async () => {
    const fetch = answering(new Response("2", { headers: { "Content-Type": "text/plain" } }));
    await expect(rest().renderTemplate("{{ 1 + 1 }}", { unit: "C" })).resolves.toBe("2");
    expect(fetch.mock.calls[0][1].body).toBe(JSON.stringify({ template: "{{ 1 + 1 }}", variables: { unit: "C" } }));
  });

  it.each(REQUESTS)("gives each attempt of %s /api/%s its time", async (_method, _path, name, call) => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    answering(plain(name));
    await call(rest());
    // A bulk read, whose answer grows with the instance and the period, has the client's default.
    const bulk = ["states.list", "period.get", "logbook.get"].includes(name);
    expect(timeout.mock.calls).toEqual([[bulk ? 30_000 : 15_000]]);
  });

  it("gives an attempt that is made again the whole of its time", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    answering(outage(), Response.json([]), outage(), Response.json({}));
    await rest().getStates();
    await rest().getConfig();
    expect(timeout.mock.calls).toEqual([[30_000], [30_000], [15_000], [15_000]]);
  });

  it.each([
    ["a rate limit", 429, ["refused", "rate", 429]],
    ["a bad gateway", 502, ["error", "http", 502]],
    ["an outage", 503, ["error", "http", 503]],
    ["a gateway timeout", 504, ["error", "http", 504]],
  ])("sends a GET again after %s, and returns the answer that follows", async (_name, status, outcome) => {
    const fetch = answering(new Response("", { status, headers: again }), Response.json([{ entity_id: "light.kitchen" }]));
    await expect(rest().getStates()).resolves.toEqual([{ entity_id: "light.kitchen" }]);
    expect(sent(fetch)).toEqual([["GET", `${BASE}/api/states`], ["GET", `${BASE}/api/states`]]);
    expect(counted()).toEqual([["states.list", ...outcome], ["states.list", "success", "", 200]]);
  });

  it("sends a GET three times at most, and throws the last answer's error", async () => {
    const fetch = answering(new Response("down for maintenance", { status: 503, headers: again }));
    await expect(rest().getConfig()).rejects.toMatchObject({
      message: "Home Assistant returned HTTP 503: down for maintenance", status: 503, isAuthError: false,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(counted()).toEqual([1, 2, 3].map(() => ["config.get", "error", "http", 503]));
  });

  it("sends a GET three times when the instance cannot be reached, and says so", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = answering(new TypeError("fetch failed"));
    const failed = rest().ping();
    await expect(failed).rejects.toBeInstanceOf(HomeAssistantError);
    await expect(failed).rejects.toThrow(`Failed to reach Home Assistant at ${BASE}: fetch failed`);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(counted()).toEqual([1, 2, 3].map(() => [HA_ROOT_OPERATION, "error", "network", 0]));
  });

  it("sends a GET three times when no attempt is answered in time, and says so", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    // Each attempt's timeout has fired by the time the fetch looks at its signal.
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort(timedOut()));
    const fetch = vi.fn(async (..._sent: Sent) => {
      _sent[1].signal?.throwIfAborted();
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetch);
    const failed = rest().getConfig();
    await expect(failed).rejects.toBeInstanceOf(HomeAssistantError);
    await expect(failed).rejects.toThrow(`Home Assistant did not respond within 15000ms (${BASE}).`);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(counted()).toEqual([1, 2, 3].map(() => ["config.get", "error", "timeout", 0]));
  });

  it("asks again for an answer whose body the timeout cut off", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const attempts: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const attempt = new AbortController();
      attempts.push(attempt);
      return attempt.signal;
    });
    // The first answer's body fails as its attempt's timeout fires.
    const stalled = new ReadableStream({
      pull(controller) {
        attempts[0].abort(timedOut());
        controller.error(attempts[0].signal.reason);
      },
    });
    const fetch = vi.fn<(...sent: Sent) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(stalled, { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(Response.json([{ entity_id: "light.kitchen" }]));
    vi.stubGlobal("fetch", fetch);
    await expect(rest().getStates()).resolves.toEqual([{ entity_id: "light.kitchen" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(counted()).toEqual([["states.list", "error", "timeout", 200], ["states.list", "success", "", 200]]);
  });

  it("says how long a bulk read was given when no attempt is answered in time", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    answering(timedOut());
    await expect(rest().getHistory(["light.kitchen"], START)).rejects.toThrow(
      `Home Assistant did not respond within 30000ms (${BASE}).`);
    await expect(rest().getConfig()).rejects.toThrow(`Home Assistant did not respond within 15000ms (${BASE}).`);
  });

  it("reads the answer of a bulk read whose body takes 20 seconds to arrive", async () => {
    vi.useFakeTimers();
    // Each attempt's timeout, on the clock the test drives.
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const attempt = new AbortController();
      setTimeout(() => attempt.abort(timedOut()), ms);
      return attempt.signal;
    });
    const fetch = vi.fn(async (..._sent: Sent) => new Response(new ReadableStream({
      // The body arrives 20 seconds after the answer's headers, unless the attempt is aborted.
      start(controller) {
        const { signal } = _sent[1];
        const arrival = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify([{ entity_id: "light.kitchen" }])));
          controller.close();
        }, 20_000);
        signal?.addEventListener("abort", () => {
          clearTimeout(arrival);
          controller.error(signal.reason);
        });
      },
    }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const read = rest().getStates();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(read).resolves.toEqual([{ entity_id: "light.kitchen" }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["states.list", "success", "", 200]]);
  });

  it.each([
    ["while the answer is awaited", () => Promise.reject(new DOMException("The operation was aborted.", "AbortError"))],
    ["while the answer's body is read", async () => new Response(new ReadableStream({
      pull(controller) {
        controller.error(new DOMException("The operation was aborted.", "AbortError"));
      },
    }), { headers: { "Content-Type": "application/json" } })],
  ])("says an attempt aborted %s was not answered in time", async (_name, answer) => {
    const fetch = vi.fn<(...sent: Sent) => Promise<Response>>(answer);
    vi.stubGlobal("fetch", fetch);
    const failed = rest().renderTemplate("{{ 1 }}");
    await expect(failed).rejects.toBeInstanceOf(HomeAssistantError);
    await expect(failed).rejects.toThrow(`Home Assistant did not respond within 15000ms (${BASE}).`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an outage", new Response("", { status: 503, headers: again }), "Home Assistant returned HTTP 503: ", ["error", "http", 503]],
    ["a network failure", new TypeError("fetch failed"), `Failed to reach Home Assistant at ${BASE}: fetch failed`, ["error", "network", 0]],
  ])("sends the POST of a template once after %s", async (_name, answer, message, outcome) => {
    const fetch = answering(answer);
    await expect(rest().renderTemplate("{{ 1 }}")).rejects.toThrow(message);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["template", ...outcome]]);
  });

  it("follows no redirect, and throws one as the error of its status", async () => {
    const fetch = answering(new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/api/config" } }));
    await expect(rest().getConfig()).rejects.toMatchObject({ name: "Error", status: 302, isAuthError: false });
    expect(sent(fetch)).toEqual([["GET", `${BASE}/api/config`]]);
    expect(fetch.mock.calls.map(([, init]) => init.redirect)).toEqual(["manual"]);
    expect(counted()).toEqual([["config.get", "error", "http", 302]]);
  });

  it.each([401, 403])("throws a %i as a rejected token, sent once", async status => {
    const fetch = answering(new Response("", { status }));
    await expect(rest().getStates()).rejects.toMatchObject({
      message: "Home Assistant rejected the access token. The token may have been revoked.", status, isAuthError: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["states.list", "error", "http", status]]);
  });

  it("throws what reading a malformed body threw, and counts an answer that could not be parsed", async () => {
    answering(new Response("<html>", { headers: { "Content-Type": "application/json" } }));
    await expect(rest().getConfig()).rejects.toBeInstanceOf(SyntaxError);
    expect(counted()).toEqual([["config.get", "error", "parse", 200]]);
  });
});

describe("how a WebSocket call is counted", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", ScriptedSocket);
  });

  it("counts the handshake, then each command under its name", async () => {
    home.answer = frame => result(frame, [frame.type]);
    await expect(withWebSocket(creds, ws => ws.send({ type: "config/area_registry/list" })))
      .resolves.toEqual(["config/area_registry/list"]);
    expect(sockets.map(socket => socket.url)).toEqual(["ws://homeassistant.local:8123/api/websocket"]);
    expect(sockets[0].frames).toEqual([
      { type: "auth", access_token: TOKEN }, { type: "config/area_registry/list", id: 1 },
    ]);
    expect(counted()).toEqual([[WS_CONNECT_OPERATION, "success", "", 0], ["ws.areas.list", "success", "", 0]]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.service)).toEqual(["homeassistant", "homeassistant"]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.source)).toEqual(["gatekeeper.homeassistant.api", "gatekeeper.homeassistant.api"]);
  });

  it.each(COMMANDS)("counts the command %s as %s", async (type, name) => {
    await withWebSocket(creds, ws => ws.send({ type }));
    expect(sockets[0].frames.at(-1)).toEqual({ type, id: 1 });
    expect(counted()).toEqual([[WS_CONNECT_OPERATION, "success", "", 0], [name, "success", "", 0]]);
  });

  it("counts a service call and an event under their commands", async () => {
    await withWebSocket(creds, async ws => {
      await ws.callService("light", "turn_on", { brightness: 200 }, { entity_id: "light.kitchen" });
      await ws.fireEvent("doorbell_pressed", { door: "front" });
    });
    expect(sockets[0].frames.slice(1)).toEqual([
      { type: "call_service", domain: "light", service: "turn_on", service_data: { brightness: 200 }, target: { entity_id: "light.kitchen" }, id: 1 },
      { type: "fire_event", event_type: "doorbell_pressed", event_data: { door: "front" }, id: 2 },
    ]);
    expect(counted().slice(1)).toEqual([["ws.services.call", "success", "", 0], ["ws.events.fire", "success", "", 0]]);
  });

  it("counts a command outside the table as any other", async () => {
    const type: string = "supervisor/api";
    await withWebSocket(creds, ws => ws.send({ type: type as WsCommandType }));
    expect(counted()).toEqual([[WS_CONNECT_OPERATION, "success", "", 0], [WS_OTHER_OPERATION, "success", "", 0]]);
  });

  it("counts a result that reports a failure as an error of the API, and throws it", async () => {
    home.answer = failure;
    const failed = withWebSocket(creds, ws => ws.send({ type: "lovelace/config", url_path: "missing" }));
    await expect(failed).rejects.toBeInstanceOf(HomeAssistantError);
    await expect(failed).rejects.toThrow("Home Assistant WS command failed (unknown_command): Unknown command.");
    expect(counted()).toEqual([[WS_CONNECT_OPERATION, "success", "", 0], ["ws.dashboard-config.get", "error", "api", 0]]);
  });

  it("counts a command the socket closed under as a network error", async () => {
    home.answer = () => "close";
    await expect(withWebSocket(creds, ws => ws.callService("light", "turn_on")))
      .rejects.toThrow("Home Assistant WebSocket closed unexpectedly.");
    expect(counted()).toEqual([[WS_CONNECT_OPERATION, "success", "", 0], ["ws.services.call", "error", "network", 0]]);
  });

  it("does not count the commands left pending when the gatekeeper closes the socket", async () => {
    // The area list reports a failure, which ends the snapshot while the other lists are pending.
    home.answer = frame => (frame.type === "config/area_registry/list" ? failure(frame) : undefined);
    answering(Response.json([]));
    await expect(fetchRegistrySnapshot(creds)).rejects.toThrow("Home Assistant WS command failed (unknown_command)");
    expect(sockets[0].frames.slice(1).map(frame => frame.type)).toEqual([
      "config/area_registry/list", "config/floor_registry/list", "config/label_registry/list",
      "config/device_registry/list", "config/entity_registry/list",
    ]);
    expect(counted()).toEqual([
      ["states.list", "success", "", 200],
      [WS_CONNECT_OPERATION, "success", "", 0],
      ["ws.areas.list", "error", "api", 0],
    ]);
  });

  it("counts a registry list answered a success that holds no list as an api error, and fails the snapshot", async () => {
    home.answer = frame => (frame.type === "config/device_registry/list" ? result(frame, {}) : result(frame, []));
    answering(Response.json([]));
    await expect(fetchRegistrySnapshot(creds)).rejects.toThrow("Home Assistant answered config/device_registry/list with no list.");
    expect(counted()).toContainEqual(["ws.devices.list", "error", "api", 0]);
    expect(counted()).toContainEqual(["ws.areas.list", "success", "", 0]);
  });

  it("does not count a command the socket threw on, which was not sent", async () => {
    home.refuses = true;
    await expect(withWebSocket(creds, ws => ws.fireEvent("doorbell_pressed"))).rejects.toThrow("the socket is closing");
    expect(counted()).toEqual([[WS_CONNECT_OPERATION, "success", "", 0]]);
  });

  it("does not count a command given to a socket that has closed", async () => {
    const ws = await HomeAssistantWebSocket.connect(creds);
    await ws.close();
    await expect(ws.send({ type: "lovelace/resources" })).rejects.toThrow("WebSocket is closed.");
    expect(sockets[0].frames).toEqual([{ type: "auth", access_token: TOKEN }]);
    expect(counted()).toEqual([[WS_CONNECT_OPERATION, "success", "", 0]]);
  });

  it.each<[string, Home["auth"], string, string, boolean]>([
    ["a refused token", "invalid", "auth", "Home Assistant rejected the access token: Invalid access token", true],
    ["a close for a policy violation", { close: 1008 }, "auth", "Home Assistant WebSocket closed before auth completed: 1008 ", true],
    ["any other close", { close: 1006 }, "network", "Home Assistant WebSocket closed before auth completed: 1006 ", false],
    ["a socket error", "error", "network", "Home Assistant WebSocket error during auth.", false],
  ])("counts a handshake that ends in %s as an error, and throws it", async (_name, auth, reason, message, isAuthError) => {
    home.auth = auth;
    const ran = vi.fn(async () => undefined);
    await expect(withWebSocket(creds, ran)).rejects.toMatchObject({ message, isAuthError });
    expect(ran).not.toHaveBeenCalled();
    expect(counted()).toEqual([[WS_CONNECT_OPERATION, "error", reason, 0]]);
  });

  it("counts a handshake the instance does not finish in 15 seconds as a timeout", async () => {
    vi.useFakeTimers();
    home.auth = "silent";
    const failed = HomeAssistantWebSocket.connect(creds);
    const settled = expect(failed).rejects.toThrow(
      "Home Assistant WebSocket auth handshake did not complete within 15000ms (ws://homeassistant.local:8123/api/websocket).");
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
    expect(counted()).toEqual([[WS_CONNECT_OPERATION, "error", "timeout", 0]]);
  });

  it("counts a registry snapshot as one REST request, one handshake and five commands", async () => {
    home.answer = frame => (frame.type.includes("floor") ? failure(frame) : result(frame, []));
    const fetch = answering(Response.json([{ entity_id: "light.kitchen", state: "on" }]));
    const snapshot = await fetchRegistrySnapshot(creds);
    expect(snapshot.floors).toEqual([]);
    expect([...snapshot.states.keys()]).toEqual(["light.kitchen"]);
    expect(sent(fetch)).toEqual([["GET", `${BASE}/api/states`]]);
    expect(counted()).toEqual([
      ["states.list", "success", "", 200],
      [WS_CONNECT_OPERATION, "success", "", 0],
      ["ws.areas.list", "success", "", 0],
      ["ws.floors.list", "error", "api", 0],
      ["ws.labels.list", "success", "", 0],
      ["ws.devices.list", "success", "", 0],
      ["ws.entities.list", "success", "", 0],
    ]);
  });

  it("writes nothing of the instance's address, the token, an entity or an error into a point", async () => {
    home.answer = frame => (frame.type === "call_service" ? failure(frame) : result(frame, []));
    answering(Response.json({}), new Response("light.kitchen is unknown", { status: 404 }));
    await rest().getState("light.kitchen");
    await expect(rest().getState("light.kitchen")).rejects.toThrow("HTTP 404");
    await expect(withWebSocket(creds, ws => ws.callService("light", "turn_on", undefined, { entity_id: "light.kitchen" })))
      .rejects.toThrow("unknown_command");
    expect(counted()).toEqual([
      ["states.get", "success", "", 200], ["states.get", "error", "http", 404],
      [WS_CONNECT_OPERATION, "success", "", 0], ["ws.services.call", "error", "api", 0],
    ]);
    const written = JSON.stringify(points.map(point => point.blobs));
    for (const secret of ["homeassistant.local", "8123", TOKEN, "light.kitchen", "turn_on", "unknown", "Unknown"]) {
      expect(written).not.toContain(secret);
    }
  });
});

describe("the calls of one apply or revert", () => {
  const lounge = [{ entity_id: "switch.plug", area_id: "lounge", platform: "hue" }];
  const turnOn = {
    id: 1, type: "callService", domain: "switch", service: "turn_on", target: { area_id: "lounge" },
    origin: { kind: "session" },
  };

  beforeEach(() => {
    vi.stubGlobal("WebSocket", ScriptedSocket);
    home.answer = frame => {
      if (frame.type === "config/area_registry/list") return result(frame, [{ area_id: "lounge" }]);
      return result(frame, frame.type === "config/entity_registry/list" ? lounge : []);
    };
  });

  it("writes one point per kind of call for an apply, which reads the registry twice", async () => {
    const fetch = answering(Response.json([{ entity_id: "switch.plug", state: "off", attributes: {} }]));
    const { gk, kv } = gatekeeper({ "pending:1": { id: 1, submittedAt: 0, autoApprovable: true, action: turnOn } });
    await gk.applyAction(1);
    expect(kv.has("applied:1")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(3);
    expect(callsByOperation()).toEqual([
      ["states.list", 2], ["ws.areas.list", 2], [WS_CONNECT_OPERATION, 3], ["ws.devices.list", 2],
      ["ws.entities.list", 2], ["ws.floors.list", 2], ["ws.labels.list", 2], ["ws.services.call", 1],
    ]);
  });

  it("writes one point for the service calls of a revert, however many entities it restores", async () => {
    const previous = ["switch.plug", "switch.lamp", "switch.fan", "switch.heater"]
      .map(entityId => ({ entityId, state: "off", attributes: {} }));
    const { gk } = gatekeeper({
      "applied:1": { id: 1, action: turnOn, appliedAt: 0, revertInfo: { type: "stateSnapshot", previous, originalAction: turnOn } },
    });
    await expect(gk.revertAction(1)).resolves.toBeUndefined();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].frames.slice(1).map(frame => [frame.type, frame.service, frame.target])).toEqual(
      previous.map(({ entityId }) => ["call_service", "turn_off", { entity_id: entityId }]));
    expect(callsByOperation()).toEqual([[WS_CONNECT_OPERATION, 1], ["ws.services.call", 4]]);
  });
});
