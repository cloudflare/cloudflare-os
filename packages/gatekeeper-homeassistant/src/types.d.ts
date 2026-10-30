// TypeScript interface for the Home Assistant gatekeeper. These types are exposed to gadgets
// and agents that have been granted access to a Home Assistant instance.
//
// Home Assistant is a home automation platform that exposes a unified API over a wide variety of
// smart-home devices. The gatekeeper provides capability-based access at multiple granularities:
//
// * Whole instance — every entity and service is reachable.
// * Area — a single area/room. Entities and devices assigned to this area only.
// * Label — every entity that carries a particular label.
// * Device — a single physical device (a group of entities provided by the same integration).
// * Entity — a single entity (sensor, light, switch, etc).
//
// Dashboards, template rendering, history queries, event firing and global discovery are only
// exposed on the whole-instance session.
//
// =====================================================================================
// API CONVENTIONS
// =====================================================================================
//
// 1. **All methods take POSITIONAL arguments. Never pass a single options object.**
//
//    Correct:
//      await session.callService("light", "turn_on", { brightness: 200 },
//                                { entityId: "light.kitchen" });
//
//    Incorrect (will throw a TypeError):
//      await session.callService({ domain: "light", service: "turn_on",
//                                  serviceData: {}, target: { entityIds: ["light.kitchen"] } });
//
// 2. **Field names are camelCase, not snake_case**, even though Home Assistant itself uses
//    snake_case internally. The gatekeeper handles the conversion. Examples:
//
//      ServiceCallTarget.entityId    (not entity_id)
//      ServiceCallTarget.deviceId    (not device_id)
//      EntitySummary.lastChanged     (not last_changed)
//
//    Inside service-call `data` (the third arg to callService), pass the keys that Home
//    Assistant's service expects — those ARE snake_case (e.g. `brightness_pct`, `hvac_mode`,
//    `media_content_id`). The `data` object is forwarded to HA verbatim.
//
// 3. **Prefer typed helpers when available.** Instead of `entity.callService("turn_on", ...)`,
//    prefer `entity.turnOn(...)`. The typed helpers (turnOn, turnOff, setTemperature,
//    setVolume, etc.) take strongly-typed arguments and are harder to misuse.
//
// 4. **Capability-first access.** To act on something specific, first obtain a capability:
//      const entity = await session.getEntity("light.kitchen");
//      await entity.turnOn();
//    The whole-instance `session.callService(...)` is the bulk/escape-hatch API.
//
// =====================================================================================
// APPROVAL & SIMULATION
// =====================================================================================
//
// Writes (any method that changes state in Home Assistant) are queued for approval and do not
// execute against HA until the user approves them, or an auto-approval rule the user enabled
// covers them. Until then:
//
// - The write method's `Promise<void>` resolves as soon as the action is queued — it does NOT
//   wait for HA to actually carry out the action.
// - Subsequent reads (e.g. `entity.getState()`, `session.listEntities()`) reflect a SIMULATED
//   post-action state: as if every pending write had already been applied. This lets you chain
//   reads and writes naturally without waiting on user approval.
//
// Simulation predicts FINAL states only — there's no transition timing or animation. It covers
// the common service families (turn_on/off/toggle, set_temperature, set_volume, set_cover_position,
// lock/unlock, set_value, select_option, media_play/pause, vacuum.start/stop, etc.). It cannot
// predict the effect of:
//
// - **Scenes** (`scene.activate` / `scene.turn_on`) — we don't parse scene config to know which
//   entities a scene affects. Read the affected entities AFTER approval to see new state.
// - **Scripts** (`script.run` / `script.turn_on`) — we don't execute script bodies locally.
// - **Custom or vendor-specific services** — only the well-known service families are
//   simulated; unknown service calls leave state untouched.
// - **Templates** (`session.renderTemplate(...)`) — templates evaluate against HA's LIVE state,
//   NOT the simulated state. If you need a post-write value, prefer `entity.getState()`.
// - **History** (`session.getHistory()` / `entity.getHistory()`) — historical, by definition
//   pre-action.

import type { RpcTarget } from "cloudflare:workers";

// ---------------------------------------------------------------------------
// Common data types

