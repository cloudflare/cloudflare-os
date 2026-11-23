/**
 * Shows pending actions in reads, as if they had already been carried out, so an agent can keep
 * working without waiting for each approval. Each function folds the binding's pending actions, in
 * submission order, over what UniFi returned.
 *
 * Only the kinds of change an agent continues past are simulated. The others make it await the
 * decision instead (see actions.ts): a restart, a power-cycle, a PTZ command, and new vouchers,
 * whose codes the console assigns -- though those are listed meanwhile, with `code: null`.
 *
 * Pure: imported by the Node tests.
 */

import type { UnifiAction, VoucherRequest } from "./actions";
import type {
  UnifiClient, UnifiClientDetails, UnifiGuestAuthorization, UnifiVoucher, UnifiWifiNetworkInfo,
  UnifiWifiNetworkSummary,
} from "./network-types";
import type { UnifiCameraInfo, UnifiLightInfo } from "./protect-types";

/** A pending action and its ID, as the journal lists them. */
export type PendingAction = { readonly id: number; readonly action: UnifiAction };

function inOrder(pending: readonly PendingAction[]): UnifiAction[] {
  return pending.toSorted((a, b) => a.id - b.id).map(entry => entry.action);
}

// ---------------------------------------------------------------------------
// Guests

/** The last guest-access change pending for a client, if any. */
function guestChange(pending: readonly PendingAction[], siteId: string, clientId: string) {
  let last: Extract<UnifiAction, { kind: "guestAccess" }>["payload"] | undefined;
  for (const action of inOrder(pending)) {
    if (action.kind === "guestAccess" && action.payload.siteId === siteId && action.payload.clientId === clientId) {
      last = action.payload;
    }
  }
  return last;
}

/** Clients, with pending guest-access changes applied. */
export function simulateClients(clients: UnifiClient[], siteId: string, pending: readonly PendingAction[]): UnifiClient[] {
  return clients.map(client => {
    if (client.guest === null) return client;
    const change = guestChange(pending, siteId, client.id);
    return change ? { ...client, guest: { authorized: change.change.authorize } } : client;
  });
}

/** One client, with pending guest-access changes applied. */
export function simulateClientDetails(
  client: UnifiClientDetails, siteId: string, pending: readonly PendingAction[], now: number,
): UnifiClientDetails {
  if (client.guest === null) return client;
  const change = guestChange(pending, siteId, client.id);
  if (!change) return client;
  if (!change.change.authorize) return { ...client, guest: { ...client.guest, authorized: false } };
  const limits = change.change.limits;
  const guest: UnifiGuestAuthorization = {
    authorized: true,
    method: "api",
    authorizedAt: new Date(now),
    expiresAt: limits.durationMinutes !== undefined ? new Date(now + limits.durationMinutes * 60_000) : null,
    dataLimitMB: limits.dataLimitMB ?? null,
    downloadLimitKbps: limits.downloadLimitKbps ?? null,
    uploadLimitKbps: limits.uploadLimitKbps ?? null,
    bytesUsed: 0,
  };
  return { ...client, guest };
}

// ---------------------------------------------------------------------------
// WiFi

function wifiChanges(pending: readonly PendingAction[], siteId: string, wifiNetworkId: string) {
  return inOrder(pending).flatMap(action =>
    action.kind === "updateWifi" && action.payload.siteId === siteId && action.payload.wifiNetworkId === wifiNetworkId
      ? [action.payload.changes] : []);
}

/** WiFi networks, with pending changes applied. */
export function simulateWifiSummaries(
  networks: UnifiWifiNetworkSummary[], siteId: string, pending: readonly PendingAction[],
): UnifiWifiNetworkSummary[] {
  return networks.map(network => {
    let result = network;
    for (const changes of wifiChanges(pending, siteId, network.id)) {
      result = {
        ...result,
        ...(changes.name !== undefined && { name: changes.name }),
        ...(changes.enabled !== undefined && { enabled: changes.enabled }),
      };
    }
    return result;
  });
}

/** One WiFi network's settings, with pending changes applied. */
export function simulateWifiInfo(
  network: UnifiWifiNetworkInfo, siteId: string, pending: readonly PendingAction[],
): UnifiWifiNetworkInfo {
  let result = network;
  for (const changes of wifiChanges(pending, siteId, network.id)) {
    result = {
      ...result,
      ...(changes.name !== undefined && { name: changes.name }),
      ...(changes.enabled !== undefined && { enabled: changes.enabled }),
      ...(changes.hidden !== undefined && { hidden: changes.hidden }),
    };
  }
  return result;
}

