// Helpers for the approval / action lifecycle of the Home Assistant gatekeeper.
//
// Responsibilities split out from `homeassistant.ts` to keep that file manageable:
// - `describeAction()` — produces a human-readable ActionDescription from a raw action,
//   given a registry snapshot for name lookups.
// - `canRevert()` — returns whether we know how to undo this action.
// - `resolveTargets()` — expands an HA service-call target into the concrete set of
//   affected entity_ids using the registry snapshot.
// - `applyRevertForEntity()` — given a captured prior state and the original action,
//   issues the inverse service call to restore that state.
// - `executeAction()` — actually performs the action against HA (REST or WS).

import { buildDescription, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  HomeAssistantWebSocket,
  withWebSocket,
  type HomeAssistantCredentials,
  type RegistrySnapshot,
} from "./homeassistant-api";
import { resolveTargets } from "./registry-utils";
import type { HATarget, HomeAssistantAction } from "./homeassistant";

export { resolveTargets };

// ---------------------------------------------------------------------------
// Helpers

function asArray(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function entityFriendlyName(entityId: string, registry: RegistrySnapshot): string {
  const reg = registry.entities.find((e: any) => e.entity_id === entityId);
  const state = registry.states.get(entityId);
  return (
    reg?.name ??
    reg?.original_name ??
    state?.attributes?.friendly_name ??
    entityId
  );
}

function areaName(areaId: string, registry: RegistrySnapshot): string {
  const area = registry.areas.find((a: any) => a.area_id === areaId);
  return area?.name ?? areaId;
}

function labelName(labelId: string, registry: RegistrySnapshot): string {
  const label = registry.labels.find((l: any) => l.label_id === labelId);
  return label?.name ?? labelId;
}

function deviceName(deviceId: string, registry: RegistrySnapshot): string {
  const device = registry.devices.find((d: any) => d.id === deviceId);
  return device?.name_by_user ?? device?.name ?? deviceId;
}

// ---------------------------------------------------------------------------
// Revertibility

// Service names whose effect we know how to reverse via the prior-state snapshot.
const REVERSIBLE_SERVICES = new Set([
  "turn_on",
  "turn_off",
  "toggle",
  "set_temperature",
  "set_hvac_mode",
  "set_fan_mode",
  "set_cover_position",
  "open_cover",
  "close_cover",
  "stop_cover",
  "lock",
  "unlock",
  "volume_set",
  "volume_mute",
  "set_value",
  "set_percentage",
  "select_option",
  "set_datetime",
]);

export function canRevert(action: HomeAssistantAction): boolean {
  switch (action.type) {
    case "callService":
      return REVERSIBLE_SERVICES.has(action.service);
    case "saveDashboard":
      return true;
    case "fireEvent":
      return false;
  }
}

// ---------------------------------------------------------------------------
// Description authoring

export function describeAction(
  action: HomeAssistantAction,
  registry: RegistrySnapshot,
): ActionDescription {
  switch (action.type) {
    case "callService":
      return describeCallService(action, registry);
    case "fireEvent":
      return describeFireEvent(action);
    case "saveDashboard":
      return describeSaveDashboard(action);
  }
}

function describeCallService(
  action: HomeAssistantAction & { type: "callService" },
  registry: RegistrySnapshot,
): ActionDescription {
  const { domain, service, data, target, origin } = action;

  // Safety net: if validation upstream missed something, never let `[object Object]` or
  // `undefined` leak into the approval card title.
  if (typeof domain !== "string" || !domain || typeof service !== "string" || !service) {
    return {
      title: "Invalid service call",
      description:
        `The gatekeeper received a malformed callService action ` +
        `(domain=${JSON.stringify(domain)}, service=${JSON.stringify(service)}). ` +
        `This indicates a programming error in the gadget that called callService(); ` +
        `it likely passed a single options object instead of positional arguments.`,
      implementsRevert: false,
    };
  }

  // Compute the total number of distinct entities affected by this call. Used to enrich
  // titles for area / label / device scopes (where one ID can fan out to many entities), and
  // to display per-area / per-label counts when the target uses only that one dimension.
  const affectedEntities = target ? resolveTargets(target, registry) : new Set<string>();
  const affectedEntityCount = affectedEntities.size;

  // True iff `target` mentions ONLY the given dimension (and nothing else). When this holds,
  // `affectedEntityCount` is exactly the count for that dimension and we can reuse it without
  // a second resolveTargets call.
  const targetDimensions = target
    ? (["entity_id", "device_id", "area_id", "label_id", "floor_id"] as const).filter(
        (k) => target[k] != null,
      )
    : [];
  const targetIsExclusively = (dim: keyof HATarget) =>
    targetDimensions.length === 1 && targetDimensions[0] === dim;

  // "What is targeted", for the title only: titles are plain text, while the description lists
  // the same ids in fields so no registry or agent text sits in its prose.
  let targetText = "";
  if (target) {
    const parts: string[] = [];
    if (target.entity_id) {
      const ids = asArray(target.entity_id);
      if (ids.length === 1) {
        parts.push(`${entityFriendlyName(ids[0], registry)} (\`${ids[0]}\`)`);
      } else {
        parts.push(`${ids.length} entities (${ids.map((id) => `\`${id}\``).join(", ")})`);
      }
    }
    if (target.device_id) {
      const ids = asArray(target.device_id);
      parts.push(
        ids.length === 1
          ? `device "${deviceName(ids[0], registry)}" (\`${ids[0]}\`)`
          : `${ids.length} devices (${ids.map((id) => `\`${id}\``).join(", ")})`,
      );
    }
    if (target.area_id) {
      const ids = asArray(target.area_id);
      // If the target uses only area_id, the full affected-entity set IS the per-area count.
      // Otherwise we'd need a separate resolveTargets call to isolate the area dimension —
      // skip that for simplicity and just print the area name without a count in mixed cases.
      const includeCount = ids.length === 1 && targetIsExclusively("area_id");
      parts.push(
        ids.length === 1
          ? includeCount
            ? `area "${areaName(ids[0], registry)}" (\`${ids[0]}\`, ${affectedEntityCount} entities)`
            : `area "${areaName(ids[0], registry)}" (\`${ids[0]}\`)`
          : `${ids.length} areas (${ids.map((id) => `\`${id}\``).join(", ")})`,
      );
    }
    if (target.label_id) {
      const ids = asArray(target.label_id);
      const includeCount = ids.length === 1 && targetIsExclusively("label_id");
      parts.push(
        ids.length === 1
          ? includeCount
            ? `label "${labelName(ids[0], registry)}" (\`${ids[0]}\`, ${affectedEntityCount} entities)`
            : `label "${labelName(ids[0], registry)}" (\`${ids[0]}\`)`
          : `${ids.length} labels (${ids.map((id) => `\`${id}\``).join(", ")})`,
      );
    }
    if (target.floor_id) {
      parts.push(`floor ${asArray(target.floor_id).join(", ")}`);
    }
    targetText = parts.join(", ");
  }

  // For multi-entity scopes (area / label / device), append an entity count to the title so
  // the approver immediately sees the blast radius.
  const fanOutSuffix =
    (origin.kind === "area" || origin.kind === "label" || origin.kind === "device") &&
    affectedEntityCount > 1
      ? ` (${affectedEntityCount} entities)`
      : "";

  // Title — prefer a concise human-friendly form when we can.
  let title: string;
  if (origin.kind === "entity") {
    const name = entityFriendlyName(origin.entityId, registry);
    title = `${humanizeService(domain, service)}: ${name}`;
  } else if (origin.kind === "area") {
    title = `${humanizeService(domain, service)} in area "${areaName(origin.areaId, registry)}"${fanOutSuffix}`;
  } else if (origin.kind === "label") {
    title = `${humanizeService(domain, service)} for label "${labelName(origin.labelId, registry)}"${fanOutSuffix}`;
  } else if (origin.kind === "device") {
    title = `${humanizeService(domain, service)} on device "${deviceName(origin.deviceId, registry)}"${fanOutSuffix}`;
  } else {
    title = `Call ${domain}.${service}`;
    if (targetText) title += ` on ${targetText}`;
  }

  // Description: the lists name each targeted id beside its registry name, and the JSON is the
  // exact target and data the call sends. Service, ids and names are agent or registry text, so
  // they sit in fields, never in the prose.
  const builder = buildDescription("Calls a Home Assistant service.")
    .inline("Service", `${domain}.${service}`);
  if (target) {
    const named = (ids: string[], name: (id: string) => string) =>
      ids.map((id) => (name(id) === id ? id : `${id} (${name(id)})`));
    const entities = asArray(target.entity_id);
    const devices = asArray(target.device_id);
    const areas = asArray(target.area_id);
    const labels = asArray(target.label_id);
    const floors = asArray(target.floor_id);
    if (entities.length) {
      builder.list("Entities", named(entities, (id) => entityFriendlyName(id, registry)));
    }
    if (devices.length) builder.list("Devices", named(devices, (id) => deviceName(id, registry)));
    if (areas.length) builder.list("Areas", named(areas, (id) => areaName(id, registry)));
    if (labels.length) builder.list("Labels", named(labels, (id) => labelName(id, registry)));
    if (floors.length) builder.list("Floors", floors);
    if (!targetIsExclusively("entity_id") && affectedEntityCount > 0) {
      builder.prose(
        `The target currently resolves to ${affectedEntityCount} ` +
        `entit${affectedEntityCount === 1 ? "y" : "ies"}.`);
    }
    builder.json("Target", target);
  }
  if (data && Object.keys(data).length > 0) builder.json("Service data", data);

  return {
    // Titles name every target ID, so an unbounded target list is capped here.
    title: sanitizeTitle(title),
    ...builder.finish(),
    implementsRevert: canRevert(action),
  };
}

function describeFireEvent(action: HomeAssistantAction & { type: "fireEvent" }): ActionDescription {
  const builder = buildDescription("Fires an event on the Home Assistant event bus.")
    .inline("Event", action.eventType);
  if (action.data && Object.keys(action.data).length > 0) builder.json("Event data", action.data);
  return {
    title: sanitizeTitle(`Fire event: ${action.eventType}`),
    ...builder.finish(),
    implementsRevert: false,
  };
}

function describeSaveDashboard(
  action: HomeAssistantAction & { type: "saveDashboard" },
): ActionDescription {
  const config = action.config as { title?: string; views?: unknown[] } | undefined;
  const urlLabel = action.urlPath ?? "lovelace (default)";
  const viewCount = Array.isArray(config?.views) ? config!.views!.length : 0;
  const cardCount = countCards(config);
  const title = config?.title ? `${config.title}` : urlLabel;
  return {
    title: sanitizeTitle(`Edit dashboard: ${title}`),
    // A configuration too large for the budget is truncated and, as intended, incomplete.
    ...buildDescription(
      `Replaces the configuration of a Lovelace dashboard ` +
      `with ${viewCount} view${viewCount === 1 ? "" : "s"} and ${cardCount} card${cardCount === 1 ? "" : "s"}.`)
      .inline("Dashboard", urlLabel)
      .json("Dashboard configuration", action.config)
      .finish(),
    implementsRevert: true,
  };
}

function countCards(config: any): number {
  if (!config || !Array.isArray(config.views)) return 0;
  let count = 0;
  for (const view of config.views) {
    if (Array.isArray(view?.cards)) count += view.cards.length;
    if (Array.isArray(view?.sections)) {
      for (const section of view.sections) {
        if (Array.isArray(section?.cards)) count += section.cards.length;
      }
    }
  }
  return count;
}

// Maps "<domain>.<service>" to a friendlier verb phrase for titles.
function humanizeService(domain: string, service: string): string {
  const key = `${domain}.${service}`;
  switch (key) {
    case "light.turn_on":
    case "switch.turn_on":
    case "fan.turn_on":
    case "input_boolean.turn_on":
    case "automation.turn_on":
    case "humidifier.turn_on":
      return `Turn on ${domain}`;
    case "light.turn_off":
    case "switch.turn_off":
    case "fan.turn_off":
    case "input_boolean.turn_off":
    case "automation.turn_off":
    case "humidifier.turn_off":
      return `Turn off ${domain}`;
    case "light.toggle":
    case "switch.toggle":
    case "fan.toggle":
    case "input_boolean.toggle":
    case "automation.toggle":
      return `Toggle ${domain}`;
    case "cover.open_cover":
      return "Open cover";
    case "cover.close_cover":
      return "Close cover";
    case "cover.stop_cover":
      return "Stop cover";
    case "cover.set_cover_position":
      return "Set cover position";
    case "climate.set_temperature":
      return "Set temperature";
    case "climate.set_hvac_mode":
      return "Set HVAC mode";
    case "climate.set_fan_mode":
      return "Set fan mode";
    case "lock.lock":
      return "Lock";
    case "lock.unlock":
      return "Unlock";
    case "media_player.media_play":
      return "Play media";
    case "media_player.media_pause":
      return "Pause media";
    case "media_player.media_stop":
      return "Stop media";
    case "media_player.media_next_track":
      return "Next track";
    case "media_player.media_previous_track":
      return "Previous track";
    case "media_player.volume_set":
      return "Set volume";
    case "media_player.volume_mute":
      return "Mute";
    case "media_player.play_media":
      return "Play media";
    case "fan.set_percentage":
      return "Set fan speed";
    case "vacuum.start":
      return "Start vacuum";
    case "vacuum.stop":
      return "Stop vacuum";
    case "vacuum.return_to_base":
      return "Return vacuum to base";
    case "vacuum.locate":
      return "Locate vacuum";
    case "scene.turn_on":
      return "Activate scene";
    case "script.turn_on":
      return "Run script";
    case "button.press":
    case "input_button.press":
      return "Press button";
    case "input_number.set_value":
    case "number.set_value":
      return "Set number value";
    case "input_text.set_value":
    case "text.set_value":
      return "Set text value";
    case "input_select.select_option":
    case "select.select_option":
      return "Select option";
    case "input_datetime.set_datetime":
      return "Set date/time";
    case "automation.trigger":
      return "Trigger automation";
    case "automation.reload":
      return "Reload automations";
    case "notify.send_message":
      return "Send notification";
    default:
      return `Call ${key}`;
  }
}

// ---------------------------------------------------------------------------
// Action execution (called from applyAction)
//
// All side-effecting actions go through the Home Assistant WebSocket API. The WS API is HA's
// modern path; it supports the full target shape (entity_id, device_id, area_id, label_id,
// floor_id) cleanly, unlike the REST equivalent which has historical quirks (the REST POST
// /api/services/<domain>/<service> endpoint expects target fields flattened at the top level
// of the body, not nested under a `target` key, and has uneven support for area/label/floor
// targets across HA versions).

export async function executeAction(
  action: HomeAssistantAction,
  creds: HomeAssistantCredentials,
): Promise<void> {
  await withWebSocket(creds, async (ws) => {
    switch (action.type) {
      case "callService": {
        await ws.callService(action.domain, action.service, action.data, action.target);
        return;
      }
      case "fireEvent": {
        await ws.fireEvent(action.eventType, action.data);
        return;
      }
      case "saveDashboard": {
        await ws.send({
          type: "lovelace/config/save",
          url_path: action.urlPath,
          config: action.config,
        });
        return;
      }
    }
  });
}

/** Fetch the current dashboard config so we can store it as revert info. */
export async function fetchDashboardConfig(
  urlPath: string | null,
  creds: HomeAssistantCredentials,
): Promise<unknown> {
  return await withWebSocket(creds, async (ws) => {
    return await ws.send<unknown>({ type: "lovelace/config", url_path: urlPath });
  });
}

// ---------------------------------------------------------------------------
// Revert execution
//
// The caller (HomeAssistantGatekeeperImpl.revertAction) opens a single WebSocket and calls this
// helper once per entity in the prior-state snapshot, so we keep the WS connection open across
// all reverts.

export async function applyRevertForEntity(
  prev: { entityId: string; state: string; attributes: Record<string, unknown> },
  originalAction: HomeAssistantAction & { type: "callService" },
  ws: HomeAssistantWebSocket,
): Promise<void> {
  const domain = prev.entityId.split(".")[0];
  const target = { entity_id: prev.entityId };

  switch (originalAction.service) {
    case "turn_on":
    case "turn_off":
    case "toggle": {
      if (prev.state === "on") {
        const data = restorableOnAttrs(prev.attributes, domain);
        await ws.callService(domain, "turn_on", data, target);
      } else {
        await ws.callService(domain, "turn_off", undefined, target);
      }
      return;
    }
    case "set_temperature": {
      const data: Record<string, unknown> = {};
      if (prev.attributes.temperature != null) {
        data.temperature = prev.attributes.temperature;
      }
      if (prev.attributes.target_temp_low != null) {
        data.target_temp_low = prev.attributes.target_temp_low;
      }
      if (prev.attributes.target_temp_high != null) {
        data.target_temp_high = prev.attributes.target_temp_high;
      }
      if (Object.keys(data).length === 0) {
        throw new Error("Cannot revert: prior climate setpoint is unknown.");
      }
      await ws.callService("climate", "set_temperature", data, target);
      return;
    }
    case "set_hvac_mode": {
      await ws.callService("climate", "set_hvac_mode", { hvac_mode: prev.state }, target);
      return;
    }
    case "set_fan_mode": {
      const fanMode = prev.attributes.fan_mode;
      if (fanMode == null) throw new Error("Cannot revert: prior fan mode is unknown.");
      await ws.callService("climate", "set_fan_mode", { fan_mode: fanMode }, target);
      return;
    }
    case "set_cover_position":
    case "open_cover":
    case "close_cover":
    case "stop_cover": {
      const position = prev.attributes.current_position;
      if (position == null) {
        if (prev.state === "open") {
          await ws.callService("cover", "open_cover", undefined, target);
        } else if (prev.state === "closed") {
          await ws.callService("cover", "close_cover", undefined, target);
        } else {
          throw new Error("Cannot revert: prior cover position is unknown.");
        }
        return;
      }
      await ws.callService("cover", "set_cover_position", { position }, target);
      return;
    }
    case "lock":
    case "unlock": {
      // Restore the captured prior state rather than always inverting — otherwise a no-op
      // apply (locking an already-locked door) would still flip the lock on revert.
      if (prev.state === "locked") {
        await ws.callService("lock", "lock", undefined, target);
      } else if (prev.state === "unlocked") {
        await ws.callService("lock", "unlock", undefined, target);
      } else {
        // Other states ("locking", "unlocking", "jammed") have no clean way to restore.
        throw new Error(`Cannot revert: prior lock state was "${prev.state}".`);
      }
      return;
    }
    case "volume_set": {
      const v = prev.attributes.volume_level;
      if (typeof v !== "number") throw new Error("Cannot revert: prior volume unknown.");
      await ws.callService("media_player", "volume_set", { volume_level: v }, target);
      return;
    }
    case "volume_mute": {
      const muted = prev.attributes.is_volume_muted;
      if (typeof muted !== "boolean") throw new Error("Cannot revert: prior mute state unknown.");
      await ws.callService("media_player", "volume_mute", { is_volume_muted: muted }, target);
      return;
    }
    case "set_value": {
      // input_number, number, input_text, text — the canonical value lives in `state`.
      await ws.callService(domain, "set_value", { value: parseNumberOrText(prev.state) }, target);
      return;
    }
    case "set_percentage": {
      // fan.
      await ws.callService(domain, "set_percentage", { percentage: Number(prev.state) }, target);
      return;
    }
    case "select_option": {
      await ws.callService(domain, "select_option", { option: prev.state }, target);
      return;
    }
    case "set_datetime": {
      // For input_datetime entities, `state` is "YYYY-MM-DD HH:MM:SS" or similar.
      // Pass it back as `datetime`.
      await ws.callService(domain, "set_datetime", { datetime: prev.state }, target);
      return;
    }
    default:
      throw new Error(`Cannot revert action: unknown service "${originalAction.service}".`);
  }
}

// Pick attributes that are useful to restore when reverting a turn_off back to on (or vice
// versa). Returns undefined if no special attrs apply (caller will pass undefined data).
function restorableOnAttrs(attrs: Record<string, unknown>, domain: string): Record<string, unknown> | undefined {
  if (domain !== "light") return undefined;
  const out: Record<string, unknown> = {};
  if (attrs.brightness != null) out.brightness = attrs.brightness;
  if (Array.isArray(attrs.rgb_color)) out.rgb_color = attrs.rgb_color;
  else if (Array.isArray(attrs.hs_color)) out.hs_color = attrs.hs_color;
  else if (Array.isArray(attrs.xy_color)) out.xy_color = attrs.xy_color;
  else if (attrs.color_temp != null) out.color_temp = attrs.color_temp;
  else if (attrs.color_temp_kelvin != null) out.color_temp_kelvin = attrs.color_temp_kelvin;
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseNumberOrText(state: string): number | string {
  const n = Number(state);
  if (!Number.isNaN(n) && state.trim() !== "") return n;
  return state;
}