/** Reference to a Home Assistant area (room). */
export interface AreaInfo {
  /** Internal stable identifier, e.g. "living_room". */
  id: string;
  /** Human-readable name, e.g. "Living Room". */
  name: string;
  /** Optional alternate names users have configured. */
  aliases: string[];
  /** Floor this area belongs to, if any. */
  floorId?: string;
  /** Optional icon name, e.g. "mdi:sofa". */
  icon?: string;
  /** Optional URL to a picture used to represent this area in the UI. */
  picture?: string;
}

/** Reference to a Home Assistant floor (a group of areas). */
export interface FloorInfo {
  id: string;
  name: string;
  level?: number;
  icon?: string;
  aliases: string[];
}

/** Reference to a label. Labels are user-defined tags that can be applied to entities,
 * devices, and areas. */
export interface LabelInfo {
  id: string;
  name: string;
  /** Optional color name (HA-defined palette name like "blue"). */
  color?: string;
  icon?: string;
  description?: string;
}

/** Reference to a physical device. A device groups together one or more entities exposed by
 * an integration (e.g. a Z-Wave switch device may expose a "switch" entity, an "energy" sensor
 * entity, and a few "diagnostic" entities). */
export interface DeviceInfo {
  id: string;
  /** Human-readable name (user-set name if any, otherwise the manufacturer default). */
  name: string;
  manufacturer?: string;
  model?: string;
  /** Hardware version. */
  hwVersion?: string;
  /** Software version. */
  swVersion?: string;
  /** Integration domain that provides this device, e.g. "hue", "mqtt", "zwave_js". */
  configEntries: string[];
  areaId?: string;
  /** Whether this device is currently disabled in HA. */
  disabled: boolean;
  /** Labels applied to this device. */
  labels: string[];
}

/** Lightweight reference to an entity (for listings and quick lookups). */
export interface EntitySummary {
  /** Full entity ID, e.g. "light.kitchen_ceiling". */
  entityId: string;
  /** Domain portion of the entity ID, e.g. "light". */
  domain: string;
  /** Display name. Honors any user override; falls back to the integration's default. */
  name: string;
  /** Last known state string, e.g. "on", "off", "23.5". May be "unavailable" or "unknown". */
  state: string;
  /** Optional icon name (mdi:...). */
  icon?: string;
  /** Device this entity belongs to, if any. */
  deviceId?: string;
  /** Area this entity is assigned to (either directly or via its device). */
  areaId?: string;
  /** Labels currently applied to this entity. */
  labels: string[];
  /** Entity category in HA's registry: undefined for primary controls, "config" for settings,
   * "diagnostic" for diagnostic readings. */
  entityCategory?: "config" | "diagnostic";
  /** Whether HA reports this entity as disabled. Disabled entities won't update. */
  disabled: boolean;
  /** Whether HA reports this entity as hidden from default UIs. */
  hidden: boolean;
  /** UNIX millis at which the state last changed. */
  lastChanged?: number;
  /** UNIX millis at which any property was last updated. */
  lastUpdated?: number;
}

/** Full state of an entity, as returned by HA's REST API. */
export interface EntityState {
  entityId: string;
  /** State string (e.g. "on"). */
  state: string;
  /** Domain-specific attributes. Shape varies by entity domain. Common attributes include
   * `friendly_name`, `unit_of_measurement`, `device_class`, and integration-specific data. */
  attributes: Record<string, unknown>;
  /** ISO 8601 timestamp. */
  lastChanged: string;
  /** ISO 8601 timestamp. */
  lastUpdated: string;
  /** Optional context: who/what caused the state change. */
  context?: {
    id: string;
    userId?: string | null;
    parentId?: string | null;
  };
}

/** A historical state record. */
export interface HistoricalState {
  state: string;
  attributes: Record<string, unknown>;
  /** ISO 8601 timestamp. */
  lastChanged: string;
  /** ISO 8601 timestamp. */
  lastUpdated: string;
}

/** A historical states bundle for a single entity. */
export interface EntityHistory {
  entityId: string;
  states: HistoricalState[];
}

/** A logbook entry — a human-readable record of a state change or event. */
export interface LogbookEntry {
  /** ISO 8601 timestamp. */
  when: string;
  name: string;
  message?: string;
  entityId?: string;
  state?: string;
  domain?: string;
  contextUserId?: string;
}

