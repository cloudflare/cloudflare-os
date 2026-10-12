/**
 * Every change a session can ask for, declared once: how it is described to the person approving
 * it, whether it may be auto-approved, whether the agent waits for the decision, and how it is
 * carried out once approved.
 *
 * Policy, per kind:
 *
 * - Changes reads can show before approval (guest access, WiFi settings, camera and floodlight
 *   settings, deleting a voucher) continue with simulation; see simulation.ts.
 * - Changes reads can't show -- a restart, a power-cycle, a PTZ move, the codes of new vouchers --
 *   make the agent await the decision, so it doesn't act on a world where they didn't happen.
 * - Restarting the gateway, changing a WiFi network, and changing a camera's microphone volume can
 *   never be auto-approved: the first takes the whole network down, the second can lock everyone
 *   out, and the third changes what a camera records.
 * - Requests that aren't safe to send twice (restarts, power-cycles, voucher creation) are claimed
 *   before they're sent, so a crash mid-request is reported as an unknown outcome, never replayed.
 *
 * Nothing implements revert: no Workshop flow invokes it.
 */

import {
  ActionApplyError, ActionOutcomeUnknownError, APPLY_OUTCOME_UNKNOWN_MESSAGE, defineActions,
  type ActionPresentation, type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, plainInline, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import type { CameraPatch, GuestLimitsBody, LightPatch, UnifiApi, VoucherBody } from "./api";
import { provablyNoEffect, refusedBeforeDispatch, UnifiError } from "./errors";
import { PERSONAL_SECURITY_TYPES } from "./parse";
import type { UnifiResourceKind } from "./resources";
import type { UnifiGuestLimits, UnifiWifiNetworkChanges } from "./network-types";
import type { UnifiDoorbellMessage, UnifiLightMode } from "./protect-types";

/** What an approved action is carried out against: the bound console. */
export type UnifiActionHost = { api: UnifiApi };

/** Voucher options, normalized at submission. */
export type VoucherRequest = {
  count: number;
  note: string;
  durationMinutes: number;
  guestLimit: number | null;
  dataLimitMB: number | null;
  downloadLimitKbps: number | null;
  uploadLimitKbps: number | null;
};

/** The payload each kind of action stores. Names are captured when it is submitted, for display. */
export type UnifiActionPayloads = {
  restartDevice: { siteId: string; deviceId: string; deviceName: string; model: string };
  restartGateway: { siteId: string; deviceId: string; deviceName: string; model: string };
  powerCyclePort: { siteId: string; deviceId: string; deviceName: string; portIndex: number };
  guestAccess: {
    siteId: string; clientId: string; clientName: string;
    change: { authorize: true; limits: UnifiGuestLimits } | { authorize: false };
  };
  updateWifi: { siteId: string; wifiNetworkId: string; networkName: string; changes: UnifiWifiNetworkChanges };
  createVouchers: {
    siteId: string; request: VoucherRequest;
    /** Placeholder IDs the pending vouchers are listed under until the console creates them. */
    placeholderIds: string[];
    submittedAt: number;
  };
  deleteVoucher: { siteId: string; voucherId: string; note: string; code: string | null };
  cameraSettings: {
    cameraId: string; cameraName: string;
    change:
      | { name: string }
      | { statusLight: boolean }
      | { doorbellMessage: UnifiDoorbellMessage; until: number | null };
  };
  cameraMicVolume: { cameraId: string; cameraName: string; volume: number };
  cameraPtz: {
    cameraId: string; cameraName: string;
    command: { goToPreset: number } | { startPatrol: number } | { stopPatrol: true };
  };
  lightSettings: {
    lightId: string; lightName: string;
    change: { forcedOn: boolean } | { mode: UnifiLightMode; activeWhen: "always" | "dark" } | { brightness: number };
  };
};

/** A stored action. */
export type UnifiAction = TaggedAction<UnifiActionPayloads>;

const KINDS = {
  restartDevice: { tag: "unifi.restartDevice", label: "Restarting UniFi access points and switches" },
  powerCyclePort: { tag: "unifi.powerCyclePort", label: "Power-cycling UniFi PoE ports" },
  guestAccess: { tag: "unifi.guestAccess", label: "Granting and ending UniFi guest WiFi access" },
  createVouchers: { tag: "unifi.createVouchers", label: "Creating UniFi guest WiFi vouchers" },
  deleteVoucher: { tag: "unifi.deleteVoucher", label: "Deleting UniFi guest WiFi vouchers" },
  cameraSettings: { tag: "unifi.cameraSettings", label: "Renaming cameras and changing status lights and doorbell messages" },
  cameraPtz: { tag: "unifi.cameraPtz", label: "Moving UniFi PTZ cameras" },
  lightSettings: { tag: "unifi.lightSettings", label: "Controlling UniFi floodlights" },
} satisfies Partial<Record<keyof UnifiActionPayloads, ActionKind>>;

/** The actions each kind of binding can submit. */
const RESOURCE_ACTIONS: Record<UnifiResourceKind, readonly (keyof UnifiActionPayloads)[]> = {
  site: ["restartDevice", "restartGateway", "powerCyclePort", "guestAccess", "updateWifi", "createVouchers", "deleteVoucher"],
  device: ["restartDevice", "restartGateway", "powerCyclePort"],
  wifi: ["updateWifi"],
  hotspot: ["guestAccess", "createVouchers", "deleteVoucher"],
  protect: ["cameraSettings", "cameraMicVolume", "cameraPtz", "lightSettings"],
  camera: ["cameraSettings", "cameraMicVolume", "cameraPtz"],
  sensor: [],
  light: ["lightSettings"],
};

/**
 * The auto-approval tags each kind of binding can submit actions under, so a binding only offers
 * to auto-approve what it could actually ask for.
 */
export const ACTION_KINDS_BY_RESOURCE: Record<UnifiResourceKind, string[]> = Object.fromEntries(
  Object.entries(RESOURCE_ACTIONS).map(([resource, actions]) => [
    resource,
    actions.flatMap(action => {
      const kind = (KINDS as Partial<Record<keyof UnifiActionPayloads, ActionKind>>)[action];
      return kind ? [kind.tag] : [];
    }),
  ]),
) as Record<UnifiResourceKind, string[]>;

/**
 * Turns an apply failure into what the kit should record: a refusal stays pending to retry, a
 * provable no-op is terminal, and anything else is terminal with an unknown outcome when the
 * request isn't safe to send twice.
 */
async function carryOut(action: () => Promise<void>, options: { idempotent: boolean }): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (refusedBeforeDispatch(error)) throw error;
    if (provablyNoEffect(error)) throw new ActionApplyError((error as UnifiError).message);
    if (options.idempotent) throw error;
    throw new ActionOutcomeUnknownError(APPLY_OUTCOME_UNKNOWN_MESSAGE);
  }
}

