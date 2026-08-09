// Session lifetime policy: how long a login session stays valid.
//
// Two-layer design, deliberate. The env vars set a **ceiling** an admin cannot exceed; the admin
// may tighten within it via AdminConfig. This keeps the property that
// authentication/authorization config is not weakenable from a compromised admin session (see
// admin-config.ts and auth/config.ts) while still letting an operator tune policy from the UI
// without a redeploy. An admin can annoy users; an admin cannot switch the control off.
//
// Both bounds apply simultaneously and independently:
//   - absolute lifetime: hard cap from the moment the session was minted; no activity extends it.
//   - idle timeout: a sliding window reset by user-driven RPCs, so an open tab watching a long
//     agent turn keeps its session while an abandoned one expires.

// Ceilings when the env vars are unset. Chosen for a classified-network deployment, where
// accreditation regimes (e.g. NIST 800-53 AC-12) generally expect idle timeouts in the tens of
// minutes and re-authentication at least daily — rather than the multi-week sessions typical of
// consumer SaaS.
export const DEFAULT_MAX_LIFETIME_HOURS = 12;
export const DEFAULT_MAX_IDLE_MINUTES = 60;

/** Resolved session bounds, in milliseconds. */
export interface SessionPolicy {
  /** Absolute lifetime from mint time. Never extended. */
  lifetimeMs: number;
  /** Idle window, refreshed by user-driven activity. */
  idleMs: number;
}

// Parse a positive-number env var, falling back to a default. Zero, negative and unparseable
// values fall back rather than disabling the bound — "0" must never mean "no expiry", or a typo
// silently removes the control.
function readPositive(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * The deployment ceiling: the loosest policy this deployment permits, from env vars only.
 * An admin setting is clamped to this and can never exceed it.
 */
export function getSessionCeiling(env: Cloudflare.Env): SessionPolicy {
  return {
    lifetimeMs: readPositive(env.SESSION_MAX_LIFETIME_HOURS, DEFAULT_MAX_LIFETIME_HOURS)
        * 60 * 60 * 1000,
    idleMs: readPositive(env.SESSION_MAX_IDLE_MINUTES, DEFAULT_MAX_IDLE_MINUTES) * 60 * 1000,
  };
}

/**
 * The effective policy: the admin's chosen values clamped to the deployment ceiling. Admin values
 * are optional; absent (or non-positive, or looser than the ceiling) means "use the ceiling".
 *
 * Clamping rather than rejecting is deliberate: lowering the env ceiling below a previously-saved
 * admin value must tighten sessions immediately, not fail closed on read or leave a stale looser
 * value in force.
 */
export function resolveSessionPolicy(
  env: Cloudflare.Env,
  admin: { sessionLifetimeHours?: number; sessionIdleMinutes?: number },
): SessionPolicy {
  const ceiling = getSessionCeiling(env);
  const lifetime = admin.sessionLifetimeHours && admin.sessionLifetimeHours > 0
      ? admin.sessionLifetimeHours * 60 * 60 * 1000 : ceiling.lifetimeMs;
  const idle = admin.sessionIdleMinutes && admin.sessionIdleMinutes > 0
      ? admin.sessionIdleMinutes * 60 * 1000 : ceiling.idleMs;
  return {
    lifetimeMs: Math.min(lifetime, ceiling.lifetimeMs),
    idleMs: Math.min(idle, ceiling.idleMs),
  };
}

/**
 * Expiry for a session being minted now. `idpExpiresAt` is an external identity provider's own
 * expiry (an OIDC `exp` claim, say): when present it wins, because the IdP owns the session's
 * lifetime — but it is still clamped to our ceiling, so a misconfigured IdP handing out year-long
 * tokens cannot create an effectively immortal session here.
 */
export function sessionExpiry(policy: SessionPolicy, now: Date, idpExpiresAt?: Date): Date {
  const ours = now.getTime() + policy.lifetimeMs;
  return new Date(idpExpiresAt ? Math.min(idpExpiresAt.getTime(), ours) : ours);
}
