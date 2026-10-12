// `clearFields` in the sandbox runtime only deletes an autocomplete's typed query -- it doesn't touch
// `values` -- so a dependent field must also be nulled through `setValues`, and before it, since
// `setValues` re-renders at once. Forgetting either half is invisible: `isReady` passes and the URL
// builds, pairing the new console with the old console's site or camera. These tests drive each
// picker's real `render` against a recording JSX runtime so that omission fails here.

import { describe, expect, it, vi } from "vitest";

vi.mock("@gadgets/configurator-ui", () => {
  const runtimeComponent = (name: string) => Object.assign(() => undefined, { componentName: name });
  return {
    h: (component: unknown, props: unknown, ...children: unknown[]) => ({ component, props: props ?? {}, children: children.flat() }),
    Fragment: runtimeComponent("Fragment"),
    Section: runtimeComponent("Section"),
    Field: runtimeComponent("Field"),
    Autocomplete: runtimeComponent("Autocomplete"),
    RadioCards: runtimeComponent("RadioCards"),
  };
});

type Values = Record<string, string | null>;
type Picker = {
  render(ctx: { values: Values; setValues(p: Values): void; clearFields(...names: string[]): void; ui: never }): unknown;
  isReady?(ctx: { values: Values }): boolean;
};
type RenderedNode = { component: { componentName?: string }; props: Record<string, any>; children: unknown[] };

const pickers = {
  site: (await import("../src/configurator/unifi-site-configurator-ui.js")).default as unknown as Picker,
  hotspot: (await import("../src/configurator/unifi-hotspot-configurator-ui.js")).default as unknown as Picker,
  device: (await import("../src/configurator/unifi-device-configurator-ui.js")).default as unknown as Picker,
  wifi: (await import("../src/configurator/unifi-wifi-configurator-ui.js")).default as unknown as Picker,
  camera: (await import("../src/configurator/unifi-camera-configurator-ui.js")).default as unknown as Picker,
  sensor: (await import("../src/configurator/unifi-sensor-configurator-ui.js")).default as unknown as Picker,
  light: (await import("../src/configurator/unifi-light-configurator-ui.js")).default as unknown as Picker,
};

function isNode(value: unknown): value is RenderedNode {
  return typeof value === "object" && value !== null && "props" in value && "children" in value;
}

function find(tree: unknown, predicate: (node: RenderedNode) => boolean): RenderedNode | undefined {
  if (!isNode(tree)) return undefined;
  if (predicate(tree)) return tree;
  for (const child of tree.children) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function control(tree: unknown, name: string): Record<string, any> {
  const node = find(tree, n => n.props.name === name);
  if (!node) throw new Error(`No control named ${name} was rendered.`);
  return node.props;
}

/** Render at `values`; record each patch and each cleared field, in the order they happen. */
function renderWith(picker: Picker, values: Values) {
  const events: (["clear", string[]] | ["set", Values])[] = [];
  const tree = picker.render({
    values,
    setValues: patch => void events.push(["set", patch]),
    clearFields: (...names) => void events.push(["clear", names]),
    ui: new Proxy({}, { get() { throw new Error("render must not call the ui capability"); } }) as never,
  });
  return { tree, events };
}

describe.each([
  ["site", pickers.site, { consoleId: "a", siteId: "s" }, "consoleId", ["siteId"]],
  ["hotspot", pickers.hotspot, { consoleId: "a", siteId: "s" }, "consoleId", ["siteId"]],
  ["device", pickers.device, { consoleId: "a", siteId: "s", deviceId: "d", clients: null }, "consoleId", ["siteId", "deviceId"]],
  ["device", pickers.device, { consoleId: "a", siteId: "s", deviceId: "d", clients: null }, "siteId", ["deviceId"]],
  ["wifi", pickers.wifi, { consoleId: "a", siteId: "s", wifiNetworkId: "w" }, "consoleId", ["siteId", "wifiNetworkId"]],
  ["wifi", pickers.wifi, { consoleId: "a", siteId: "s", wifiNetworkId: "w" }, "siteId", ["wifiNetworkId"]],
  ["camera", pickers.camera, { consoleId: "a", cameraId: "c" }, "consoleId", ["cameraId"]],
  ["sensor", pickers.sensor, { consoleId: "a", sensorId: "c" }, "consoleId", ["sensorId"]],
  ["light", pickers.light, { consoleId: "a", lightId: "c" }, "consoleId", ["lightId"]],
] as const)("the %s picker", (_name, picker, values, changed, dependents) => {
  it(`clears ${dependents.join(" and ")} when ${changed} changes`, () => {
    const { tree, events } = renderWith(picker, { ...values });
    control(tree, changed).onChange("new-value");
    expect(events[0]).toEqual(["clear", [...dependents]]);
    const patch = events[1]![1] as Values;
    expect(patch[changed]).toBe("new-value");
    for (const dependent of dependents) expect(patch[dependent]).toBeNull();
    expect(picker.isReady!({ values: { ...values, ...patch } })).toBe(false);
  });

  it("disables what depends on something not yet chosen", () => {
    const { tree } = renderWith(picker, Object.fromEntries(Object.keys(values).map(k => [k, null])));
    for (const dependent of dependents) expect(control(tree, dependent).disabled).toBe(true);
  });
});

describe("the device picker's clients option", () => {
  it("records the choice as `1`, or clears it", () => {
    const { tree, events } = renderWith(pickers.device, { consoleId: "a", siteId: "s", deviceId: "d", clients: null });
    const cards = find(tree, n => n.component.componentName === "RadioCards")!.props;
    expect(cards.value).toBe("0");
    cards.onChange("1");
    cards.onChange("0");
    expect(events).toEqual([["set", { clients: "1" }], ["set", { clients: null }]]);
  });
});