function quoted(name: string): string {
  return `“${plainInline(name, 80)}”`;
}

function present(title: string, intro: string, fields: (builder: ReturnType<typeof buildDescription>) => void): ActionPresentation {
  const builder = buildDescription(intro);
  fields(builder);
  return { title: sanitizeTitle(title), ...builder.finish(), implementsRevert: false };
}

function describeLimits(builder: ReturnType<typeof buildDescription>, limits: {
  dataLimitMB?: number | null; downloadLimitKbps?: number | null; uploadLimitKbps?: number | null;
}): void {
  if (limits.dataLimitMB != null) builder.inline("Data allowance", `${limits.dataLimitMB} MB`);
  if (limits.downloadLimitKbps != null) builder.inline("Download limit", `${limits.downloadLimitKbps} kbps`);
  if (limits.uploadLimitKbps != null) builder.inline("Upload limit", `${limits.uploadLimitKbps} kbps`);
}

/** Network API names for guest limits. */
export function guestLimitsBody(limits: UnifiGuestLimits): GuestLimitsBody {
  return {
    ...(limits.durationMinutes !== undefined && { timeLimitMinutes: limits.durationMinutes }),
    ...(limits.dataLimitMB !== undefined && { dataUsageLimitMBytes: limits.dataLimitMB }),
    ...(limits.downloadLimitKbps !== undefined && { rxRateLimitKbps: limits.downloadLimitKbps }),
    ...(limits.uploadLimitKbps !== undefined && { txRateLimitKbps: limits.uploadLimitKbps }),
  };
}

