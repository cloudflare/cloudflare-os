import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accountEmailIdentities, emailMigrationEnabled, matchesAuthEmailDomain } from "../src/auth/config";
import { existingAccountIdentities, resolveAuthIdentity, resolveInviteIdentity } from "../src/auth/identity";
import { PublicApiImpl } from "../src/server";
import { isProfileAllowedByDomainSharingPolicy } from "../src/overseer";
import { isTeamPiCodexEligibleUser } from "../src/team-pi-codex-models";
import { makeTeamPiCodexFetch } from "../src/ai-models";
import { LoginConnectCallbackImpl } from "../src/auth/login-flow";
import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";

const migration = { AUTH_EMAIL_DOMAIN_ALIASES: { "heyodie.ai": "totango.com" } };
const policy = { type: "verified-sso-email-domain" as const, emailDomain: "totango.com" };
const password = new Uint8Array([7, 3, 1]);

function names() {
  const local = `migration-${crypto.randomUUID()}`;
  return { old: `${local}@totango.com`, next: `${local}@heyodie.ai` };
}

function publicApi(verifiedEmail?: string, enabled = true, admins: string[] = []) {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "exports", { value: {
    UserDurableObject: env.TEST_USER,
    OverseerDurableObject: env.TEST_OVERSEER,
    AdminSettings: env.TEST_ADMIN,
  } });
  const config = { ...env, AUTH_EMAIL_DOMAIN_ALIASES: enabled ? migration.AUTH_EMAIL_DOMAIN_ALIASES : undefined,
    ADMINS: admins } as Cloudflare.Env;
  return new PublicApiImpl(ctx, config, () => {}, verifiedEmail ? { email: verifiedEmail } : undefined);
}

describe("authorized email domain configuration", () => {
  it("is opt-in and accepts only the authorized exact pair", () => {
    expect(emailMigrationEnabled({})).toBe(false);
    expect(emailMigrationEnabled({ AUTH_EMAIL_DOMAIN_ALIASES: {} })).toBe(false);
    expect(emailMigrationEnabled({ AUTH_EMAIL_DOMAIN_ALIASES: JSON.stringify(migration.AUTH_EMAIL_DOMAIN_ALIASES) })).toBe(true);
    for (const aliases of [null, [], { "totango.com": "heyodie.ai" },
      { "heyodie.ai": "totango.com", "totango.com": "heyodie.ai" },
      { "evil.ai": "totango.com" }, { "HEYODIE.AI": "totango.com" }]) {
      expect(() => emailMigrationEnabled({ AUTH_EMAIL_DOMAIN_ALIASES: JSON.stringify(aliases) })).toThrow();
    }
  });

  it("preserves local parts and rejects suffix/subdomain/other-domain matches", () => {
    expect(accountEmailIdentities("Mixed+tag@heyodie.ai", migration))
      .toEqual(["Mixed+tag@totango.com", "Mixed+tag@heyodie.ai"]);
    expect(accountEmailIdentities("Mixed+tag@heyodie.ai", {})).toEqual(["Mixed+tag@heyodie.ai"]);
    for (const email of ["a@sub.heyodie.ai", "a@heyodie.ai.evil", "a@evil.ai", "a@b@heyodie.ai", "@heyodie.ai"]) {
      expect(matchesAuthEmailDomain(email, "totango.com", migration)).toBe(false);
    }
  });
});

