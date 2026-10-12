/**
 * The Protect side of the agent API (protect-types.d.ts): Protect on a console, and one camera,
 * sensor, or floodlight. Each object is bound to its IDs when it is made, and every read is
 * authorized before its data is returned.
 */

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { UnifiError } from "./errors";
import { simulateCamera, simulateLight } from "./simulation";
import { count, md, requireId, requireInteger, type SessionContext } from "./session-context";
import type {
  UnifiCamera, UnifiCameraInfo, UnifiDoorbellMessage, UnifiLight, UnifiLightInfo, UnifiLightMode,
  UnifiProtect, UnifiProtectInfo, UnifiSensor, UnifiSensorInfo, UnifiSnapshot, UnifiSnapshotOptions,
} from "./protect-types";

const MAX_DOORBELL_TEXT = 64;

function badRequest(message: string): UnifiError {
  return new UnifiError({ kind: "badRequest", message });
}

/** Protect on one console. */
@validateRpc()
export class ProtectSession extends RpcTarget implements UnifiProtect {
  readonly #ctx: SessionContext;

  constructor(ctx: SessionContext) {
    super();
    this.#ctx = ctx;
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }

  async describe(): Promise<UnifiProtectInfo> {
    const { api, consoleName } = this.#ctx.shared;
    const [info, nvr, name] = await Promise.all([api.protectInfo(), api.getNvr(), consoleName()]);
    await this.#ctx.observe("Read UniFi Protect", `Read the version and alarm state of UniFi Protect on ${md(name)}.`);
    return { consoleId: api.consoleId, consoleName: name, protectVersion: info.applicationVersion, alarm: nvr.alarm };
  }

  async listCameras(): Promise<UnifiCameraInfo[]> {
    const pending = this.#ctx.shared.pending();
    const cameras = (await this.#ctx.shared.api.listCameras()).map(camera => simulateCamera(camera, pending));
    await this.#ctx.observe("List UniFi cameras", `Listed ${count(cameras.length, "camera")} in UniFi Protect.`);
    return cameras;
  }

  getCamera(cameraId: string): UnifiCamera {
    return new CameraSession(this.#ctx.fork(), requireId(cameraId, "camera"));
  }

  async listSensors(): Promise<UnifiSensorInfo[]> {
    const sensors = await this.#ctx.shared.api.listSensors();
    await this.#ctx.observe("List UniFi sensors", `Listed ${count(sensors.length, "sensor")} and their readings in UniFi Protect.`);
    return sensors;
  }

  getSensor(sensorId: string): UnifiSensor {
    return new SensorSession(this.#ctx.fork(), requireId(sensorId, "sensor"));
  }

  async listLights(): Promise<UnifiLightInfo[]> {
    const pending = this.#ctx.shared.pending();
    const lights = (await this.#ctx.shared.api.listLights()).map(light => simulateLight(light, pending));
    await this.#ctx.observe("List UniFi floodlights", `Listed ${count(lights.length, "floodlight")} in UniFi Protect.`);
    return lights;
  }

  getLight(lightId: string): UnifiLight {
    return new LightSession(this.#ctx.fork(), requireId(lightId, "floodlight"));
  }
}

/** One camera or doorbell. */
@validateRpc()
export class CameraSession extends RpcTarget implements UnifiCamera {
  readonly #ctx: SessionContext;
  readonly #cameraId: string;

  constructor(ctx: SessionContext, cameraId: string) {
    super();
    this.#ctx = ctx;
    this.#cameraId = cameraId;
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }

  async describe(): Promise<UnifiCameraInfo> {
    const camera = await this.#camera();
    await this.#ctx.observe("Read a UniFi camera", `Read the details and settings of UniFi camera ${md(camera.name)}.`);
    return camera;
  }

  async getSnapshot(options?: UnifiSnapshotOptions): Promise<UnifiSnapshot> {
    const camera = await this.#camera();
    const packageCamera = options?.packageCamera === true;
    if (packageCamera && !camera.hasPackageCamera) throw badRequest(`${camera.name} has no package camera.`);
    const { bytes } = await this.#ctx.shared.api.snapshot(this.#cameraId, {
      highQuality: options?.highQuality === true, packageCamera,
    });
    const capturedAt = new Date(this.#ctx.shared.now());
    await this.#ctx.observe("Capture a UniFi camera snapshot",
      `Captured a still image from ${packageCamera ? "the package camera of " : ""}UniFi camera ${md(camera.name)}.`);
    return { mimeType: "image/jpeg", content: bytes, capturedAt };
  }

  async setName(name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > 64) throw badRequest("A camera name must be 1 to 64 characters.");
    const camera = await this.#camera();
    await this.#ctx.submit("cameraSettings", { cameraId: this.#cameraId, cameraName: camera.name, change: { name: trimmed } });
  }

  async setStatusLight(on: boolean): Promise<void> {
    const camera = await this.#camera();
    if (camera.statusLight === null) throw badRequest(`${camera.name} has no status light.`);
    await this.#ctx.submit("cameraSettings", { cameraId: this.#cameraId, cameraName: camera.name, change: { statusLight: on } });
  }

  async setMicVolume(volume: number): Promise<void> {
    requireInteger(volume, "The microphone volume", 1, 100);
    const camera = await this.#camera();
    if (!camera.hasMicrophone) throw badRequest(`${camera.name} has no microphone.`);
    await this.#ctx.submit("cameraMicVolume", { cameraId: this.#cameraId, cameraName: camera.name, volume });
  }

  async setDoorbellMessage(message: UnifiDoorbellMessage, options?: { until?: Date }): Promise<void> {
    if (message.kind === "text") {
      const text = message.text.trim();
      if (text === "" || text.length > MAX_DOORBELL_TEXT) {
        throw badRequest(`A doorbell message must be 1 to ${MAX_DOORBELL_TEXT} characters.`);
      }
      message = { kind: "text", text };
    } else if (message.kind !== "doNotDisturb" && message.kind !== "leavePackageAtDoor") {
      throw badRequest('A doorbell message\'s kind is "text", "doNotDisturb", or "leavePackageAtDoor".');
    }
    const until = options?.until;
    if (until !== undefined && (Number.isNaN(until.valueOf()) || until.valueOf() <= this.#ctx.shared.now())) {
      throw badRequest("`until` must be in the future.");
    }
    const camera = await this.#camera();
    await this.#ctx.submit("cameraSettings", {
      cameraId: this.#cameraId, cameraName: camera.name,
      change: { doorbellMessage: message, until: until === undefined ? null : until.valueOf() },
    });
  }

  async goToPreset(slot: number): Promise<void> {
    requireInteger(slot, "The preset slot", -1, 99);
    const camera = await this.#camera();
    await this.#ctx.submit("cameraPtz", { cameraId: this.#cameraId, cameraName: camera.name, command: { goToPreset: slot } });
  }

  async startPatrol(slot: number): Promise<void> {
    requireInteger(slot, "The patrol slot", 0, 4);
    const camera = await this.#camera();
    await this.#ctx.submit("cameraPtz", { cameraId: this.#cameraId, cameraName: camera.name, command: { startPatrol: slot } });
  }

  async stopPatrol(): Promise<void> {
    const camera = await this.#camera();
    await this.#ctx.submit("cameraPtz", { cameraId: this.#cameraId, cameraName: camera.name, command: { stopPatrol: true } });
  }

  async #camera(): Promise<UnifiCameraInfo> {
    return simulateCamera(await this.#ctx.shared.api.getCamera(this.#cameraId), this.#ctx.shared.pending());
  }
}

/** One sensor. */
@validateRpc()
export class SensorSession extends RpcTarget implements UnifiSensor {
  readonly #ctx: SessionContext;
  readonly #sensorId: string;

