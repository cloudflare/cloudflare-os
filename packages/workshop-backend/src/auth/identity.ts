import type { UserDurableObject } from "../user";
import { accountEmailIdentities } from "./config";

/** Resolve verified SSO to an existing legacy account, then an existing alias, then legacy creation. */
export async function resolveAuthIdentity(email: string,
    env: Pick<Cloudflare.Env, "AUTH_EMAIL_DOMAIN_ALIASES">,
    users: DurableObjectNamespace<UserDurableObject>): Promise<string> {
  const identities = accountEmailIdentities(email, env);
  for (const identity of identities) {
    if (await users.getByName(identity).whoamiIfExists()) return identity;
  }
  return identities[0];
}

/** Preserve explicitly named existing invitees; resolve only absent aliases to a legacy account. */
export async function resolveInviteIdentity(email: string,
    env: Pick<Cloudflare.Env, "AUTH_EMAIL_DOMAIN_ALIASES">,
    users: DurableObjectNamespace<UserDurableObject>): Promise<string> {
  if (await users.getByName(email).whoamiIfExists()) return email;
  return resolveAuthIdentity(email, env, users);
}

/** Enumerate only existing identities authorized by verified sign-in provenance. */
export async function existingAccountIdentities(verifiedEmail: string | undefined,
    env: Pick<Cloudflare.Env, "AUTH_EMAIL_DOMAIN_ALIASES">,
    users: DurableObjectNamespace<UserDurableObject>) {
  if (!verifiedEmail) return [];
  const profiles = await Promise.all(accountEmailIdentities(verifiedEmail, env)
      .map(identity => users.getByName(identity).whoamiIfExists()));
  return profiles.filter(profile => profile !== null);
}