/**
 * Applies WiFi changes to a full settings object from `getWifiRaw`, for `putWifi`. The object's
 * read-only fields are dropped, and a password can only be set on a WPA-Personal network.
 */
export function wifiPutBody(raw: Record<string, unknown>, changes: UnifiWifiNetworkChanges): Record<string, unknown> {
  const { id: _id, metadata: _metadata, ...body } = raw;
  if (changes.name !== undefined) body.name = changes.name;
  if (changes.enabled !== undefined) body.enabled = changes.enabled;
  if (changes.hidden !== undefined) body.hideName = changes.hidden;
  if (changes.passphrase !== undefined) {
    const security = body.securityConfiguration;
    const type = security && typeof security === "object" ? (security as Record<string, unknown>).type : undefined;
    if (typeof type !== "string" || !PERSONAL_SECURITY_TYPES.has(type)) {
      throw new UnifiError({ kind: "badRequest", message: "Only a WPA2 or WPA3 Personal network has a password to change." });
    }
    body.securityConfiguration = { ...(security as Record<string, unknown>), passphrase: changes.passphrase };
  }
  return body;
}

/** The Network API's voucher request for normalized voucher options. */
export function voucherBody(request: VoucherRequest): VoucherBody {
  return {
    count: request.count,
    name: request.note,
    timeLimitMinutes: request.durationMinutes,
    ...(request.guestLimit !== null && { authorizedGuestLimit: request.guestLimit }),
    ...(request.dataLimitMB !== null && { dataUsageLimitMBytes: request.dataLimitMB }),
    ...(request.downloadLimitKbps !== null && { rxRateLimitKbps: request.downloadLimitKbps }),
    ...(request.uploadLimitKbps !== null && { txRateLimitKbps: request.uploadLimitKbps }),
  };
}

/** Protect's camera settings change for a camera-settings action. */
export function cameraPatch(change: UnifiActionPayloads["cameraSettings"]["change"]): CameraPatch {
  if ("name" in change) return { name: change.name };
  if ("statusLight" in change) return { ledSettings: { isEnabled: change.statusLight } };
  const message = change.doorbellMessage;
  // Left out, `resetAt` falls back to the doorbell's default timeout; `null` would keep the message forever.
  const reset = change.until === null ? {} : { resetAt: change.until };
  return {
    lcdMessage: message.kind === "text"
      ? { type: "CUSTOM_MESSAGE", text: message.text, ...reset }
      : { type: message.kind === "doNotDisturb" ? "DO_NOT_DISTURB" : "LEAVE_PACKAGE_AT_DOOR", ...reset },
  };
}

/** Protect's floodlight settings change for a floodlight action. */
export function lightPatch(change: UnifiActionPayloads["lightSettings"]["change"]): LightPatch {
  if ("forcedOn" in change) return { isLightForceEnabled: change.forcedOn };
  if ("mode" in change) return { lightModeSettings: { mode: change.mode, enableAt: change.activeWhen === "dark" ? "dark" : "fulltime" } };
  return { lightDeviceSettings: { ledLevel: change.brightness } };
}