describe("real user DO migration and capability boundaries", () => {
  it("the OAuth callback delivers a token for the resolved DO with the original verified email", async () => {
    const n = names();
    await env.TEST_USER.getByName(n.old).authenticateFromCfAccess(n.old, true);
    await env.TEST_USER.getByName(n.next).authenticateFromCfAccess(n.next, true);
    let delivered: string | undefined;
    let failure: string | undefined;
    const ctx = Object.assign(createExecutionContext(), { props: { pendingId: "test", vendorId: "google" } });
    Object.defineProperty(ctx, "exports", { value: {
      UserDurableObject: env.TEST_USER,
      PendingLogin: { idFromString: (id: string) => id,
        get: () => ({ deliver: async (token: string) => { delivered = token },
          fail: async (message: string) => { failure = message } }) },
    } });
    const callback = new LoginConnectCallbackImpl(ctx, { ...env, ...migration } as Cloudflare.Env);
    await callback.complete({ getAuthenticatedEmail: async () => n.next } as Fetcher<GatekeeperUser>);
    expect(failure).toBeUndefined();
    expect(delivered?.startsWith(`${n.old}:`)).toBe(true);
    const api = await publicApi().authenticate(delivered!);
    expect((await api.whoami()).id).toBe(n.old);
    expect(await env.TEST_USER.getByName(n.old).authenticate(delivered!.split(":")[1])).toBe(n.next);
    delivered = undefined;
    await callback.complete({ getAuthenticatedEmail: async () => null } as Fetcher<GatekeeperUser>);
    expect(delivered).toBeUndefined();
    expect(failure).toContain("no verified email");
  });

  it("resolves absent alias invites to old accounts and keeps explicit collision invitees", async () => {
    const n = names();
    await env.TEST_USER.getByName(n.old).authenticateFromCfAccess(n.old, true);
    expect(await resolveInviteIdentity(n.next, migration, env.TEST_USER)).toBe(n.old);
    expect(await resolveInviteIdentity(n.next, {}, env.TEST_USER)).toBe(n.next);
    await env.TEST_USER.getByName(n.next).authenticateFromCfAccess(n.next, true);
    expect(await resolveInviteIdentity(n.next, migration, env.TEST_USER)).toBe(n.next);
    expect(await resolveInviteIdentity(n.old, migration, env.TEST_USER)).toBe(n.old);
  });
  it("resolves old first, then new, then canonical creation without touching either profile", async () => {
    const n = names();
    expect(await resolveAuthIdentity(n.next, migration, env.TEST_USER)).toBe(n.old);
    expect(await env.TEST_USER.getByName(n.old).whoamiIfExists()).toBeNull();
    await env.TEST_USER.getByName(n.next).loginOrCreateViaGatekeeper(n.next, true);
    expect(await resolveAuthIdentity(n.old, migration, env.TEST_USER)).toBe(n.next);
    await env.TEST_USER.getByName(n.old).loginOrCreateViaGatekeeper(n.old, true);
    expect(await resolveAuthIdentity(n.next, migration, env.TEST_USER)).toBe(n.old);
    expect(await resolveAuthIdentity(n.next, {}, env.TEST_USER)).toBe(n.next);
  });

  it("preserves collision data, token routing, provenance, and exact admin principals", async () => {
    const n = names();
    const old = env.TEST_USER.getByName(n.old);
    const next = env.TEST_USER.getByName(n.next);
    const oldSecret = await old.loginOrCreateViaGatekeeper(n.old, true, n.next);
    const nextSecret = await next.loginOrCreateViaGatekeeper(n.next, true);
    await old.setOwnDisplayName("Legacy data");
    await next.setOwnDisplayName("Collision data");
    await old.setSimplifiedTechnicalEnglishEnabled(true);
    await next.setSimplifiedTechnicalEnglishEnabled(false);
    const api = publicApi(n.next, true, [n.old]);
    const original = await api.authenticate(`${n.old}:${oldSecret}`);
    const collisionToken = await api.authenticate(`${n.next}:${nextSecret}`);
    expect((await collisionToken.whoami()).id).toBe(n.next);
    expect((await original.listAccountIdentities()).map(p => p.id)).toEqual([n.old, n.next]);
    const switched = await original.switchAccountIdentity(n.next);
    expect(switched === original).toBe(false);
    expect(await switched.whoami()).toMatchObject({ id: n.next, name: "Collision data" });
    expect(await original.whoami()).toMatchObject({ id: n.old, name: "Legacy data" });
    expect(await original.getSimplifiedTechnicalEnglishEnabled()).toBe(true);
    expect(await switched.getSimplifiedTechnicalEnglishEnabled()).toBe(false);
    expect(await original.amIAdmin()).toBe(true);
    expect(await switched.amIAdmin()).toBe(false);
    const back = await switched.switchAccountIdentity(n.old);
    expect((await back.whoami()).id).toBe(n.old);
    const access = await api.authenticateFromCfAccess();
    expect((await access.whoami()).id).toBe(n.old);
    const unrelated = names().next;
    await env.TEST_USER.getByName(unrelated).authenticateFromCfAccess(unrelated, true);
    await expect(original.switchAccountIdentity(unrelated)).rejects.toThrow("fresh SSO");
    expect(await old.authenticate(oldSecret!)).toBe(n.next);
    await runInDurableObject(next, async user => {
      await expect(user.authenticate(oldSecret!)).rejects.toThrow();
    });
  });

  it("requires fresh SSO for password and pre-migration sessions, even email-shaped passwordless IDs", async () => {
    const n = names();
    const old = env.TEST_USER.getByName(n.old);
    const next = env.TEST_USER.getByName(n.next);
    const secret = await old.loginOrCreateViaGatekeeper(n.old, true);
    const passwordSecret = await next.createAccount(n.next, "Password", password);
    // Reproduce the persisted pre-migration session shape, without provenance.
    await runInDurableObject(old, async (_user, state) => {
      const tokenId = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.fromBase64(secret!))).toHex();
      state.storage.kv.put(`sessions:${tokenId}`, { tokenId, created: new Date() });
    });
    const api = publicApi();
    for (const token of [`${n.old}:${secret}`, `${n.next}:${passwordSecret}`]) {
      const authenticated = await api.authenticate(token);
      expect(await authenticated.whoami()).toBeTruthy();
      expect(await authenticated.listAccountIdentities()).toEqual([]);
      await expect(authenticated.switchAccountIdentity(n.old)).rejects.toThrow("fresh SSO");
    }
    expect(await existingAccountIdentities(undefined, migration, env.TEST_USER)).toEqual([]);
    const fresh = await old.loginOrCreateViaGatekeeper(n.old, false, n.next);
    const refreshed = await api.authenticate(`${n.old}:${fresh}`);
    expect(await refreshed.listAccountIdentities()).toHaveLength(2);
    const afterOptOut = await publicApi(undefined, false).authenticate(`${n.old}:${fresh}`);
    expect((await afterOptOut.whoami()).id).toBe(n.old);
    expect(await afterOptOut.listAccountIdentities()).toEqual([]);
    await expect(afterOptOut.switchAccountIdentity(n.next)).rejects.toThrow();
  });

  it("cannot cross domains with the opt-in disabled and never creates a switch target", async () => {
    const n = names();
    const old = env.TEST_USER.getByName(n.old);
    const secret = await old.loginOrCreateViaGatekeeper(n.old, true);
    const disabled = await publicApi(undefined, false).authenticate(`${n.old}:${secret}`);
    await expect(disabled.switchAccountIdentity(n.next)).rejects.toThrow();
    const enabled = await publicApi().authenticate(`${n.old}:${secret}`);
    await expect(enabled.switchAccountIdentity(n.next)).rejects.toThrow();
    expect(await env.TEST_USER.getByName(n.next).whoamiIfExists()).toBeNull();
    expect(await old.loginOrCreateViaGatekeeper(n.old, false, n.next)).toBeTruthy();
    expect(await env.TEST_USER.getByName(n.next).loginOrCreateViaGatekeeper(n.next, false)).toBeNull();
    await env.TEST_USER.getByName(n.next).authenticateFromCfAccess(n.next, true);
    await expect(disabled.switchAccountIdentity(n.next)).rejects.toThrow();
  });

  it("Access creates the stable legacy identity on first sign-in", async () => {
    const n = names();
    const api = await publicApi(n.next).authenticateFromCfAccess();
    expect((await api.whoami()).id).toBe(n.old);
    expect(await env.TEST_USER.getByName(n.next).whoamiIfExists()).toBeNull();
  });
});