/** Describes one HA service (e.g. light.turn_on) and its declared fields. */
export interface ServiceInfo {
  domain: string;
  service: string;
  /** Human-readable name, if HA provides one. */
  name?: string;
  /** Human-readable description, if HA provides one. */
  description?: string;
  /** Field definitions, keyed by field name. Shape mirrors HA's services.yaml. */
  fields?: Record<string, ServiceFieldInfo>;
  /** Selector for HA's target picker, if this service takes targets. */
  target?: unknown;
}

export interface ServiceFieldInfo {
  name?: string;
  description?: string;
  required?: boolean;
  example?: unknown;
  default?: unknown;
  selector?: unknown;
}

/** Filter for `listEntities()`. All conditions are AND-ed; arrays are OR-within. */
export interface EntityFilter {
  /** Restrict to one or more domains (e.g. ["light", "switch"]). */
  domain?: string | string[];
  /** Restrict to entities in this area. */
  areaId?: string;
  /** Restrict to entities carrying this label. */
  labelId?: string;
  /** Restrict to entities belonging to this device. */
  deviceId?: string;
  /** Free-text search applied to entity ID and display name. */
  search?: string;
  /** Whether to include entities HA marks as disabled. Default false. */
  includeDisabled?: boolean;
  /** Whether to include entities HA marks as hidden. Default false. */
  includeHidden?: boolean;
  /** Whether to include "config" and "diagnostic" category entities. Default false. */
  includeAuxiliary?: boolean;
}

/** Optional `target` for service calls. Mirrors HA's service-call target shape. */
export interface ServiceCallTarget {
  entityId?: string | string[];
  deviceId?: string | string[];
  areaId?: string | string[];
  labelId?: string | string[];
  floorId?: string | string[];
}

// ---------------------------------------------------------------------------
// Sessions — one per granularity

/** Session for whole-instance access. */
export interface HomeAssistantSession extends RpcTarget {
  /** Get the HA instance's general configuration: name, version, units, timezone, etc. */
  getConfig(): Promise<HomeAssistantConfig>;

  // ---- Registries --------------------------------------------------------

  /** List all areas (rooms). */
  listAreas(): Promise<AreaInfo[]>;
  /** List all floors. */
  listFloors(): Promise<FloorInfo[]>;
  /** List all labels. */
  listLabels(): Promise<LabelInfo[]>;
  /** List all physical devices. */
  listDevices(): Promise<DeviceInfo[]>;
  /** List all entities. Supply a filter to narrow the result.
   * @example const lights = await session.listEntities({ domain: "light" });
   * @example const onLights = (await session.listEntities({ domain: "light" }))
   *            .filter(e => e.state === "on"); */
  listEntities(filter?: EntityFilter): Promise<EntitySummary[]>;
  /** List all integration domains currently in use.
   * @example const domains = await session.listDomains(); */
  listDomains(): Promise<string[]>;
  /** List all services HA exposes. If `domain` is given, only that domain's services.
   * @example const climateServices = await session.listServices("climate"); */
  listServices(domain?: string): Promise<ServiceInfo[]>;

  // ---- Capability accessors ----------------------------------------------

  /** Get a capability for a single area. Throws if the area does not exist.
   * @example const livingRoom = await session.getArea("living_room"); */
  getArea(id: string): Promise<Area>;
  /** Get a capability for a single label. Throws if the label does not exist.
   * @example const nightlights = await session.getLabel("nightlight"); */
  getLabel(id: string): Promise<Label>;
  /** Get a capability for a single device. Throws if the device does not exist.
   * @example const device = await session.getDevice("abc123def456"); */
  getDevice(id: string): Promise<Device>;
  /** Get a capability for a single entity. Throws if the entity does not exist.
   * @example const light = await session.getEntity("light.kitchen");
   *          await light.turnOn(); */
  getEntity(entityId: string): Promise<Entity>;
  /** Get a capability for a single dashboard, identified by its URL path (e.g. "lovelace" for
   * the default dashboard, "energy" for the built-in energy dashboard).
   * @example const dashboard = await session.getDashboard("lovelace"); */
  getDashboard(urlPath: string): Promise<Dashboard>;

  // ---- Control ------------------------------------------------------------