/** Every action kind. */
export const UNIFI_ACTIONS = defineActions<UnifiActionHost, UnifiActionPayloads>({
  restartDevice: {
    kind: KINDS.restartDevice,
    autoApprovable: true,
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: p => present(`Restart ${quoted(p.deviceName)}`,
      "Restarts this UniFi device. It is offline for a minute or two while it restarts.",
      b => b.inline("Device", p.deviceName).inline("Model", p.model)),
    apply: (p, { api }) => carryOut(() => api.restartDevice(p.siteId, p.deviceId), { idempotent: false }),
  },
  restartGateway: {
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: p => present(`Restart the gateway ${quoted(p.deviceName)}`,
      "Restarts the site's gateway. **The whole network and its internet connection go down** for " +
      "several minutes while it restarts.",
      b => b.inline("Gateway", p.deviceName).inline("Model", p.model)),
    apply: (p, { api }) => carryOut(() => api.restartDevice(p.siteId, p.deviceId), { idempotent: false }),
  },
  powerCyclePort: {
    kind: KINDS.powerCyclePort,
    autoApprovable: true,
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: p => present(`Power-cycle port ${p.portIndex} on ${quoted(p.deviceName)}`,
      "Turns PoE power on this port off and back on, restarting whatever it powers.",
      b => b.inline("Device", p.deviceName).inline("Port", String(p.portIndex))),
    apply: (p, { api }) =>
      carryOut(() => api.powerCyclePort(p.siteId, p.deviceId, p.portIndex), { idempotent: false }),
  },
  guestAccess: {
    kind: KINDS.guestAccess,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: p => p.change.authorize
      ? present(`Let guest ${quoted(p.clientName)} use the WiFi`,
        "Authorizes this guest on the site's guest network, replacing any access it already has.",
        b => {
          const limits = (p.change as { limits: UnifiGuestLimits }).limits;
          b.inline("Guest", p.clientName);
          b.inline("Duration", limits.durationMinutes !== undefined
            ? `${limits.durationMinutes} minutes` : "the site's default");
          describeLimits(b, limits);
        })
      : present(`End guest ${quoted(p.clientName)}'s WiFi access`,
        "Ends this guest's authorization, disconnecting it from the guest network.",
        b => b.inline("Guest", p.clientName)),
    apply: (p, { api }) => carryOut(async () => {
      if (p.change.authorize) await api.authorizeGuest(p.siteId, p.clientId, guestLimitsBody(p.change.limits));
      else await api.revokeGuest(p.siteId, p.clientId);
    }, { idempotent: true }),
  },
  updateWifi: {
    delivery: "continue-with-simulation",
    describe: p => present(`Change WiFi network ${quoted(p.networkName)}`,
      "Changes this WiFi network's settings. Devices may disconnect while it changes.",
      b => {
        b.inline("Network", p.networkName);
        if (p.changes.name !== undefined) b.inline("New name", p.changes.name);
        if (p.changes.enabled !== undefined) b.inline("Broadcast", p.changes.enabled ? "On" : "Off");
        if (p.changes.hidden !== undefined) b.inline("Hidden", p.changes.hidden ? "Yes" : "No");
        if (p.changes.passphrase !== undefined) b.inline("New password", p.changes.passphrase);
      }),
    apply: (p, { api }) => carryOut(async () => {
      const raw = await api.getWifiRaw(p.siteId, p.wifiNetworkId);
      await api.putWifi(p.siteId, p.wifiNetworkId, wifiPutBody(raw, p.changes));
    }, { idempotent: true }),
  },
  createVouchers: {
    kind: KINDS.createVouchers,
    autoApprovable: true,
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: p => present(
      `Create ${p.request.count === 1 ? "a guest WiFi voucher" : `${p.request.count} guest WiFi vouchers`}`,
      "Creates hotspot vouchers that let guests sign in to the guest network.",
      b => {
        b.inline("Note", p.request.note);
        b.inline("Access per voucher", `${p.request.durationMinutes} minutes from first use`);
        b.inline("Guests per voucher", p.request.guestLimit === null ? "Any number" : String(p.request.guestLimit));
        describeLimits(b, p.request);
      }),
    apply: (p, { api }) => carryOut(async () => {
      await api.createVouchers(p.siteId, voucherBody(p.request));
    }, { idempotent: false }),
  },
  deleteVoucher: {
    kind: KINDS.deleteVoucher,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: p => present(`Delete guest WiFi voucher ${quoted(p.note || p.code || p.voucherId)}`,
      "Deletes this voucher so it can no longer be used.",
      b => {
        if (p.note) b.inline("Note", p.note);
        if (p.code) b.inline("Code", p.code);
      }),
    apply: (p, { api }) => carryOut(async () => {
      try {
        await api.deleteVoucher(p.siteId, p.voucherId);
      } catch (error) {
        // Already gone, which is what was asked for.
        if (error instanceof UnifiError && error.kind === "notFound") return;
        throw error;
      }
    }, { idempotent: true }),
  },
  cameraSettings: {
    kind: KINDS.cameraSettings,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: p => {
      const change = p.change;
      if ("name" in change) {
        return present(`Rename camera ${quoted(p.cameraName)}`, "Renames this camera.",
          b => b.inline("Camera", p.cameraName).inline("New name", change.name));
      }
      if ("statusLight" in change) {
        return present(`Turn ${change.statusLight ? "on" : "off"} the status light on ${quoted(p.cameraName)}`,
          "Turns this camera's status light on or off.", b => b.inline("Camera", p.cameraName));
      }
      const message = change.doorbellMessage;
      return present(`Change the message on doorbell ${quoted(p.cameraName)}`,
        "Shows a message on this doorbell's screen.",
        b => {
          b.inline("Doorbell", p.cameraName);
          b.inline("Message", message.kind === "text" ? message.text
            : message.kind === "doNotDisturb" ? "Do not disturb" : "Leave package at door");
          b.inline("Until", change.until === null ? "the doorbell's default timeout" : new Date(change.until).toISOString());
        });
    },
    apply: (p, { api }) => carryOut(() => api.patchCamera(p.cameraId, cameraPatch(p.change)), { idempotent: true }),
  },
  cameraMicVolume: {
    delivery: "continue-with-simulation",
    describe: p => present(`Set the microphone volume of ${quoted(p.cameraName)} to ${p.volume}`,
      "Changes how loud this camera records sound.",
      b => b.inline("Camera", p.cameraName).inline("Volume", `${p.volume} of 100`)),
    apply: (p, { api }) => carryOut(() => api.patchCamera(p.cameraId, { micVolume: p.volume }), { idempotent: true }),
  },
  cameraPtz: {
    kind: KINDS.cameraPtz,
    autoApprovable: true,
    delivery: "await-decision",
    describe: p => {
      const command = p.command;
      if ("goToPreset" in command) {
        return present(`Turn ${quoted(p.cameraName)} to ${command.goToPreset === -1 ? "its home position" : `preset ${command.goToPreset}`}`,
          "Moves this PTZ camera to a saved position.", b => b.inline("Camera", p.cameraName));
      }
      if ("startPatrol" in command) {
        return present(`Start patrol ${command.startPatrol} on ${quoted(p.cameraName)}`,
          "Starts one of this PTZ camera's saved patrols.", b => b.inline("Camera", p.cameraName));
      }
      return present(`Stop the patrol on ${quoted(p.cameraName)}`, "Stops this PTZ camera's patrol.",
        b => b.inline("Camera", p.cameraName));
    },
    apply: (p, { api }) => carryOut(async () => {
      const command = p.command;
      if ("goToPreset" in command) await api.ptzGoTo(p.cameraId, command.goToPreset);
      else if ("startPatrol" in command) await api.ptzStartPatrol(p.cameraId, command.startPatrol);
      else await api.ptzStopPatrol(p.cameraId);
    }, { idempotent: true }),
  },
  lightSettings: {
    kind: KINDS.lightSettings,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: p => {
      const change = p.change;
      if ("forcedOn" in change) {
        return present(change.forcedOn ? `Turn on floodlight ${quoted(p.lightName)}`
          : `Return floodlight ${quoted(p.lightName)} to its schedule`,
          change.forcedOn ? "Forces this floodlight on until it is released."
            : "Stops forcing this floodlight on; it follows its mode again.",
          b => b.inline("Floodlight", p.lightName));
      }
      if ("mode" in change) {
        return present(`Change when floodlight ${quoted(p.lightName)} turns on`,
          "Changes when this floodlight turns on by itself.",
          b => b.inline("Floodlight", p.lightName)
            .inline("Turns on", change.mode === "always" ? "Always" : change.mode === "motion" ? "On motion" : "Never")
            .inline("When", change.activeWhen === "dark" ? "Only after dark" : "Any time of day"));
      }
      return present(`Set floodlight ${quoted(p.lightName)} brightness to ${change.brightness}`,
        "Changes this floodlight's brightness.",
        b => b.inline("Floodlight", p.lightName).inline("Brightness", `${change.brightness} of 6`));
    },
    apply: (p, { api }) => carryOut(() => api.patchLight(p.lightId, lightPatch(p.change)), { idempotent: true }),
  },
}, {
  // Authority-independent: a reconnect must reach the same UniFi account (cloud) or the same
  // console (direct), so an action approved before one still targets what it was staged against.
  fence: "none",
  vendorId: "unifi",
});
