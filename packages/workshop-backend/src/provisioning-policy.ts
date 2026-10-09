// The provisioning policy for auto-provisioning ("ambient") gatekeepers — those that mint a connected
// account with no OAuth flow (VendorDescription.autoProvisionsAccount, e.g. the Context Library).
//
// Each such vendor has a three-state mode (see AmbientGatekeeperMode), set per deployment by the
// admin and stored in AdminConfig.ambientGatekeeperModes:
//   - 'disabled': not available; no account is provisioned, and any existing one stays dormant.
//   - 'optional': users opt in from the Connectors page; not forced on anyone. THE DEFAULT — we don't
//                 impose ambient authority on every user unless an admin explicitly turns it on —
//                 except for the vendors in ENABLED_BY_DEFAULT.
//   - 'enabled':  auto-provisioned for every user (forced); they can't remove it.
//
// These helpers are the single chokepoint for that decision; UserDurableObject reads AdminConfig and
// calls them when provisioning, listing, and surfacing ambient accounts.

import { AmbientGatekeeperMode } from "@gadgets/workshop-shared/api";
import type { AdminConfig } from "./storage-schema/admin-settings-storage.js";

// A search follows the same restricted-data rule as the agent's webFetch tool, which every agent has,
// so Web Search needs no opt-in.
const ENABLED_BY_DEFAULT = new Set(["websearch"]);

/**
 * The configured mode for an ambient vendor, or its default when the admin hasn't set one.
 * Tolerates a config persisted before this field existed (ambientGatekeeperModes may be undefined).
 */
export function ambientGatekeeperMode(config: AdminConfig, vendorId: string): AmbientGatekeeperMode {
  vendorId = vendorId.toLowerCase();
  return config.ambientGatekeeperModes?.[vendorId] ??
      (ENABLED_BY_DEFAULT.has(vendorId) ? "enabled" : "optional");
}

/**
 * Whether this vendor's account is auto-provisioned for every user ("enabled" mode). Such accounts
 * are "forced": created for everyone, not user-removable, and hidden from the Connectors list.
 * ("optional" accounts are user-managed; "disabled" ones aren't offered.)
 */
export function shouldAutoProvisionAccount(config: AdminConfig, vendorId: string): boolean {
  return ambientGatekeeperMode(config, vendorId) === "enabled";
}