  /** Call any Home Assistant service. Returns no value. The action is queued for approval and
   * does not actually execute against HA until the user approves it (or an auto-approval rule
   * the user enabled covers it).
   *
   * Arguments are **positional**, not an options object:
   *
   * @example
   * ```ts
   * await session.callService(
   *   "light",                                  // domain
   *   "turn_on",                                // service
   *   { brightness: 200 },                      // optional service data
   *   { entityId: "light.kitchen" },            // optional target
   * );
   * ```
   *
   * For typed convenience methods (e.g. `entity.turnOn()`) prefer calling them through an
   * `Entity` capability obtained via `getEntity(id)`.
   */
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: ServiceCallTarget,
  ): Promise<void>;

  /** Fire an HA event on the event bus. Positional arguments only.
   * @example await session.fireEvent("my_custom_event", { source: "gadget" }); */
  fireEvent(eventType: string, data?: Record<string, unknown>): Promise<void>;

  // ---- Read helpers ------------------------------------------------------

  /** Render a Jinja2 template against the current state. Returns the rendered string.
   *
   * Templates can read ANY entity in the instance, regardless of any per-area/per-label
   * scoping you might apply elsewhere. For that reason, this method is only available on
   * the whole-instance session.
   *
   * @example
   * const temp = await session.renderTemplate(
   *   "{{ states('sensor.outside_temp') | float }}",
   * );
   * @example
   * const lightsOn = await session.renderTemplate(
   *   "{{ expand('group.all_lights') | selectattr('state','eq','on') | list | count }}",
   * );
   */
  renderTemplate(template: string, variables?: Record<string, unknown>): Promise<string>;

  /** Get historical states for the given entities in the given time range.
   * `start` and `end` are ISO 8601 strings or `Date` instances. If `end` is omitted, defaults
   * to "now". Returns one `EntityHistory` per requested entity.
   * @example
   * const history = await session.getHistory(
   *   ["sensor.outside_temp", "sensor.inside_temp"],
   *   new Date(Date.now() - 24 * 60 * 60 * 1000),  // 24h ago
   * ); */
  getHistory(
    entityIds: string[],
    start: string | Date,
    end?: string | Date,
  ): Promise<EntityHistory[]>;

  /** Get logbook entries in the given time range. Optionally filter to one entity.
   * @example
   * const entries = await session.getLogbook(
   *   new Date(Date.now() - 6 * 60 * 60 * 1000),  // 6h ago
   *   undefined,                                   // up to now
   *   "binary_sensor.front_door",                  // single entity
   * ); */
  getLogbook(
    start: string | Date,
    end?: string | Date,
    entityId?: string,
  ): Promise<LogbookEntry[]>;

  // ---- Dashboards ---------------------------------------------------------

  /** List all dashboards. Includes both the default dashboard and any user-created ones.
   * Only dashboards in "storage mode" can be edited via the API.
   * @example const dashboards = await session.listDashboards(); */
  listDashboards(): Promise<DashboardInfo[]>;

  /** List custom Lovelace resources (custom cards, themes, modules).
   * @example const resources = await session.listLovelaceResources(); */
  listLovelaceResources(): Promise<LovelaceResourceInfo[]>;
}

/** Static configuration of the HA instance. */
export interface HomeAssistantConfig {
  /** Friendly name of the HA installation, e.g. "Home". */
  locationName: string;
  /** HA version string, e.g. "2026.5.0". */
  version: string;
  /** Timezone string, e.g. "Europe/Stockholm". */
  timeZone: string;
  /** Unit-of-measurement defaults: temperature, length, mass, etc. */
  unitSystem: Record<string, string>;
  /** Allowlist of external URLs (for sensors etc). */
  allowlistExternalUrls?: string[];
  /** Latitude/longitude as configured. */
  latitude?: number;
  longitude?: number;
  elevation?: number;
  /** Currency code, e.g. "SEK". */
  currency?: string;
  /** Language code, e.g. "en". */
  language?: string;
}

// ---------------------------------------------------------------------------
// Area / Label / Device / Entity scoped sessions
//
// Each of these is BOTH a Session and a capability object. They are returned both as the root
// `Session` of a per-resource gatekeeper instance (when the user grants per-area/per-label/etc
// access) and from the whole-instance session via `getArea()` / `getLabel()` etc.

