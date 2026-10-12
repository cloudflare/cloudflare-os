// UniFi Protect: the cameras, doorbells, sensors, and floodlights managed by UniFi Protect on one
// UniFi console. Depending on what the user granted, this binding is one of:
//
//   - `UnifiProtect`: everything in Protect on the console.
//   - `UnifiCamera`: one camera or doorbell.
//   - `UnifiSensor`: one sensor.
//   - `UnifiLight`: one floodlight.
//
// IDs are opaque strings. Take them from list results rather than constructing them. To give a
// gadget a single camera, sensor, or floodlight, request a connection using the `consoleId` from
// `UnifiProtect.describe()` and the device's `id`; call listConnectableResources for the URL
// patterns.
//
// A console answers a limited number of requests per minute, shared by everything that uses it, so
// don't poll more often than every 10 seconds, and capture snapshots only as often as you need
// them. A call made over the limit throws an error that mentions the rate limit; retry after a
// short wait. Reported states can trail reality by a few seconds.

// ---------------------------------------------------------------------------
// Protect

/** Whether a Protect device is connected to the console. */
export type UnifiProtectDeviceState = "connected" | "connecting" | "disconnected";

/**
 * The state of Protect's alarm:
 *
 * - `disabled`: not armed.
 * - `arming`: counting down to armed.
 * - `armed`: armed.
 * - `breach`: tripped while armed.
 * - `unknown`: any other state.
 */
export type UnifiArmStatus = "disabled" | "arming" | "armed" | "breach" | "unknown";

/** The UniFi Protect application on a console. */
export type UnifiProtectInfo = {
  /** Identifies the UniFi console that runs Protect. */
  consoleId: string;
  /** The console's name, e.g. "Dream Machine Pro". */
  consoleName: string;
  /** Version of UniFi Protect, e.g. "7.3.70". */
  protectVersion: string;
  /** Protect's alarm. */
  alarm: {
    /** Current state. */
    status: UnifiArmStatus;
    /** When it was last armed, if it is armed. */
    armedAt: Date | null;
    /** When it was tripped, if it is in `breach`. */
    breachDetectedAt: Date | null;
  };
};

// ---------------------------------------------------------------------------
// Cameras

/** An object type a camera's smart detection can recognize. */
export type UnifiSmartDetectType =
  | "person" | "vehicle" | "package" | "licensePlate" | "face" | "animal";

/** A message to show on a doorbell's screen. */
export type UnifiDoorbellMessage =
  | { kind: "leavePackageAtDoor" }
  | { kind: "doNotDisturb" }
  | { kind: "text"; text: string };

/** What a doorbell's screen shows in place of its default message. */
export type UnifiDoorbellDisplay = (UnifiDoorbellMessage | { kind: "image" }) & {
  /** When the screen goes back to the default message, if that is scheduled. */
  until: Date | null;
};

/** A camera or doorbell, with its current settings. */
export type UnifiCameraInfo = {
  /** Camera ID. */
  id: string;
  /** Name shown in UniFi Protect. */
  name: string;
  /** Model name, e.g. "G4 Doorbell Pro", if known. */
  model: string | null;
  /** Whether the camera is connected. */
  state: UnifiProtectDeviceState;
  /** MAC address, lowercase and colon-separated. */
  macAddress: string;
  /** Object types the camera can detect. */
  smartDetectTypes: UnifiSmartDetectType[];
  /** Object types it is currently set to detect. */
  enabledSmartDetectTypes: UnifiSmartDetectType[];
  /** True for a doorbell with a second, downward-facing package camera. */
  hasPackageCamera: boolean;
  /** Whether it has a microphone. */
  hasMicrophone: boolean;
  /** Whether it has a speaker. */
  hasSpeaker: boolean;
  /** Whether its status light is on, or `null` if it has none. */
  statusLight: boolean | null;
  /** Microphone volume from 0 to 100, or `null` if it has no microphone. */
  micVolume: number | null;
  /** What a doorbell's screen shows in place of its default message, or `null`. */
  doorbellDisplay: UnifiDoorbellDisplay | null;
  /** The patrol a PTZ camera is running (slot 0 to 4), or `null`. */
  activePatrol: number | null;
};

/** A still image from a camera. */
export type UnifiSnapshot = {
  /** Always `image/jpeg`. */
  mimeType: "image/jpeg";
  /** The JPEG file's bytes. */
  content: ArrayBuffer;
  /** When the image was captured. */
  capturedAt: Date;
};

/** Options for `UnifiCamera.getSnapshot()`. */
export type UnifiSnapshotOptions = {
  /**
   * Capture at 1080p or higher rather than the camera's default snapshot size. Cameras that can't
   * capture at that size ignore it.
   */
  highQuality?: boolean;
  /** Capture from a doorbell's package camera rather than its main one. */
  packageCamera?: boolean;
};

// ---------------------------------------------------------------------------
// Sensors

