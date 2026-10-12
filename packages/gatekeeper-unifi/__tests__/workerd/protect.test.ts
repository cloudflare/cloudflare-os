// The Protect bindings, driven the way the overseer drives them: every read is authorized before it
// returns, every change is submitted for approval (and shown in later reads while it waits), and
// approving it sends what Protect documents.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { binding, connectCloud, hooks, installFake, RESOURCES } from "./helpers.js";
import { HOME, SNAPSHOT_BYTES } from "../fake-unifi.js";
import type { Step } from "../worker.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastSubmitted(queue: { submitted: { actionId: number; description: ActionDescription }[] }) {
  const entry = queue.submitted.at(-1);
  if (!entry) throw new Error("nothing was submitted");
  return entry;
}

describe("every read is authorized before it returns", () => {
  const reads: [string, Step][] = [
    ["describe", { call: "describe" }],
    ["listCameras", { call: "listCameras" }],
    ["listSensors", { call: "listSensors" }],
    ["listLights", { call: "listLights" }],
    ["camera.describe", { via: [["getCamera", HOME.doorbellId]], call: "describe" }],
    ["camera.getSnapshot", { via: [["getCamera", HOME.doorbellId]], call: "getSnapshot" }],
    ["sensor.describe", { via: [["getSensor", HOME.sensorId]], call: "describe" }],
    ["light.describe", { via: [["getLight", HOME.lightId]], call: "describe" }],
  ];

  it.each(reads)("%s records exactly one observation", async (_name, step) => {
    installFake();
    const protect = binding(await connectCloud(), RESOURCES.protect);
    const [result] = await hooks().run(protect.name, protect.props, [step]);
    expect(result).toHaveProperty("ok");
    const { observations, submitted } = await protect.queue();
    expect(observations).toHaveLength(1);
    expect(observations[0]!.title).toMatch(/UniFi/);
    expect(submitted).toEqual([]);
  });
});

describe("Protect on a console", () => {
  it("describes itself, with the alarm's state", async () => {
    installFake();
    const protect = binding(await connectCloud(), RESOURCES.protect);
    expect(await protect.call("describe")).toMatchObject({
      consoleId: HOME.hostId, consoleName: "Dream Machine Pro", protectVersion: "7.3.70", alarm: { status: "disabled" },
    });
  });

  it("lists cameras, sensors, and floodlights", async () => {
    installFake();
    const protect = binding(await connectCloud(), RESOURCES.protect);
    expect((await protect.call<{ name: string }[]>("listCameras")).map(c => c.name)).toEqual(["Front Door", "Driveway"]);
    expect(await protect.call("listSensors")).toMatchObject([{ name: "Garage Door", isOpen: false, temperatureC: 21.5, batteryPercent: 87 }]);
    expect(await protect.call("listLights")).toMatchObject([{ name: "Backyard Floodlight", mode: "motion", pairedCameraId: HOME.ptzId }]);
  });

  it("shows a change made through one camera in the console-wide list while it waits", async () => {
    installFake();
    const protect = binding(await connectCloud(), RESOURCES.protect);
    await protect.callVia([["getCamera", HOME.doorbellId]], "setName", "Porch");
    expect((await protect.call<{ name: string }[]>("listCameras")).map(c => c.name)).toEqual(["Porch", "Driveway"]);
  });

  it("offers to auto-approve only the Protect kinds", async () => {
    installFake();
    const protect = binding(await connectCloud(), RESOURCES.protect);
    const kinds = (await hooks().autoApprovable(protect.name, protect.props)) as { ok: { tag: string }[] };
    expect(kinds.ok.map(k => k.tag).toSorted()).toEqual(["unifi.cameraPtz", "unifi.cameraSettings", "unifi.lightSettings"]);
  });
});