/** Session/capability for a single area. */
export interface Area extends RpcTarget {
  /** Get the area's metadata.
   * @example const info = await area.describe(); */
  describe(): Promise<AreaInfo>;
  /** Get the floor this area belongs to, if any.
   * @example const floor = await area.getFloor(); */
  getFloor(): Promise<FloorInfo | null>;
  /** List entities assigned to this area (either directly or via their device).
   * @example const lightsInArea = await area.listEntities({ domain: "light" }); */
  listEntities(filter?: Omit<EntityFilter, "areaId">): Promise<EntitySummary[]>;
  /** List devices in this area.
   * @example const devices = await area.listDevices(); */
  listDevices(): Promise<DeviceInfo[]>;
  /** Get a capability for one entity in this area. Throws if the entity is not in this area.
   * @example const light = await area.getEntity("light.kitchen"); */
  getEntity(entityId: string): Promise<Entity>;
  /** Get a capability for one device in this area. Throws if the device is not in this area.
   * @example const device = await area.getDevice("abc123def456"); */
  getDevice(deviceId: string): Promise<Device>;
  /** Call a service targeted at every entity in this area. Positional arguments only.
   * @example await area.callService("light", "turn_off"); */
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
  /** Get historical states for all entities in this area. */
  getHistory(start: string | Date, end?: string | Date): Promise<EntityHistory[]>;
}

/** Session/capability for a single label. */
export interface Label extends RpcTarget {
  /** Get the label's metadata. */
  describe(): Promise<LabelInfo>;
  /** List entities carrying this label. */
  listEntities(filter?: Omit<EntityFilter, "labelId">): Promise<EntitySummary[]>;
  /** Get one entity that carries this label. Throws if it does not. */
  getEntity(entityId: string): Promise<Entity>;
  /** Call a service targeted at every entity carrying this label. Positional arguments only.
   * @example await label.callService("light", "turn_off"); */
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
  /** Get historical states for entities carrying this label. */
  getHistory(start: string | Date, end?: string | Date): Promise<EntityHistory[]>;
}

/** Session/capability for a single device. */
export interface Device extends RpcTarget {
  /** Get the device's metadata. */
  describe(): Promise<DeviceInfo>;
  /** Get the area this device is in, if any. */
  getArea(): Promise<AreaInfo | null>;
  /** List entities this device provides. */
  listEntities(filter?: Omit<EntityFilter, "deviceId">): Promise<EntitySummary[]>;
  /** Get one entity provided by this device. Throws if the entity does not belong to it. */
  getEntity(entityId: string): Promise<Entity>;
  /** Call a service targeted at every entity provided by this device. Positional arguments only.
   * @example await device.callService("switch", "turn_off"); */
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
  /** Get historical states for all entities provided by this device. */
  getHistory(start: string | Date, end?: string | Date): Promise<EntityHistory[]>;
}

/** Session/capability for a single entity.
 *
 * Most domains expose convenience helpers (e.g. `turnOn()` for a light). For domains that don't,
 * use the generic `callService(service, data?)` method. The escape hatch is also useful for
 * calling vendor-specific services or for fields not covered by the typed helpers.
 */
export interface Entity extends RpcTarget {
  /** Get the entity's summary metadata. */
  describe(): Promise<EntitySummary>;
  /** Get the entity's current state (state string + attributes).
   * @example
   * const state = await entity.getState();
   * console.log(state.state, state.attributes.brightness); */
  getState(): Promise<EntityState>;
  /** Get the device that provides this entity, if any. */
  getDevice(): Promise<DeviceInfo | null>;
  /** Get the area this entity is assigned to, if any. */
  getArea(): Promise<AreaInfo | null>;
  /** Get the labels currently applied to this entity. */
  getLabels(): Promise<LabelInfo[]>;
  /** Get historical states for this entity.
   * @example await entity.getHistory(new Date(Date.now() - 3600_000)); */
  getHistory(start: string | Date, end?: string | Date): Promise<EntityHistory[]>;
  /** Get logbook entries for this entity. */
  getLogbook(start: string | Date, end?: string | Date): Promise<LogbookEntry[]>;

  /** Generic service call against this entity. The domain is inferred from the entity ID;
   * `service` is the bare service name (e.g. "turn_on"). Positional arguments only.
   * @example await entity.callService("turn_on", { brightness: 200 }); */
  callService(service: string, data?: Record<string, unknown>): Promise<void>;

  // ---- Typed helpers (only meaningful for the matching domain) ---------

