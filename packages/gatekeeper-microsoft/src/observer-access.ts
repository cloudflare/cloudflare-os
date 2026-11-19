// verifyObserverAccess() for every Microsoft 365 binding: which collaborators may see what its reads
// reported (subresources.ts). Every ID names its tenant, explicitly or as the one the deployment
// fixes, and a collaborator must be in it and see the resource. Their own UserAccount answers for
// whatever they can see as themselves (UserAccount.checkSubresourceAccess), reusing its answer for
// each ID; the owner's side answers for the owner's own calendars, from their sharing lists
// (calendar-acl.ts).

import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { seesCalendar, type OwnerAcl } from "./calendar-observers";
import type { MicrosoftVerifierApi, StoredIdentity } from "./microsoft-credentials";
import { parseBindingSubresources, type BindingResource } from "./subresources";

/**
 * The binding asking: what its reads name, whose it is, whether the deployment fixes the owner's
 * tenant (so that IDs leave it implicit), and for Calendar, the owner's sharing lists.
 */
export type ObserverAccessBinding = {
  resource: BindingResource;
  owner(): Promise<StoredIdentity>;
  fixesTenant: boolean;
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
  const owner = await binding.owner();
  // Parsed before any observer is asked, so an ID this binding never reports fails the whole call.
  const parsed = parseBindingSubresources(subresources, { resource: binding.resource, tenantId: owner.tenantId, fixesTenant: binding.fixesTenant });
  // A calendar's events are decided by its owner's side; everything else by each observer's account.
  const ownerSide = parsed.flatMap((resource, index) =>
    resource.kind === "calendar" && resource.unit.kind === "calendar" ? [{ index, unit: resource.unit }] : []);
  const decided = new Set(ownerSide.map(({ index }) => index));
  const verify = observerAccessVerifier({
    hasCollectionAccess: async (verifier: Fetcher<MicrosoftVerifierApi>, ids: readonly string[]) => {
      const asked = ids.filter((_, index) => !decided.has(index));
      const answers = asked.length > 0 ? await verifier.checkSubresourceAccess(asked) : [];
      if (answers.length !== asked.length) {
        throw new Error("An access check answered for a different number of subresources than it was asked about.");
      }
      let next = 0;
      const verdicts = ids.map((_, index) => !decided.has(index) && answers[next++] === true);
      if (ownerSide.length > 0 && binding.acl !== undefined) {
        const observer = await verifier.verifiedIdentity();
        // The calendars are the owner's tenant's, as parsing confirmed: nobody outside it sees them.
        if (observer !== null && observer.tenantId.toLowerCase() === owner.tenantId.toLowerCase()) {
          for (const { index, unit } of ownerSide) verdicts[index] = await seesCalendar(unit, observer, owner, binding.acl);
        }
      }
      return verdicts;
    },
  });
  return await verify(observers, subresources);
}
