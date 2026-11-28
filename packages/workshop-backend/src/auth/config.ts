// Configuration for sign-in via authentication gatekeepers (an optional, additive login feature).
//
// Authentication is provided by gatekeepers (e.g. "google", "github", "cloudflare") that advertise
// `providesAuth`. A deployment opts specific gatekeepers into the login UI via the AUTH_GATEKEEPERS
// allowlist (comma-separated vendor ids). When set, each listed, auth-capable gatekeeper gets a
// "Continue with ..." button alongside the normal username/password form (unless password auth is
// disabled). All OFF by default.

/**
 * Parse the AUTH_GATEKEEPERS allowlist into a list of gatekeeper vendor ids (lowercased). These are
 * the gatekeepers permitted to drive sign-in; a vendor must also actually advertise `providesAuth`
 * to be offered. Empty when unset.
 */
export function getAuthGatekeeperAllowlist(env: Cloudflare.Env): string[] {
  const raw = (env as { AUTH_GATEKEEPERS?: string }).AUTH_GATEKEEPERS;
  if (!raw) return [];
  return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** Whether the deployment has opted any gatekeeper into sign-in. */
export function hasAuthGatekeepers(env: Cloudflare.Env): boolean {
  return getAuthGatekeeperAllowlist(env).length > 0;
}

/**
 * Whether the user `name` is one of the deployment admins the ADMINS binding lists. Names match
 * regardless of the case of ASCII letters, as Cloudflare Access matches its email rules: the
 * list is typed by hand, while a sign-in names its user by the email as the identity provider
 * spells it, or by a password username, which is stored lowercased. False for an empty or absent
 * name.
 */
export function isDeploymentAdmin(env: Cloudflare.Env, name: string | undefined): boolean {
  let admins: unknown = env.ADMINS;
  if (!name || !admins) return false;

  if (typeof admins === "string") {
    // Admins should be a JSON binding of array type, but `.env` doesn't actually let you
    // specify JSON bindings, so we also support a string that parses as JSON array.
    admins = JSON.parse(admins);
  }

  if (!Array.isArray(admins)) {
    throw new TypeError("ADMINS must be configured as an array of usernames.");
  }

  let lowered = asciiLowerCase(name);
  return admins.some(admin => typeof admin === "string" && asciiLowerCase(admin) === lowered);
}

/**
 * Vendor id of the admin gatekeeper (the suffix of GATEKEEPER_ADMIN, lowercased): the one vendor
 * a deployment admin's connect flow hands their Admin API to (see AdminApiGrantImpl), and the one
 * told whether a user is a deployment admin (see supportedResourcesHint()). The binding is trusted
 * as the backend's own configuration is, and the release build refuses any other package whose
 * install slug folds to this id.
 */
export const ADMIN_GATEKEEPER_VENDOR_ID = "admin";

/**
 * What vendor `vendorId`'s GatekeeperVendor.getSupportedResources() is told of the user it is
 * asked for. Only the admin gatekeeper is told whether they are a deployment admin: who the
 * deployment's admins are is no other vendor's to know.
 */
export function supportedResourcesHint(env: Cloudflare.Env, userId: string, vendorId: string)
    : { userId: string, isAdmin?: boolean } {
  return vendorId === ADMIN_GATEKEEPER_VENDOR_ID
    ? { userId, isAdmin: isDeploymentAdmin(env, userId) }
    : { userId };
}

// Only ASCII letters are folded: toLowerCase() also folds some other characters onto ASCII ones,
// such as the Kelvin sign onto "k", which would let a look-alike name match an admin's.
const asciiLowerCase = (text: string) => text.replace(/[A-Z]/g, letter => letter.toLowerCase());

/**
 * Whether username/password login + signup is available. Enabled by default. An installation can
 * set DISABLE_PASSWORD_AUTH=true to be OAuth-only — but that only takes effect when at least one
 * auth gatekeeper is allowlisted, otherwise we'd lock everyone out, so password auth stays on.
 */
export function isPasswordAuthEnabled(env: Cloudflare.Env): boolean {
  if (env.DISABLE_PASSWORD_AUTH !== "true") return true;
  return !hasAuthGatekeepers(env);
}