  /** `light`, `switch`, `fan`, `input_boolean`, `automation`, `humidifier`, etc.
   * @example await entity.turnOn();
   * @example await entity.turnOn({ brightness: 200 });
   * @example await entity.turnOn({ brightnessPct: 50, rgbColor: [255, 100, 0] }); */
  turnOn(data?: LightTurnOnData | Record<string, unknown>): Promise<void>;
  /** `light`, `switch`, `fan`, `input_boolean`, `automation`, `humidifier`, etc.
   * @example await entity.turnOff();
   * @example await entity.turnOff({ transition: 2 }); */
  turnOff(data?: { transition?: number } | Record<string, unknown>): Promise<void>;
  /** `light`, `switch`, `fan`, `input_boolean`, `automation`, etc.
   * @example await entity.toggle(); */
  toggle(data?: Record<string, unknown>): Promise<void>;

  /** `cover`.
   * @example await entity.open(); */
  open(): Promise<void>;
  /** `cover`.
   * @example await entity.close(); */
  close(): Promise<void>;
  /** `cover`, `media_player`, `vacuum`. The exact service is chosen based on the entity's domain.
   * @example await entity.stop(); */
  stop(): Promise<void>;
  /** `cover`. `position` is 0-100.
   * @example await entity.setPosition(50); */
  setPosition(position: number): Promise<void>;

  /** `climate`. Sets the target temperature (in the unit configured on the entity).
   * @example await entity.setTemperature(20);
   * @example await entity.setTemperature(22, { hvacMode: "heat" }); */
  setTemperature(temperature: number, options?: { hvacMode?: string }): Promise<void>;
  /** `climate`. Common modes: "heat", "cool", "auto", "heat_cool", "off", "fan_only", "dry".
   * @example await entity.setHvacMode("heat"); */
  setHvacMode(mode: string): Promise<void>;
  /** `climate`.
   * @example await entity.setFanMode("auto"); */
  setFanMode(mode: string): Promise<void>;

  /** `lock`.
   * @example await entity.lock(); */
  lock(code?: string): Promise<void>;
  /** `lock`.
   * @example await entity.unlock("1234"); */
  unlock(code?: string): Promise<void>;

  /** `media_player`.
   * @example await entity.play(); */
  play(): Promise<void>;
  /** `media_player`.
   * @example await entity.pause(); */
  pause(): Promise<void>;
  /** `media_player`. Skip to next track.
   * @example await entity.next(); */
  next(): Promise<void>;
  /** `media_player`. Skip to previous track.
   * @example await entity.previous(); */
  previous(): Promise<void>;
  /** `media_player`. `volume` is 0.0 to 1.0.
   * @example await entity.setVolume(0.3); */
  setVolume(volume: number): Promise<void>;
  /** `media_player`.
   * @example await entity.mute();
   * @example await entity.mute(false);  // unmute */
  mute(muted?: boolean): Promise<void>;
  /** `media_player`.
   * @example await entity.playMedia("spotify:playlist:abc", "playlist"); */
  playMedia(mediaContentId: string, mediaContentType: string): Promise<void>;

  /** `fan`. `percentage` is 0-100.
   * @example await entity.setSpeed(50); */
  setSpeed(percentage: number): Promise<void>;

  /** `vacuum`.
   * @example await entity.start(); */
  start(): Promise<void>;
  /** `vacuum`.
   * @example await entity.returnToBase(); */
  returnToBase(): Promise<void>;
  /** `vacuum`.
   * @example await entity.locate(); */
  locate(): Promise<void>;

  /** `scene`. Activates a scene.
   * @example await entity.activate(); */
  activate(): Promise<void>;

  /** `script`. Runs a script entity.
   * @example await entity.run();
   * @example await entity.run({ variables: { greeting: "hi" } }); */
  run(variables?: Record<string, unknown>): Promise<void>;

  /** `button`, `input_button`.
   * @example await entity.press(); */
  press(): Promise<void>;

  /** `input_number`, `number`.
   * @example await entity.setValue(42); */
  setValue(value: number): Promise<void>;
  /** `input_text`, `text`.
   * @example await entity.setText("hello"); */
  setText(value: string): Promise<void>;
  /** `input_select`, `select`. The option must match one of the entity's configured options.
   * @example await entity.selectOption("auto"); */
  selectOption(option: string): Promise<void>;
  /** `input_datetime`. Provide ISO date/time/datetime strings as appropriate.
   * @example await entity.setDateTime({ datetime: "2026-12-31 17:00:00" });
   * @example await entity.setDateTime({ date: "2026-12-31" }); */
  setDateTime(value: { date?: string; time?: string; datetime?: string }): Promise<void>;