  constructor(ctx: SessionContext, sensorId: string) {
    super();
    this.#ctx = ctx;
    this.#sensorId = sensorId;
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }

  async describe(): Promise<UnifiSensorInfo> {
    const sensor = await this.#ctx.shared.api.getSensor(this.#sensorId);
    await this.#ctx.observe("Read a UniFi sensor", `Read the readings of UniFi sensor ${md(sensor.name)}.`);
    return sensor;
  }
}

/** One floodlight. */
@validateRpc()
export class LightSession extends RpcTarget implements UnifiLight {
  readonly #ctx: SessionContext;
  readonly #lightId: string;

  constructor(ctx: SessionContext, lightId: string) {
    super();
    this.#ctx = ctx;
    this.#lightId = lightId;
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }

  async describe(): Promise<UnifiLightInfo> {
    const light = await this.#light();
    await this.#ctx.observe("Read a UniFi floodlight", `Read the state of UniFi floodlight ${md(light.name)}.`);
    return light;
  }

  async setForcedOn(on: boolean): Promise<void> {
    const light = await this.#light();
    await this.#ctx.submit("lightSettings", { lightId: this.#lightId, lightName: light.name, change: { forcedOn: on } });
  }

  async setMode(mode: UnifiLightMode, activeWhen?: "always" | "dark"): Promise<void> {
    if (mode !== "always" && mode !== "motion" && mode !== "off") throw badRequest('`mode` is "always", "motion", or "off".');
    const light = await this.#light();
    await this.#ctx.submit("lightSettings", {
      lightId: this.#lightId, lightName: light.name, change: { mode, activeWhen: activeWhen ?? light.activeWhen },
    });
  }

  async setBrightness(level: number): Promise<void> {
    requireInteger(level, "The brightness", 1, 6);
    const light = await this.#light();
    await this.#ctx.submit("lightSettings", { lightId: this.#lightId, lightName: light.name, change: { brightness: level } });
  }

  async #light(): Promise<UnifiLightInfo> {
    return simulateLight(await this.#ctx.shared.api.getLight(this.#lightId), this.#ctx.shared.pending());
  }
}
