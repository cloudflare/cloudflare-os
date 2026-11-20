// Home Assistant's API as this gatekeeper's upstream: the paths it calls and the WebSocket commands
// it sends, by which a call is named, and the client every call to an instance goes through and is
// counted by (`subservice/v1` points under the source `gatekeeper.homeassistant.api`). An instance's
// address is the user's own, so a name is a key of the tree or a literal of this file: no host, base
// path, entity id or timestamp reaches a point.

import { ID, ONE, REST, routeOperation, type Routes } from "@gadgets/gatekeeper-kit/route-operation";
import { defineUpstream } from "@gadgets/gatekeeper-kit/upstream";

/**
 * Milliseconds each attempt of a REST request may take, the reading of its answer included. A slow
 * or unreachable instance would otherwise hold the Worker until the platform's deadline.
 */
export const HA_REST_TIMEOUT_MS = 15_000;

/**
 * Milliseconds each attempt of a bulk read may take: every state, a history and a logbook, whose
 * answers grow with the instance and the period asked for and can take longer to arrive than they
 * took to start. It is the client's default for one attempt.
 */
export const HA_BULK_READ_TIMEOUT_MS = 30_000;

/**
 * The root the paths of `HA_ROUTES` are under. It stands for the `<base>/api/` of every instance,
 * whose own base is no part of a name (`apiAddress`).
 */
export const HA_API_ROOT = "https://homeassistant.invalid/api/";

/** The name of a GET of the API's root itself, which answers that the API is running. */
export const HA_ROOT_OPERATION = "api.get";

/**
 * The REST paths this gatekeeper calls under an instance's `/api/`. A request is named by the last
 * resource of its path and what is done to it: `states.list`, `states.get`, `period.get` for the
 * history of a period, and `template` for the rendering of one. The start of a history period and
 * of a logbook is a timestamp, whose colons make it the rest of the path and no single segment. A
 * request to a path that is not here is counted under its HTTP method: add the path to name it.
 */
export const HA_ROUTES: Routes = [[HA_API_ROOT, {
  config: ONE,
  states: { [ID]: {} },
  services: {},
  template: "POST",
  history: { period: { [REST]: {} } },
  logbook: { [REST]: {} },
}]];

/**
 * The address a request has under `HA_API_ROOT`: its path after the last `/api/`, whatever the
 * instance's host and base path are. No path this gatekeeper sends holds a second `/api/` after
 * the API's own, so the last one is where the API's path starts, even under a base path that
 * holds one too.
 * @param url The request's URL.
 * @returns The address, or undefined for a URL that has no `/api/` in its path.
 */
export function apiAddress(url: URL): URL | undefined {
  const at = url.pathname.lastIndexOf("/api/");
  if (at < 0) return undefined;
  return URL.parse(HA_API_ROOT + url.pathname.slice(at + "/api/".length)) ?? undefined;
}

/**
 * Names a REST request by its path under the instance's `/api/`: `HA_ROOT_OPERATION` for a GET of
 * the root itself, and what `HA_ROUTES` give for a path under it.
 * @param method The HTTP method, in upper case.
 * @param url The request's URL.
 * @returns The name, or undefined for a request that has none.
 */
export function haOperation(method: string, url: URL): string | undefined {
  const address = apiAddress(url);
  if (!address) return undefined;
  if (address.href === HA_API_ROOT) return method === "GET" ? HA_ROOT_OPERATION : undefined;
  return routeOperation(HA_ROUTES, method, address);
}

/**
 * The WebSocket commands this gatekeeper sends, by the `type` of each, and the name each is counted
 * under. A WebSocket has no path, so a command's name is the literal here.
 */
export const WS_COMMAND_OPERATIONS = {
  "config/area_registry/list": "ws.areas.list",
  "config/floor_registry/list": "ws.floors.list",
  "config/label_registry/list": "ws.labels.list",
  "config/device_registry/list": "ws.devices.list",
  "config/entity_registry/list": "ws.entities.list",
  "call_service": "ws.services.call",
  "fire_event": "ws.events.fire",
  "lovelace/dashboards/list": "ws.dashboards.list",
  "lovelace/resources": "ws.dashboard-resources.list",
  "lovelace/config": "ws.dashboard-config.get",
  "lovelace/config/save": "ws.dashboard-config.save",
} as const;

/** The `type` of a WebSocket command this gatekeeper sends: a key of `WS_COMMAND_OPERATIONS`. */
export type WsCommandType = keyof typeof WS_COMMAND_OPERATIONS;

/** The name of the opening of a WebSocket: its handshake, up to the instance's answer to the token. */
export const WS_CONNECT_OPERATION = "ws.connect";

/** The name of a WebSocket command whose `type` is not in `WS_COMMAND_OPERATIONS`. */
export const WS_OTHER_OPERATION = "ws.other";

/** Every name a WebSocket call is counted under. */
export const WS_OPERATIONS = [
  WS_CONNECT_OPERATION, ...Object.values(WS_COMMAND_OPERATIONS), WS_OTHER_OPERATION,
] as const;

/** A name of `WS_OPERATIONS`. */
export type WsOperation = typeof WS_OPERATIONS[number];

/**
 * The name a WebSocket command is counted under, from a closed table: the command's `type` is
 * looked up and never written.
 * @param type The command's `type`.
 * @returns The command's name, or `WS_OTHER_OPERATION` for a type that is not in the table.
 */
export function wsOperation(type: string): WsOperation {
  return Object.hasOwn(WS_COMMAND_OPERATIONS, type)
    ? WS_COMMAND_OPERATIONS[type as WsCommandType] : WS_OTHER_OPERATION;
}

/**
 * The client every call to a Home Assistant instance goes through. A REST request has
 * `HA_REST_TIMEOUT_MS` for each attempt (a bulk read asks for `HA_BULK_READ_TIMEOUT_MS`), is sent
 * again after a transient failure where it is a GET, and follows no redirect: the long-lived token goes to the base the user gave and nowhere a
 * redirect points. A WebSocket's handshake and its commands are counted through `call`, each under
 * its name of `WS_OPERATIONS`.
 */
export const homeassistantUpstream = defineUpstream({
  vendorId: "homeassistant",
  operation: haOperation,
  timeoutMs: HA_REST_TIMEOUT_MS,
});
