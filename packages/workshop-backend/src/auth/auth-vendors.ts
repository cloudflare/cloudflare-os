// Helpers for resolving authentication-gatekeeper service bindings.
//
// The backend discovers gatekeepers from `GATEKEEPER_<NAME>` env bindings, where the vendor id is
// the suffix lowercased (e.g. GATEKEEPER_GOOGLE -> "google"). These helpers map between the two.

import { GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";

export function gatekeeperBindingName(vendorId: string): string {
  return "GATEKEEPER_" + vendorId.toUpperCase();
}

/** Return the gatekeeper vendor service binding for `vendorId`, or null if not bound. */
export function getAuthVendorBinding(
  env: Cloudflare.Env, vendorId: string,
): Service<GatekeeperVendor> | null {
  const binding = (env as unknown as Record<string, unknown>)[gatekeeperBindingName(vendorId)];
  return (binding as Service<GatekeeperVendor>) ?? null;
}

/**
 * Build a map of every bound gatekeeper, keyed by vendor id (the GATEKEEPER_<NAME> suffix,
 * lowercased). The set of gatekeepers is deployment-global (env bindings), so this is independent of
 * any particular user.
 */
export function buildGatekeeperVendorMap(
  env: Cloudflare.Env,
): Map<string, Service<GatekeeperVendor>> {
  const vendors = new Map<string, Service<GatekeeperVendor>>();
  for (const bindingName in env) {
    if (bindingName.startsWith("GATEKEEPER_")) {
      const vendorId = bindingName.slice("GATEKEEPER_".length).toLowerCase();
      vendors.set(vendorId, (env as unknown as Record<string, Service<GatekeeperVendor>>)[bindingName]);
    }
  }
  return vendors;
}