describe("persisted domain policy and internal routes", () => {
  it("real alias accounts get the configured model catalog and feedback eligibility, never password accounts", async () => {
    const n = names();
    const next = env.TEST_USER.getByName(n.next);
    await next.authenticateFromCfAccess(n.next, true);
    await runInDurableObject(next, async user => {
      const originalEnv = Reflect.get(user, "env");
      Reflect.set(user, "env", { ...originalEnv, ...migration });
      try {
        expect((await user.listModels()).length).toBeGreaterThan(0);
        expect(await user.productFeedbackAvailable()).toBe(true);
      } finally {
        Reflect.set(user, "env", originalEnv);
      }
    });
    const passwordName = names().next;
    const passwordUser = env.TEST_USER.getByName(passwordName);
    await passwordUser.createAccount(passwordName, "Password", password);
    await runInDurableObject(passwordUser, async user => {
      const originalEnv = Reflect.get(user, "env");
      Reflect.set(user, "env", { ...originalEnv, ...migration });
      try {
        expect(await user.listModels()).toEqual([]);
        expect(await user.productFeedbackAvailable()).toBe(false);
      } finally {
        Reflect.set(user, "env", originalEnv);
      }
    });
  });
  it("accepts the configured alias consistently and retains password exclusion", async () => {
    expect(await isProfileAllowedByDomainSharingPolicy("a@heyodie.ai", async () => false, policy, migration)).toBe(true);
    expect(await isProfileAllowedByDomainSharingPolicy("a@heyodie.ai", async () => true, policy, migration)).toBe(false);
    expect(await isProfileAllowedByDomainSharingPolicy("a@heyodie.ai", async () => false, policy)).toBe(false);
    expect(await isProfileAllowedByDomainSharingPolicy("a@totango.com", async () => false, policy)).toBe(true);
    expect(policy.emailDomain).toBe("totango.com");
    expect(isTeamPiCodexEligibleUser("a@heyodie.ai", false, migration)).toBe(true);
    expect(isTeamPiCodexEligibleUser("a@heyodie.ai", true, migration)).toBe(false);
    expect(() => makeTeamPiCodexFetch({ type: "user", id: "a@heyodie.ai", name: "A" }, "test", undefined, {}, migration)).not.toThrow();
    expect(() => makeTeamPiCodexFetch({ type: "user", id: "a@heyodie.ai", name: "A" }, "test")).toThrow();
  });
});
