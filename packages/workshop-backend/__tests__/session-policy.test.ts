import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_IDLE_MINUTES, DEFAULT_MAX_LIFETIME_HOURS,
  getSessionCeiling, resolveSessionPolicy, sessionExpiry,
} from "../src/auth/session-policy.js";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

// Only the two session vars matter here; cast keeps the fixtures readable.
const env = (vars: Record<string, string> = {}) => vars as unknown as Cloudflare.Env;

describe("getSessionCeiling", () => {
  it("falls back to the defaults when unset", () => {
    expect(getSessionCeiling(env())).toEqual({
      lifetimeMs: DEFAULT_MAX_LIFETIME_HOURS * HOUR,
      idleMs: DEFAULT_MAX_IDLE_MINUTES * MINUTE,
    });
  });

  it("reads the configured ceilings", () => {
    expect(getSessionCeiling(env({
      SESSION_MAX_LIFETIME_HOURS: "4",
      SESSION_MAX_IDLE_MINUTES: "15",
    }))).toEqual({ lifetimeMs: 4 * HOUR, idleMs: 15 * MINUTE });
  });

  // A typo must not switch the control off, so non-positive and unparseable values fall back to
  // the default rather than being honoured as "never expires".
  it.each(["0", "-1", "nonsense", ""])("falls back for %o", raw => {
    expect(getSessionCeiling(env({ SESSION_MAX_LIFETIME_HOURS: raw })).lifetimeMs)
        .toBe(DEFAULT_MAX_LIFETIME_HOURS * HOUR);
  });
});

describe("resolveSessionPolicy", () => {
  const ceiling = env({ SESSION_MAX_LIFETIME_HOURS: "12", SESSION_MAX_IDLE_MINUTES: "60" });

  it("uses the ceiling when the admin has set nothing", () => {
    expect(resolveSessionPolicy(ceiling, {}))
        .toEqual({ lifetimeMs: 12 * HOUR, idleMs: 60 * MINUTE });
  });

  it("lets the admin tighten within the ceiling", () => {
    expect(resolveSessionPolicy(ceiling, { sessionLifetimeHours: 8, sessionIdleMinutes: 30 }))
        .toEqual({ lifetimeMs: 8 * HOUR, idleMs: 30 * MINUTE });
  });

  // The security property: a compromised admin session must not be able to weaken expiry.
  it("clamps an admin trying to exceed the ceiling", () => {
    expect(resolveSessionPolicy(ceiling, { sessionLifetimeHours: 720, sessionIdleMinutes: 10_080 }))
        .toEqual({ lifetimeMs: 12 * HOUR, idleMs: 60 * MINUTE });
  });

  // Lowering the env ceiling must tighten deployments that already stored a looser admin value,
  // without requiring the stored config to be rewritten.
  it("re-clamps stored admin values when the ceiling is lowered", () => {
    const lowered = env({ SESSION_MAX_LIFETIME_HOURS: "2", SESSION_MAX_IDLE_MINUTES: "5" });
    expect(resolveSessionPolicy(lowered, { sessionLifetimeHours: 8, sessionIdleMinutes: 30 }))
        .toEqual({ lifetimeMs: 2 * HOUR, idleMs: 5 * MINUTE });
  });

  it("treats non-positive admin values as unset", () => {
    expect(resolveSessionPolicy(ceiling, { sessionLifetimeHours: 0, sessionIdleMinutes: -5 }))
        .toEqual({ lifetimeMs: 12 * HOUR, idleMs: 60 * MINUTE });
  });
});

describe("sessionExpiry", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const policy = { lifetimeMs: 12 * HOUR, idleMs: 60 * MINUTE };

  it("uses our lifetime when no IdP expiry is supplied", () => {
    expect(sessionExpiry(policy, now)).toEqual(new Date("2026-08-10T00:00:00Z"));
  });

  it("honours a shorter IdP expiry", () => {
    expect(sessionExpiry(policy, now, new Date("2026-08-09T13:00:00Z")))
        .toEqual(new Date("2026-08-09T13:00:00Z"));
  });

  // A permissive or misconfigured IdP must not be able to mint an effectively immortal session.
  it("clamps an IdP expiry beyond our ceiling", () => {
    expect(sessionExpiry(policy, now, new Date("2027-08-09T12:00:00Z")))
        .toEqual(new Date("2026-08-10T00:00:00Z"));
  });
});
