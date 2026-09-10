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
 * Whether username/password login + signup is available. Enabled by default. An installation can
 * set DISABLE_PASSWORD_AUTH=true to be OAuth-only — but that only takes effect when at least one
 * auth gatekeeper is allowlisted, otherwise we'd lock everyone out, so password auth stays on.
 */
export function isPasswordAuthEnabled(env: Cloudflare.Env): boolean {
  if (env.DISABLE_PASSWORD_AUTH !== "true") return true;
  return !hasAuthGatekeepers(env);
}

/** Validate the explicitly authorized migration; no arbitrary domains, chains, or cycles. */
export function emailMigrationEnabled(env: Pick<Cloudflare.Env, "AUTH_EMAIL_DOMAIN_ALIASES">): boolean {
  const raw = env.AUTH_EMAIL_DOMAIN_ALIASES;
  if (raw === undefined) return false;
  const aliases: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) {
    throw new Error("Invalid AUTH_EMAIL_DOMAIN_ALIASES configuration.");
  }
  const entries = Object.entries(aliases);
  if (entries.length === 0) return false;
  if (entries.length !== 1 || entries[0][0] !== "heyodie.ai" || entries[0][1] !== "totango.com") {
    throw new Error("AUTH_EMAIL_DOMAIN_ALIASES supports only heyodie.ai -> totango.com.");
  }
  return true;
}

/** Return exact, same-local-part identities, canonical legacy identity first. */
export function accountEmailIdentities(
    email: string, env: Pick<Cloudflare.Env, "AUTH_EMAIL_DOMAIN_ALIASES">): string[] {
  const enabled = emailMigrationEnabled(env);
  const match = /^([^@\s:]+)@(heyodie\.ai|totango\.com)$/i.exec(email);
  if (!enabled || !match) return [email];
  return [`${match[1]}@totango.com`, `${match[1]}@heyodie.ai`];
}

/** Match a policy domain without changing its persisted representation. */
export function matchesAuthEmailDomain(email: string, domain: string,
    env: Pick<Cloudflare.Env, "AUTH_EMAIL_DOMAIN_ALIASES"> = {}): boolean {
  return accountEmailIdentities(email, env).some(identity => {
    const match = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([^@]+)$/i.exec(identity);
    return match?.[1].toLowerCase() === domain.toLowerCase();
  });
}