describe("a camera", () => {
  it("captures a snapshot as JPEG bytes, from the package camera when asked", async () => {
    const { console } = installFake();
    const doorbell = binding(await connectCloud(), RESOURCES.camera(HOME.doorbellId));
    const snapshot = await doorbell.call<{ mimeType: string; content: ArrayBuffer; capturedAt: Date }>(
      "getSnapshot", { highQuality: true, packageCamera: true });
    expect(snapshot.mimeType).toBe("image/jpeg");
    expect(new Uint8Array(snapshot.content)).toEqual(SNAPSHOT_BYTES);
    expect(snapshot.capturedAt).toBeInstanceOf(Date);
    expect(console.calls.at(-1)).toMatchObject({ path: `/v1/cameras/${HOME.doorbellId}/snapshot`, query: { highQuality: "true", channel: "package" } });
    expect((await doorbell.queue()).observations).toEqual([{
      title: "Capture a UniFi camera snapshot", description: "Captured a still image from the package camera of UniFi camera Front Door.",
    }]);
  });

  it("captures a new image every time, never a recent one again", async () => {
    const { console } = installFake();
    const doorbell = binding(await connectCloud(), RESOURCES.camera(HOME.doorbellId));
    await doorbell.call("getSnapshot");
    await doorbell.call("getSnapshot");
    expect(console.calls.filter(call => call.path.endsWith("/snapshot"))).toHaveLength(2);
  });

  it("refuses the package camera of a camera without one, and records no read", async () => {
    installFake();
    const driveway = binding(await connectCloud(), RESOURCES.camera(HOME.ptzId));
    expect(await driveway.failure("getSnapshot", { packageCamera: true })).toBe("Driveway has no package camera.");
    expect((await driveway.queue()).observations).toEqual([]);
  });

  it("renames itself once approved, showing the new name before then", async () => {
    const { console } = installFake();
    const doorbell = binding(await connectCloud(), RESOURCES.camera(HOME.doorbellId));
    await doorbell.call("setName", "  Porch  ");
    const { actionId, description } = lastSubmitted(await doorbell.queue());
    expect(description).toMatchObject({
      title: "Rename camera “Front Door”", autoApprovable: true, actionKind: { tag: "unifi.cameraSettings" },
    });
    expect(await doorbell.call("describe")).toMatchObject({ name: "Porch" });
    expect(console.writes()).toEqual([]);
    await doorbell.apply(actionId);
    expect(console.writes().map(w => [w.method, w.path, w.body])).toEqual([["PATCH", `/v1/cameras/${HOME.doorbellId}`, { name: "Porch" }]]);
  });

  it("refuses a status light it doesn't have, before submitting anything", async () => {
    installFake();
    const driveway = binding(await connectCloud(), RESOURCES.camera(HOME.ptzId));
    expect(await driveway.failure("setStatusLight", false)).toBe("Driveway has no status light.");
    expect((await driveway.queue()).submitted).toEqual([]);
  });

  it("shows a doorbell message until the doorbell's default timeout, not forever", async () => {
    const { console } = installFake();
    const doorbell = binding(await connectCloud(), RESOURCES.camera(HOME.doorbellId));
    await doorbell.call("setDoorbellMessage", { kind: "text", text: " Back in 10 minutes " });
    const { actionId, description } = lastSubmitted(await doorbell.queue());
    expect(description.title).toBe("Change the message on doorbell “Front Door”");
    expect(JSON.stringify(description.fields)).toContain("the doorbell's default timeout");
    expect(await doorbell.call("describe")).toMatchObject({ doorbellDisplay: { kind: "text", text: "Back in 10 minutes", until: null } });

    await doorbell.apply(actionId);
    expect(console.writes()[0]!.body).toEqual({ lcdMessage: { type: "CUSTOM_MESSAGE", text: "Back in 10 minutes" } });
    const { doorbellDisplay } = await doorbell.call<{ doorbellDisplay: { until: Date | null } }>("describe");
    expect(doorbellDisplay.until).toBeInstanceOf(Date);
  });

  it("sends a doorbell message's end time when one is given", async () => {
    const { console } = installFake();
    const doorbell = binding(await connectCloud(), RESOURCES.camera(HOME.doorbellId));
    const until = new Date(Date.now() + 3_600_000);
    await doorbell.call("setDoorbellMessage", { kind: "doNotDisturb" }, { until });
    await doorbell.apply(lastSubmitted(await doorbell.queue()).actionId);
    expect(console.writes()[0]!.body).toEqual({ lcdMessage: { type: "DO_NOT_DISTURB", resetAt: until.valueOf() } });
  });

  it("refuses doorbell messages Protect would refuse", async () => {
    installFake();
    const doorbell = binding(await connectCloud(), RESOURCES.camera(HOME.doorbellId));
    expect(await doorbell.failure("setDoorbellMessage", { kind: "text", text: "x".repeat(65) })).toMatch(/1 to 64 characters/);
    expect(await doorbell.failure("setDoorbellMessage", { kind: "text", text: "   " })).toMatch(/1 to 64 characters/);
    expect(await doorbell.failure("setDoorbellMessage", { kind: "doNotDisturb" }, { until: new Date(Date.now() - 1000) }))
      .toBe("`until` must be in the future.");
    expect((await doorbell.queue()).submitted).toEqual([]);
  });

  it("changes the microphone volume only with a person's approval", async () => {
    const { console } = installFake();
    const doorbell = binding(await connectCloud(), RESOURCES.camera(HOME.doorbellId));
    expect(await doorbell.failure("setMicVolume", 0)).toMatch(/whole number from 1 to 100/);
    await doorbell.call("setMicVolume", 40);
    const { actionId, description } = lastSubmitted(await doorbell.queue());
    expect(description).toMatchObject({ title: "Set the microphone volume of “Front Door” to 40", autoApprovable: false });
    expect(await doorbell.call("describe")).toMatchObject({ micVolume: 40 });
    await doorbell.apply(actionId);
    expect(console.writes()[0]!.body).toEqual({ micVolume: 40 });
  });

  it("refuses a microphone volume for a camera without a microphone", async () => {
    const { console } = installFake();
    (console.protect!.cameras[1]!.featureFlags as Record<string, unknown>).hasMic = false;
    const driveway = binding(await connectCloud(), RESOURCES.camera(HOME.ptzId));
    expect(await driveway.failure("setMicVolume", 40)).toBe("Driveway has no microphone.");
  });

  it("turns a PTZ camera once approved, waiting for the decision", async () => {
    const { console } = installFake();
    const driveway = binding(await connectCloud(), RESOURCES.camera(HOME.ptzId));
    await driveway.call("goToPreset", -1);
    await driveway.call("startPatrol", 1);
    await driveway.call("stopPatrol");
    const { submitted } = await driveway.queue();
    expect(submitted.map(s => s.description.title)).toEqual([
      "Turn “Driveway” to its home position", "Start patrol 1 on “Driveway”", "Stop the patrol on “Driveway”",
    ]);
    expect(submitted.every(s => s.description.awaitDecision === true && s.description.autoApprovable === true)).toBe(true);
    for (const { actionId } of submitted) await driveway.apply(actionId);
    expect(console.writes().map(w => w.path)).toEqual([
      `/v1/cameras/${HOME.ptzId}/ptz/goto/-1`, `/v1/cameras/${HOME.ptzId}/ptz/patrol/start/1`, `/v1/cameras/${HOME.ptzId}/ptz/patrol/stop`,
    ]);
    expect(await driveway.failure("startPatrol", 5)).toMatch(/whole number from 0 to 4/);
  });

  it("reports Protect's refusal when a camera can't pan, and doesn't send it again", async () => {
    const { console } = installFake();
    const doorbell = binding(await connectCloud(), RESOURCES.camera(HOME.doorbellId));
    await doorbell.call("goToPreset", 2);
    const { actionId } = lastSubmitted(await doorbell.queue());
    const refusal = { error: "UniFi rejected the request: Camera does not support PTZ" };
    expect(await doorbell.applyOutcome(actionId)).toEqual(refusal);
    expect(await doorbell.applyOutcome(actionId)).toEqual(refusal);
    expect(console.writes()).toHaveLength(1);
  });

  it("presents itself with the camera's name and a link into Protect", async () => {
    installFake();
    const doorbell = binding(await connectCloud(), RESOURCES.camera(HOME.doorbellId));
    expect(await doorbell.describe()).toMatchObject({
      title: "Front Door", tsType: "UnifiCamera", suggestedBindingName: "UNIFI_CAMERA",
      url: `https://unifi.ui.com/consoles/${HOME.hostId}/protect/dashboard`,
    });
  });

  it("explains a camera that's gone", async () => {
    const { console } = installFake();
    const doorbell = binding(await connectCloud(), RESOURCES.camera(HOME.doorbellId));
    console.protect!.cameras.splice(0, 1);
    expect(await doorbell.failure("describe")).toMatch(/^Not found/);
    expect(await doorbell.describe()).toMatchObject({ title: "UniFi camera" });
  });
});

