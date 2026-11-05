// verifyObserverAccess() for every Microsoft 365 binding: which collaborators may see what its reads
// reported (subresources.ts). A collaborator must be in the owner's tenant, which a binding is
// pinned to, and see every subresource. Their own UserAccount answers for whatever they can see as
// themselves (UserAccount.checkSubresourceAccess), reusing recent answers; the owner's side answers
// for the owner's own calendars, from their sharing lists (calendar-acl.ts).

import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { seesCalendar, type OwnerAcl } from "./calendar-observers";
import type { MicrosoftVerifierApi, StoredIdentity } from "./microsoft-credentials";
import { parseBindingSubresources, tenantSubresourceId, type BindingResource } from "./subresources";

/** The binding asking: what its reads name, whose it is, and for Calendar, its owner's sharing lists. */
export type ObserverAccessBinding = {
  resource: BindingResource;
  owner(): Promise<StoredIdentity>;
  acl?: OwnerAcl;
};

/**
 * Which of `observers` can see every one of `subresources`, as `binding`'s
 * `Gatekeeper.verifyObserverAccess()` answers. Throws for an ID the binding never reports, and when
 * access can't be determined, which denies everyone in the call.
 */
export async function verifyMicrosoftObserverAccess(
  observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
  subresources: string[],
  binding: ObserverAccessBinding,
): Promise<{ allowedObserverIds: string[] }> {
  // Parsed before anything is asked, so an ID this binding never reports fails the whole call.
  const parsed = parseBindingSubresources(subresources, binding.resource);
  const owner = await binding.owner();
  const tenant = tenantSubresourceId(owner.tenantId);
  // A calendar's events are decided by its owner's side; the rest by each observer's own account.
  const ownerSide = parsed.flatMap((resource, index) =>
    resource.kind === "calendar" && resource.unit.kind === "calendar" ? [{ index, unit: resource.unit }] : []);
  const verify = observerAccessVerifier({
    hasCollectionAccess: async (verifier: Fetcher<MicrosoftVerifierApi>, ids: readonly string[]) => {
      const decided = new Set(ownerSide.map(({ index }) => index));
      const asked = [tenant, ...ids.filter((_, index) => !decided.has(index))];
      const answers = await verifier.checkSubresourceAccess(asked);
      if (answers.length !== asked.length) {
        throw new Error("An access check answered for a different number of subresources than it was asked about.");
      }
      // Outside the owner's tenant, nothing the binding read may be shown.
      if (answers[0] !== true) return ids.map(() => false);
      let next = 1;
      const verdicts = ids.map((_, index) => !decided.has(index) && answers[next++] === true);
      if (ownerSide.length > 0 && binding.acl !== undefined) {
        const observer = await verifier.verifiedIdentity();
        if (observer !== null) {
          for (const { index, unit } of ownerSide) verdicts[index] = await seesCalendar(unit, observer, owner, binding.acl);
        }
      }
      return verdicts;
    },
  });
  return await verify(observers, subresources);
}
