// verifyObserverAccess as every binding answers it: which collaborators may see what its reads
// reported, each observer's own account answering for what they can see themselves and the owner's
// sharing lists for the owner's own calendars.

import { describe, expect, it } from "vitest";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { sharingRole } from "../src/calendar-scope";
import type { StoredIdentity, VerifiedIdentity } from "../src/microsoft-credentials";
import { verifyMicrosoftObserverAccess, type ObserverAccessBinding } from "../src/observer-access";
import { calendarSubresourceId, qualifiedSubresourceId } from "../src/subresources";

const TENANT = "aaaaaaaa-0000-0000-0000-00000000000a";
const OTHER_TENANT = "bbbbbbbb-0000-0000-0000-00000000000b";
const OWNER: StoredIdentity = { tenantId: TENANT, objectId: "aaaaaaaa-0000-0000-0000-000000000001", name: "Phillip", fetchedAt: 0 };
const SARAH: VerifiedIdentity = { tenantId: TENANT, objectId: "aaaaaaaa-0000-0000-0000-000000000002", email: "sarah@contoso.com" };
const CALENDAR = "AAMkCal=";
const events = (level: "freeBusy" | "full", ownerId = OWNER.objectId) => calendarSubresourceId({ kind: "calendar", ownerId, calendarId: CALENDAR, level });
const availability = calendarSubresourceId({ kind: "availability", address: "bob@contoso.com" });

/** An observer whose account answers `allowed` for what it can see itself, recording what it was asked. */
function observer(id: string, identity: VerifiedIdentity | null, allowed: (subresource: string) => boolean) {
  const asked: string[][] = [];
  const verifier = {
    checkSubresourceAccess: async (subresources: string[]) => { asked.push(subresources); return subresources.map(allowed); },
    verifiedIdentity: async () => identity,
  } as unknown as Fetcher<GatekeeperUserVerifier>;
  return { entry: { id, verifier }, asked };
}

const calendarBinding = (role: string, fixesTenant = true): ObserverAccessBinding => ({
  resource: "calendar", owner: async () => OWNER, fixesTenant, acl: { roleOf: async () => sharingRole(role) },
});

describe("verifyMicrosoftObserverAccess", () => {
  it("asks each observer's own account about every ID it can see itself, as reported", async () => {
    const sarah = observer("sarah", SARAH, () => true);
    const qualified = qualifiedSubresourceId(availability, TENANT);
    expect((await verifyMicrosoftObserverAccess([sarah.entry], [qualified], calendarBinding("none", false))).allowedObserverIds).toEqual(["sarah"]);
    expect(sarah.asked).toEqual([[qualified]]);
  });

  it("decides the owner's own calendar by the role its sharing list gives the observer, at the detail a read showed", async () => {
    const sarah = observer("sarah", SARAH, () => true);
    expect((await verifyMicrosoftObserverAccess([sarah.entry], [events("freeBusy")], calendarBinding("freeBusyRead"))).allowedObserverIds).toEqual(["sarah"]);
    expect((await verifyMicrosoftObserverAccess([sarah.entry], [events("full")], calendarBinding("freeBusyRead"))).allowedObserverIds).toEqual([]);
    // Sarah's account wasn't asked: the calendar is the owner's to decide.
    expect(sarah.asked).toEqual([]);
  });

  it("passes only its owner on someone else's calendar, whose sharing list the binding can't read", async () => {
    const sarah = observer("sarah", SARAH, () => true);
    const bob = observer("bob", { tenantId: TENANT, objectId: "aaaaaaaa-0000-0000-0000-000000000003" }, () => true);
    const sarahs = events("full", SARAH.objectId);
    const result = await verifyMicrosoftObserverAccess([sarah.entry, bob.entry], [sarahs], calendarBinding("delegateWithPrivateEventAccess"));
    expect(result.allowedObserverIds).toEqual(["sarah"]);
  });

  it("shows an observer outside the owner's tenant none of the owner's calendars, without deciding any", async () => {
    let decided = false;
    const binding: ObserverAccessBinding = { ...calendarBinding("read"), acl: { roleOf: async () => { decided = true; return "read"; } } };
    const outsider = observer("outsider", { ...SARAH, tenantId: OTHER_TENANT }, () => true);
    expect((await verifyMicrosoftObserverAccess([outsider.entry], [events("full")], binding)).allowedObserverIds).toEqual([]);
    expect(decided).toBe(false);
  });

  it("denies everyone in the call when an account answers for a different number of subresources", async () => {
    const broken = observer("broken", SARAH, () => true);
    const verifier = { checkSubresourceAccess: async () => [], verifiedIdentity: async () => SARAH } as unknown as Fetcher<GatekeeperUserVerifier>;
    await expect(verifyMicrosoftObserverAccess([broken.entry, { id: "short", verifier }], [availability], calendarBinding("none")))
      .rejects.toThrow(/different number of subresources/);
  });

  it("refuses an ID the binding never reports before asking anyone: another resource's, or another tenant's", async () => {
    const sarah = observer("sarah", SARAH, () => true);
    for (const id of [`outlook/user/${OWNER.objectId}`, qualifiedSubresourceId(availability, OTHER_TENANT)]) {
      await expect(verifyMicrosoftObserverAccess([sarah.entry], [id], calendarBinding("read", false)))
        .rejects.toThrow(/Not a subresource ID this Microsoft 365 binding reports/);
    }
    // Where the deployment admits several tenants, an ID leaving its tenant out names no resource.
    await expect(verifyMicrosoftObserverAccess([sarah.entry], [availability], calendarBinding("read", false)))
      .rejects.toThrow(/Not a subresource ID this Microsoft 365 binding reports/);
    expect(sarah.asked).toEqual([]);
  });
});