describe("a sensor", () => {
  it("reads its readings, and has nothing to approve", async () => {
    installFake();
    const sensor = binding(await connectCloud(), RESOURCES.sensor);
    expect(await sensor.call("describe")).toMatchObject({
      name: "Garage Door", mountType: "door", isOpen: false, humidityPercent: 45, lightLux: 120, batteryLow: false,
    });
    expect(await hooks().autoApprovable(sensor.name, sensor.props)).toEqual({ ok: [] });
  });
});

describe("a floodlight", () => {
  it("is forced on once approved, showing it on before then", async () => {
    const { console } = installFake();
    const light = binding(await connectCloud(), RESOURCES.light);
    await light.call("setForcedOn", true);
    const { actionId, description } = lastSubmitted(await light.queue());
    expect(description).toMatchObject({ title: "Turn on floodlight “Backyard Floodlight”", autoApprovable: true });
    expect(await light.call("describe")).toMatchObject({ forcedOn: true, isOn: true });
    await light.apply(actionId);
    expect(console.writes()[0]!.body).toEqual({ isLightForceEnabled: true });
    expect(await light.call("describe")).toMatchObject({ forcedOn: true, isOn: true });
  });

  it("changes its mode and brightness", async () => {
    const { console } = installFake();
    const light = binding(await connectCloud(), RESOURCES.light);
    await light.call("setMode", "always");
    await light.call("setBrightness", 5);
    expect(await light.failure("setBrightness", 7)).toMatch(/whole number from 1 to 6/);
    expect(await light.failure("setMode", "sometimes")).toBeTruthy();
    // An unstated time of day keeps the one it has.
    expect(await light.call("describe")).toMatchObject({ mode: "always", activeWhen: "dark", brightness: 5 });
    for (const { actionId } of (await light.queue()).submitted) await light.apply(actionId);
    expect(console.writes().map(w => w.body)).toEqual([
      { lightModeSettings: { mode: "always", enableAt: "dark" } }, { lightDeviceSettings: { ledLevel: 5 } },
    ]);
  });

  it("offers to auto-approve only floodlight changes", async () => {
    installFake();
    const light = binding(await connectCloud(), RESOURCES.light);
    expect(await hooks().autoApprovable(light.name, light.props)).toEqual({ ok: [expect.objectContaining({ tag: "unifi.lightSettings" })] });
  });
});