/** A Protect sensor, such as a UP-Sense: contact, motion, climate, leak, or smoke and CO. */
export type UnifiSensorInfo = {
  /** Sensor ID. */
  id: string;
  /** Name shown in UniFi Protect. */
  name: string;
  /** Model name, if known. */
  model: string | null;
  /** Whether the sensor is connected. */
  state: UnifiProtectDeviceState;
  /** What it is mounted on, which decides what `isOpen` describes. */
  mountType: "door" | "window" | "garage" | "leak" | "none";
  /** Whether the door, window, or garage door is open, or `null` if it doesn't sense that. */
  isOpen: boolean | null;
  /** When it last opened or closed. */
  openChangedAt: Date | null;
  /** Whether it senses motion right now. */
  motionDetected: boolean;
  /** When it last sensed motion. */
  motionDetectedAt: Date | null;
  /** Temperature in °C, if it measures it. */
  temperatureC: number | null;
  /** Relative humidity in percent, if it measures it. */
  humidityPercent: number | null;
  /** Ambient light in lux, if it measures it. */
  lightLux: number | null;
  /** When it last detected a water leak. */
  leakDetectedAt: Date | null;
  /** When it last raised a smoke or carbon monoxide alarm. */
  alarmTriggeredAt: Date | null;
  /** When it last detected tampering. */
  tamperingDetectedAt: Date | null;
  /** Battery charge in percent, if known. */
  batteryPercent: number | null;
  /** Whether the battery is low. */
  batteryLow: boolean;
};

// ---------------------------------------------------------------------------
// Floodlights

/** When a floodlight turns on by itself: always, on motion, or never. */
export type UnifiLightMode = "always" | "motion" | "off";

/** A Protect floodlight. */
export type UnifiLightInfo = {
  /** Light ID. */
  id: string;
  /** Name shown in UniFi Protect. */
  name: string;
  /** Model name, if known. */
  model: string | null;
  /** Whether the light is connected. */
  state: UnifiProtectDeviceState;
  /** Whether the light is on right now. */
  isOn: boolean;
  /** Whether it is forced on, overriding its mode; see `UnifiLight.setForcedOn()`. */
  forcedOn: boolean;
  /** When it turns on by itself. */
  mode: UnifiLightMode;
  /** Whether `mode` applies at any time of day or only when it is dark. */
  activeWhen: "always" | "dark";
  /** Brightness, from 1 to 6. */
  brightness: number;
  /** Whether it senses that it is dark. */
  isDark: boolean;
  /** When its motion sensor last triggered. */
  lastMotionAt: Date | null;
  /** ID of the camera paired with it, if any. */
  pairedCameraId: string | null;
};

// ---------------------------------------------------------------------------
// Capabilities

/** UniFi Protect on one console. */
export interface UnifiProtect {
  /** Returns the console, the Protect version, and the alarm's state. */
  describe(): Promise<UnifiProtectInfo>;

  /** Lists cameras and doorbells. */
  listCameras(): Promise<UnifiCameraInfo[]>;

  /** Returns a capability for one camera. Fetches nothing until used. */
  getCamera(cameraId: string): UnifiCamera;

  /** Lists sensors with their current readings. */
  listSensors(): Promise<UnifiSensorInfo[]>;

  /** Returns a capability for one sensor. Fetches nothing until used. */
  getSensor(sensorId: string): UnifiSensor;

  /** Lists floodlights. */
  listLights(): Promise<UnifiLightInfo[]>;

  /** Returns a capability for one floodlight. Fetches nothing until used. */
  getLight(lightId: string): UnifiLight;
}

/** One camera or doorbell. */
export interface UnifiCamera {
  /** Returns the camera's details and current settings. */
  describe(): Promise<UnifiCameraInfo>;

  /**
   * Captures a still image from the camera now. Throws if the camera is disconnected, or if
   * `packageCamera` is set on a camera without one.
   *
   * @example
   * const snapshot = await env.FRONT_DOOR.getSnapshot();
   * const image = new Blob([snapshot.content], { type: snapshot.mimeType });
   */
  getSnapshot(options?: UnifiSnapshotOptions): Promise<UnifiSnapshot>;

  /** Renames the camera. */
  setName(name: string): Promise<void>;

  /** Turns the camera's status light on or off. Throws if it has none. */
  setStatusLight(on: boolean): Promise<void>;

  /** Sets the microphone volume, from 1 to 100. Throws if the camera has no microphone. */
  setMicVolume(volume: number): Promise<void>;

  /**
   * Shows a message on a doorbell's screen. The screen goes back to its default message at
   * `until`, or after the doorbell's default timeout when `until` is omitted. Doorbells with a
   * screen only; other cameras reject it.
   *
   * @example
   * await env.FRONT_DOOR.setDoorbellMessage({ kind: "text", text: "Back in 10 minutes" });
   */
  setDoorbellMessage(message: UnifiDoorbellMessage, options?: { until?: Date }): Promise<void>;

  /**
   * Turns a PTZ camera to one of its saved presets; slot `-1` is its home position. PTZ cameras
   * only; other cameras reject it.
   */
  goToPreset(slot: number): Promise<void>;

  /** Starts one of a PTZ camera's saved patrols, slot 0 to 4. PTZ cameras only. */
  startPatrol(slot: number): Promise<void>;

  /** Stops a PTZ camera's patrol. PTZ cameras only. */
  stopPatrol(): Promise<void>;
}

/** One sensor. */
export interface UnifiSensor {
  /** Returns the sensor's current readings. */
  describe(): Promise<UnifiSensorInfo>;
}

/** One floodlight. */
export interface UnifiLight {
  /** Returns the light's state and settings. */
  describe(): Promise<UnifiLightInfo>;

  /**
   * Forces the light on (`true`), or releases it back to its mode (`false`). A released light may
   * stay on if its mode is `always`.
   */
  setForcedOn(on: boolean): Promise<void>;

  /** Sets when the light turns on by itself, and whether only after dark. */
  setMode(mode: UnifiLightMode, activeWhen?: "always" | "dark"): Promise<void>;

  /** Sets the brightness, from 1 to 6. */
  setBrightness(level: number): Promise<void>;
}
