// verifyObserverAccess as every binding answers it: which collaborators may see what its reads
// reported, each observer's own account answering for what they can see themselves and the owner's
// sharing lists for the owner's own calendars.

import { describe, expect, it } from "vitest";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { sharingRole } from "../src/calendar-scope";
import type { StoredIdentity, VerifiedIdentity } from "../src/microsoft-credentials";
import { verifyMicrosoftObserverAccess, type ObserverAccessBinding } from "../src/observer-access";
import { calendarSubresourceId, tenantSubresourceId } from "../src/subresources";

const TENANT = "aaaaaaaa-0000-0000-0000-00000000000a";
const OWNER: StoredIdentity = { tenantId: TENANT, objectId: "aaaaaaaa-0000-0000-0000-000000000001", name: "Phillip", fetchedAt: 0 };
const SARAH: VerifiedIdentity = { tenantId: TENANT, objectId: "aaaaaaaa-0000-0000-0000-000000000002", email: "sarah@contoso.com" };
const CALENDAR = "AAMkCal=";
const tenant = tenantSubresourceId(TENANT);
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

const calendarBinding = (role: string): ObserverAccessBinding => ({
  resource: "calendar", owner: async () => OWNER, acl: { roleOf: async () => sharingRole(role) },
});

describe("verifyMicrosoftObserverAccess", () => {
  it("asks each observer's own account about the owner's tenant with everything it can see itself", async () => {
    const sarah = observer("sarah", SARAH, () => true);
    const result = await verifyMicrosoftObserverAccess([sarah.entry], [availability], calendarBinding("none"));
    expect(result.allowedObserverIds).toEqual(["sarah"]);
    expect(sarah.asked).toEqual([[tenant, availability]]);
  });

  it("decides the owner's own calendar by the role its sharing list gives the observer, at the detail a read showed", async () => {
    const sarah = observer("sarah", SARAH, () => true);
    expect((await verifyMicrosoftObserverAccess([sarah.entry], [events("freeBusy")], calendarBinding("freeBusyRead"))).allowedObserverIds).toEqual(["sarah"]);
    expect((await verifyMicrosoftObserverAccess([sarah.entry], [events("full")], calendarBinding("freeBusyRead"))).allowedObserverIds).toEqual([]);
    // Only the tenant was asked of Sarah's account: the calendar is the owner's to decide.
    expect(sarah.asked.every(asked => asked.length === 1 && asked[0] === tenant)).toBe(true);
  });

  it("passes only its owner on someone else's calendar, whose sharing list the binding can't read", async () => {
    const sarah = observer("sarah", SARAH, () => true);
    const bob = observer("bob", { tenantId: TENANT, objectId: "aaaaaaaa-0000-0000-0000-000000000003" }, () => true);
    const sarahs = events("full", SARAH.objectId);
    const result = await verifyMicrosoftObserverAccess([sarah.entry, bob.entry], [sarahs], calendarBinding("delegateWithPrivateEventAccess"));
    expect(result.allowedObserverIds).toEqual(["sarah"]);
  });

  it("shows an observer outside the owner's tenant nothing, without deciding any calendar", async () => {
    let decided = false;
    const binding: ObserverAccessBinding = { ...calendarBinding("read"), acl: { roleOf: async () => { decided = true; return "read"; } } };
    const outsider = observer("outsider", { ...SARAH, tenantId: "bbbbbbbb-0000-0000-0000-00000000000b" }, subresource => subresource !== tenant);
    expect((await verifyMicrosoftObserverAccess([outsider.entry], [events("full"), availability], binding)).allowedObserverIds).toEqual([]);
    expect(decided).toBe(false);
  });

  it("denies everyone in the call when an account answers for a different number of subresources", async () => {
    const broken = observer("broken", SARAH, () => true);
    const verifier = { checkSubresourceAccess: async () => [true], verifiedIdentity: async () => SARAH } as unknown as Fetcher<GatekeeperUserVerifier>;
    await expect(verifyMicrosoftObserverAccess([broken.entry, { id: "short", verifier }], [availability], calendarBinding("none")))
      .rejects.toThrow(/different number of subresources/);
  });

  it("refuses an ID the binding never reports before asking anyone", async () => {
    const sarah = observer("sarah", SARAH, () => true);
    await expect(verifyMicrosoftObserverAccess([sarah.entry], [`outlook/user/${OWNER.objectId}`], calendarBinding("read")))
      .rejects.toThrow(/Not a subresource ID this Microsoft 365 binding reports/);
    expect(sarah.asked).toEqual([]);
  });
});