/** A WiFi network's password, with a pending change applied. */
export function simulatePassphrase(
  passphrase: string | null, siteId: string, wifiNetworkId: string, pending: readonly PendingAction[],
): string | null {
  let result = passphrase;
  for (const changes of wifiChanges(pending, siteId, wifiNetworkId)) {
    if (changes.passphrase !== undefined && result !== null) result = changes.passphrase;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Vouchers

function placeholderVoucher(id: string, request: VoucherRequest, submittedAt: number): UnifiVoucher {
  return {
    id, code: null, note: request.note, createdAt: new Date(submittedAt), activatedAt: null,
    expiresAt: null, expired: false, durationMinutes: request.durationMinutes,
    guestLimit: request.guestLimit, guestCount: 0, dataLimitMB: request.dataLimitMB,
    downloadLimitKbps: request.downloadLimitKbps, uploadLimitKbps: request.uploadLimitKbps,
  };
}

/** Whether a voucher ID is a placeholder for one the console hasn't created yet. */
export function isPlaceholderVoucherId(id: string): boolean {
  return id.startsWith("pending-");
}

/** Vouchers, newest first, with pending creations and deletions applied. */
export function simulateVouchers(vouchers: UnifiVoucher[], siteId: string, pending: readonly PendingAction[]): UnifiVoucher[] {
  let result = vouchers;
  for (const action of inOrder(pending)) {
    if (action.kind === "createVouchers" && action.payload.siteId === siteId) {
      const { placeholderIds, request, submittedAt } = action.payload;
      result = [...placeholderIds.map(id => placeholderVoucher(id, request, submittedAt)), ...result];
    } else if (action.kind === "deleteVoucher" && action.payload.siteId === siteId) {
      result = result.filter(voucher => voucher.id !== action.payload.voucherId);
    }
  }
  return result.toSorted((a, b) => b.createdAt.valueOf() - a.createdAt.valueOf());
}

// ---------------------------------------------------------------------------
// Protect

/** A camera, with pending settings changes applied. */
export function simulateCamera(camera: UnifiCameraInfo, pending: readonly PendingAction[]): UnifiCameraInfo {
  let result = camera;
  for (const action of inOrder(pending)) {
    if (action.kind === "cameraSettings" && action.payload.cameraId === camera.id) {
      const change = action.payload.change;
      if ("name" in change) result = { ...result, name: change.name };
      else result = result.statusLight === null ? result : { ...result, statusLight: change.statusLight };
    } else if (action.kind === "doorbellMessage" && action.payload.cameraId === camera.id) {
      const change = action.payload.change;
      result = {
        ...result,
        doorbellDisplay: { ...change.doorbellMessage, until: change.until === null ? null : new Date(change.until) },
      };
    } else if (action.kind === "cameraMicVolume" && action.payload.cameraId === camera.id) {
      result = result.micVolume === null ? result : { ...result, micVolume: action.payload.volume };
    }
  }
  return result;
}

/**
 * Whether a light's settings alone decide that it is on -- forced on, off, or always on (when it
 * is dark, if that's when its mode applies) -- or null when motion decides.
 */
function settledOn(light: UnifiLightInfo): boolean | null {
  if (light.forcedOn) return true;
  if (light.mode === "off") return false;
  if (light.mode === "always") return light.activeWhen === "always" || light.isDark;
  return null;
}

/** A floodlight, with pending settings changes applied. */
export function simulateLight(light: UnifiLightInfo, pending: readonly PendingAction[]): UnifiLightInfo {
  let result = light;
  for (const action of inOrder(pending)) {
    if (action.kind !== "lightSettings" || action.payload.lightId !== light.id) continue;
    const change = action.payload.change;
    if ("forcedOn" in change) {
      // Released into motion mode, it stays off until something moves.
      const next = { ...result, forcedOn: change.forcedOn };
      result = { ...next, isOn: settledOn(next) ?? false };
    } else if ("mode" in change) {
      // Into motion mode, whether it is on depends on motion, so the reading stands.
      const next = { ...result, mode: change.mode, activeWhen: change.activeWhen };
      result = { ...next, isOn: settledOn(next) ?? result.isOn };
    } else {
      result = { ...result, brightness: change.brightness };
    }
  }
  return result;
}
