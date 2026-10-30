// Auto-approval verdicts for Home Assistant actions.
//
// A user's "always approve" rule is keyed on an action kind's tag, and an action is auto-applied
// only when its own verdict is also true. Device control and dashboard edits can be true; every
// other service call, every event, and anything this module cannot classify is false under the
// separate `call-service` / `fire-event` kinds, so a rule enabled for "Control devices" never
// covers them. A dashboard edit that could make a browser load an agent-chosen address is false.

import type { ActionDescription, ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import type { RegistrySnapshot } from "./homeassistant-api";
import type { HATarget, HomeAssistantAction, HomeAssistantResourceKind } from "./homeassistant";

/** Service calls that only change the physical state of the user's own devices. */
export const CONTROL_DEVICES_KIND: ActionKind = { tag: "control-devices", label: "Control devices" };
/** Every other service call: one kind would cover scripts, restarts, unlocks and notifications. */
export const CALL_SERVICE_KIND: ActionKind = { tag: "call-service", label: "Call Home Assistant services" };
/** Bus events: any automation can trigger on one, so their effect is unbounded. */
export const FIRE_EVENT_KIND: ActionKind = { tag: "fire-event", label: "Fire events" };
/** Lovelace layout edits, which revert exactly to the snapshot taken at apply time. */
export const EDIT_DASHBOARDS_KIND: ActionKind = { tag: "edit-dashboards", label: "Edit dashboards" };

/**
 * The kinds whose actions can carry `autoApprovable: true` on a binding, for
 * getAutoApprovableActions(). Dashboards are reachable only from the whole-instance session. An
 * entity binding only calls services in its own domain, so one whose domain has no allow-listed
 * service (a lock, alarm panel, script or scene) can never control devices without review.
 */
export function autoApprovableKinds(resourceKind: HomeAssistantResourceKind, resourceId?: string): ActionKind[] {
  switch (resourceKind) {
    case "instance":
      return [CONTROL_DEVICES_KIND, EDIT_DASHBOARDS_KIND];
    case "entity":
      return DEVICE_CONTROL_DOMAINS.has(resourceId?.split(".")[0] ?? "") ? [CONTROL_DEVICES_KIND] : [];
    default:
      return [CONTROL_DEVICES_KIND];
  }
}

/**
 * The kind and verdict of a dashboard save. False when the configuration could make a browser
 * showing the dashboard contact a host the agent picked, since such an address can carry Home
 * Assistant data in it the moment anyone opens the dashboard.
 */
export function dashboardVerdict(config: unknown): Pick<ActionDescription, "actionKind" | "autoApprovable"> {
  return { actionKind: EDIT_DASHBOARDS_KIND, autoApprovable: isSelfContained(config, 0) };
}

// Strings that can name or build an address off the Home Assistant origin, tested after removing
// the tabs and line breaks browsers drop from URLs:
// - `//` covers absolute and scheme-relative URLs in image, iframe and link fields, markdown
//   and CSS `url()`; browsers read `\` as `/` in URLs and CSS escapes start with `\`.
// - A network URL scheme without slashes (`https:host/x`), which a page served over the other
//   scheme resolves to that host. Other `name:` prefixes, such as `mdi:` icons, stay local.
// - HTML character references (`&#47;`, `&sol;`), which markdown and HTML decode.
// - Jinja (`{{`, `{%`) and JavaScript (`[[[`) templates, which compute strings at render time.
// - `javascript:` and `vbscript:` links, which run script when clicked.
// - `custom:` cards, strategies and elements, which interpret their configuration however they
//   like.
const EXTERNAL_REFERENCE = /\/\/|\\|(https?|ftp|wss?):|&(#|[a-z][a-z0-9]*;)|\{\{|\{%|\[\[\[|script:|^\s*custom:/i;

// Deeper than any real dashboard; a configuration past it is not checked and so not trusted.
const MAX_CONFIG_DEPTH = 64;

// True when no key or string anywhere in a dashboard configuration matches EXTERNAL_REFERENCE.
function isSelfContained(value: unknown, depth: number): boolean {
  if (typeof value === "string") return isLocalString(value);
  if (value === null || typeof value !== "object") return true;
  if (depth >= MAX_CONFIG_DEPTH) return false;
  const entries = Array.isArray(value) ? value.map((v) => ["", v] as const) : Object.entries(value);
  return entries.every(([key, child]) => isLocalString(key) && isSelfContained(child, depth + 1));
}

function isLocalString(value: string): boolean {
  return !EXTERNAL_REFERENCE.test(value.replace(/[\t\n\r]/g, ""));
}

/** The kind and verdict of a well-formed service call. */
export function serviceCallVerdict(
  action: HomeAssistantAction & { type: "callService" },
  registry: RegistrySnapshot,
): Pick<ActionDescription, "actionKind" | "autoApprovable"> {
  return isDeviceControl(action, registry)
    ? { actionKind: CONTROL_DEVICES_KIND, autoApprovable: true }
    : { actionKind: CALL_SERVICE_KIND, autoApprovable: false };
}

// Device-control services, by their real `<domain>.<service>` names. The allowlist is domain
// qualified because `turn_on` on script, automation, scene or homeassistant runs arbitrary logic.
// Left out on purpose: lock and alarm_control_panel (home security), notify and tts (messages to
// people), media_player.play_media (plays any URL, including spoken announcements), valve and
// siren, remote.send_command, button.press, input_* helpers and number/select/text (helpers and
// device settings that automations key on), every script/automation/homeassistant service, and
// every scene service: a scene's members can be edited while its action is pending, so checking
// them at submit would not bound what runs at apply.
const DEVICE_CONTROL_SERVICES = new Set([
  "light.turn_on", "light.turn_off", "light.toggle",
  "switch.turn_on", "switch.turn_off", "switch.toggle",
  "fan.turn_on", "fan.turn_off", "fan.toggle", "fan.set_percentage", "fan.increase_speed",
  "fan.decrease_speed", "fan.oscillate", "fan.set_direction", "fan.set_preset_mode",
  "humidifier.turn_on", "humidifier.turn_off", "humidifier.toggle", "humidifier.set_humidity",
  "humidifier.set_mode",
  "climate.turn_on", "climate.turn_off", "climate.set_temperature", "climate.set_hvac_mode",
  "climate.set_fan_mode", "climate.set_swing_mode", "climate.set_preset_mode",
  "climate.set_humidity",
  "cover.open_cover", "cover.close_cover", "cover.stop_cover", "cover.toggle",
  "cover.set_cover_position", "cover.open_cover_tilt", "cover.close_cover_tilt",
  "cover.stop_cover_tilt", "cover.toggle_cover_tilt", "cover.set_cover_tilt_position",
  "media_player.media_play", "media_player.media_pause", "media_player.media_play_pause",
  "media_player.media_stop", "media_player.media_next_track", "media_player.media_previous_track",
  "media_player.volume_set", "media_player.volume_up", "media_player.volume_down",
  "media_player.volume_mute",
  "vacuum.start", "vacuum.pause", "vacuum.stop", "vacuum.return_to_base", "vacuum.locate",
]);

const DEVICE_CONTROL_DOMAINS = new Set([...DEVICE_CONTROL_SERVICES].map((s) => s.split(".")[0]));

// Cover device classes that are window dressing or vents. Door, garage, gate and window covers
// are entry points, and a cover with no class (or a class HA adds later) is not known to be safe.
const SAFE_COVER_CLASSES = new Set(["awning", "blind", "curtain", "damper", "shade", "shutter"]);

// Domains whose per-entity check is more than the entity category. Home Assistant re-resolves
// area, device, label and floor targets when the call runs, so a garage door added to an area
// after submission would be reached; these domains need explicit entity ids.
const ENTITY_TARGETS_ONLY = new Set(["cover"]);

const TARGET_KEYS = ["entity_id", "device_id", "area_id", "label_id", "floor_id"] as const;
type TargetKey = (typeof TARGET_KEYS)[number];

/**
 * True when a service call is allow-listed device control and every entity it reaches, read from
 * both `target` and any target keys in `data` (Home Assistant merges the two), is one this module
 * can show is safe. A registry it cannot read makes every call false.
 */
function isDeviceControl(
  action: HomeAssistantAction & { type: "callService" },
  registry: RegistrySnapshot,
): boolean {
  const { domain, service, data, target, origin } = action;
  if (!DEVICE_CONTROL_SERVICES.has(`${domain}.${service}`)) return false;

  const targets = effectiveTargets(target, data);
  if (!targets) return false;
  // A capability bound to one entity, device, area or label pins `target`; target keys in `data`
  // would reach past it, so only the whole-instance session may pass them.
  if (origin.kind !== "session" && TARGET_KEYS.some((key) => data?.[key] !== undefined)) {
    return false;
  }
  const reachesBeyondEntities = TARGET_KEYS.some((key) => key !== "entity_id" && targets[key].length > 0);
  if (ENTITY_TARGETS_ONLY.has(domain) && reachesBeyondEntities) return false;

  const entityIds = resolveDomainEntities(targets, domain, registry);
  if (!entityIds || entityIds.size === 0) return false;
  for (const entityId of entityIds) {
    if (!isSafeEntity(entityId, registry)) return false;
  }
  return true;
}

// The union of `target` and the target keys in `data`, as id lists. Null when any value is not a
// non-empty string.
function effectiveTargets(
  target: HATarget | undefined,
  data: Record<string, unknown> | undefined,
): Record<TargetKey, string[]> | null {
  const out = {} as Record<TargetKey, string[]>;
  for (const key of TARGET_KEYS) {
    const ids: string[] = [];
    for (const value of [target?.[key], data?.[key]]) {
      if (value === undefined) continue;
      const list = Array.isArray(value) ? value : [value];
      for (const id of list) {
        if (typeof id !== "string" || !id) return null;
        ids.push(id);
      }
    }
    out[key] = ids;
  }
  return out;
}

// The service domain's entities the targets reach. Explicit entity ids must all be in the domain,
// which also rules out HA's `entity_id: "all"`.
// Device, area, label and floor ids must exist in the registry, and expand the way Home Assistant
// expands them: a label to the entities, devices and areas carrying it, a floor to its areas, an
// area to its devices, then devices and areas to the domain's entities, skipping config,
// diagnostic and hidden ones. An entity carrying the label itself is reached even when it is a
// config or diagnostic entity (only hidden ones are skipped), so isSafeEntity rules those out. An
// area also takes in every entity of its devices, a superset of HA's own rule. Null when an id is
// unknown or an entity is in another domain.
function resolveDomainEntities(
  targets: Record<TargetKey, string[]>,
  domain: string,
  registry: RegistrySnapshot,
): Set<string> | null {
  const out = new Set<string>();
  for (const entityId of targets.entity_id) {
    if (!entityId.startsWith(`${domain}.`)) return null;
    out.add(entityId);
  }

  const areaIds = new Set(targets.area_id);
  for (const floorId of targets.floor_id) {
    if (!registry.floors.some((f: any) => f.floor_id === floorId)) return null;
    for (const area of registry.areas as any[]) {
      if (area.floor_id === floorId) areaIds.add(area.area_id);
    }
  }
  for (const areaId of targets.area_id) {
    if (!registry.areas.some((a: any) => a.area_id === areaId)) return null;
  }
  for (const deviceId of targets.device_id) {
    if (!registry.devices.some((d: any) => d.id === deviceId)) return null;
  }
  for (const labelId of targets.label_id) {
    if (!registry.labels.some((l: any) => l.label_id === labelId)) return null;
  }

  const labelIds = new Set(targets.label_id);
  const isLabelled = (entry: any) =>
    Array.isArray(entry.labels) && entry.labels.some((l: string) => labelIds.has(l));
  for (const area of registry.areas as any[]) {
    if (isLabelled(area)) areaIds.add(area.area_id);
  }
  const deviceIds = new Set(targets.device_id);
  for (const device of registry.devices as any[]) {
    if (areaIds.has(device.area_id) || isLabelled(device)) deviceIds.add(device.id);
  }
  for (const entity of registry.entities as any[]) {
    if (typeof entity.entity_id !== "string" || !entity.entity_id.startsWith(`${domain}.`)) continue;
    if (entity.hidden_by != null) continue;
    const viaDeviceOrArea = deviceIds.has(entity.device_id) || areaIds.has(entity.area_id);
    if (isLabelled(entity) || (viaDeviceOrArea && entity.entity_category == null)) out.add(entity.entity_id);
  }
  return out;
}

// An entity is safe to act on without review when the registry knows it, it is not a config or
// diagnostic entity (in a generic domain like switch, those are device settings such as a
// camera's motion detection), and, for a cover, every class HA reports for it is a safe one.
function isSafeEntity(entityId: string, registry: RegistrySnapshot): boolean {
  const entry = registry.entities.find((e: any) => e.entity_id === entityId);
  if (!entry || entry.entity_category != null) return false;
  if (!entityId.startsWith("cover.")) return true;
  const classes = [
    registry.states.get(entityId)?.attributes?.device_class,
    entry.device_class,
    entry.original_device_class,
  ].filter((c) => c != null);
  return classes.length > 0 && classes.every((c) => SAFE_COVER_CLASSES.has(c));
}