  /** `automation`. Fires the automation regardless of its trigger.
   * @example await entity.trigger(); */
  trigger(): Promise<void>;
  /** `automation`. Reloads automation configurations.
   * @example await entity.reload(); */
  reload(): Promise<void>;

  /** `notify`. (Notify entities accept a `title` and `message`.)
   * @example await entity.notify("Door left open", "Front door alert"); */
  notify(message: string, title?: string, data?: Record<string, unknown>): Promise<void>;
}

/** Data accepted by `Entity.turnOn()` when the entity is a light. Fields are passed straight
 * through to `light.turn_on`. */
export interface LightTurnOnData {
  brightness?: number; // 0-255
  brightnessPct?: number; // 0-100
  /** Color temperature in mireds. */
  colorTemp?: number;
  /** Color temperature in Kelvin. */
  colorTempKelvin?: number;
  /** RGB color as [r, g, b], each 0-255. */
  rgbColor?: [number, number, number];
  /** XY color (CIE 1931), each 0-1. */
  xyColor?: [number, number];
  /** HS color as [hue, saturation]. */
  hsColor?: [number, number];
  /** Named color, e.g. "red". */
  colorName?: string;
  transition?: number;
  /** Effect name. */
  effect?: string;
  /** Flash style. */
  flash?: "short" | "long";
}

// ---------------------------------------------------------------------------
// Dashboards

/** Summary info for one Lovelace dashboard. */
export interface DashboardInfo {
  /** URL path component identifying the dashboard, e.g. "lovelace", "energy", "my-dashboard".
   * The full URL is `<ha-base>/<url-path>`. */
  urlPath: string;
  title: string;
  icon?: string;
  /** Whether the dashboard's configuration can be edited via the API ("storage" mode) or is
   * configured in YAML. YAML dashboards are read-only here. */
  mode: "storage" | "yaml";
  /** Whether this dashboard is hidden from the sidebar. */
  showInSidebar: boolean;
  /** Whether this is the default dashboard, accessed at the root URL. */
  requireAdmin: boolean;
}

/** A Lovelace custom resource registered with the frontend. */
export interface LovelaceResourceInfo {
  id: string;
  url: string;
  /** "module", "css", or "js". */
  type: string;
}

/** A Lovelace dashboard's full configuration. The structure mirrors HA's Lovelace storage
 * format: an array of views (tabs), each containing cards (with arbitrary `type` plus
 * type-specific config), badges, and optionally sections.
 *
 * This is exposed as raw JSON because card configs are extensible — every custom card has its
 * own schema. Manipulating the JSON directly is the most reliable way to edit dashboards. */
export interface DashboardConfig {
  title?: string;
  views: DashboardView[];
  /** Custom Lovelace UI configuration (theme, etc). */
  [key: string]: unknown;
}

export interface DashboardView {
  title?: string;
  path?: string;
  icon?: string;
  badges?: unknown[];
  cards?: unknown[];
  sections?: unknown[];
  type?: string;
  /** Theme override for this view. */
  theme?: string;
  /** Other view-level options. */
  [key: string]: unknown;
}

/** A single Lovelace dashboard. */
export interface Dashboard extends RpcTarget {
  /** Get the dashboard's summary info.
   * @example const info = await dashboard.describe(); */
  describe(): Promise<DashboardInfo>;
  /** Get the full raw configuration of this dashboard. Throws for YAML-mode dashboards.
   * @example const config = await dashboard.getConfig(); */
  getConfig(): Promise<DashboardConfig>;
  /** Replace the entire configuration of this dashboard. Throws for YAML-mode dashboards.
   *
   * The caller is responsible for preserving any fields they don't intend to change: this
   * method performs no merge. A typical usage is: read with `getConfig()`, mutate the JSON,
   * write back with `saveConfig()`.
   * @example
   * const config = await dashboard.getConfig();
   * config.views.push({ title: "New tab", cards: [] });
   * await dashboard.saveConfig(config); */
  saveConfig(config: DashboardConfig): Promise<void>;
}
