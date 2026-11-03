// Who may observe what a ZoomInfo binding read. Every read reports the ZoomInfo user whose token
// returned its data as the subresource `user/<userId>`, and no collaborator may read one, not even a
// collaborator connected as that same ZoomInfo user. ZoomInfo is faked at `fetch`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ALICE, FakeZoomInfo, failure, hooks, seedAccount, unwrap } from "./fake-zoominfo";
import type { GatekeeperProps, Step } from "./worker";

const ALICE_ID = "user/00u1alice";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A binding to a connection as Alice, its queue's log, and a way to read through it. */
async function aliceBinding(fake: FakeZoomInfo) {
  const props: GatekeeperProps = { userObjectId: await seedAccount(fake, ALICE) };
  const name = crypto.randomUUID();
  return {
    name,
    props,
    run: (step: Step) => hooks().run(name, props, step),
    observations: async () => (await hooks().queueLog(name)).observations,
  };
}

describe("reads", () => {
  // Every read the session offers, each answered with nothing but the company search and usage.
  const reads: Step[] = [
    ["lookup", "industries"],
    ["lookupEnrichFields", "company", "output"],
    ["searchCompanies", {}],
    ["searchContacts", {}],
    ["searchIntent", { topics: ["Cloud Security"] }],
    ["searchScoops", {}],
    ["searchNews", {}],
    ["findSimilarCompanies", { companyId: "7" }],
    ["findContactLookalikes", { referencePersonId: "11" }],
    ["getContactRecommendations", { useCaseType: "PROSPECTING", companyId: "7" }],
    ["getAccountSummary", "7"],
    ["askAccountSummary", "7", "Who are their competitors?"],
    ["getCompanyInsights", { companyIds: ["7"] }],
    ["getCreditUsage"],
  ];

  it.each(reads)("%s reports the connection's ZoomInfo user, found something or not", async (...step) => {
    const fake = new FakeZoomInfo().install();
    const zoominfo = await aliceBinding(fake);
    unwrap(await zoominfo.run(step));
    expect((await zoominfo.observations()).map(observation => observation.subresources)).toEqual([[ALICE_ID]]);
  });

  it("reports a cache hit as the user it was fetched as, reading nothing from ZoomInfo", async () => {
    const fake = new FakeZoomInfo().install();
    const zoominfo = await aliceBinding(fake);
    const fetched = unwrap(await zoominfo.run(["lookup", "industries"]));
    const lookups = fake.count(/^GET \/gtm\/data\/v1\/lookup\//);
    expect(unwrap(await zoominfo.run(["lookup", "industries"]))).toEqual(fetched);
    expect(fake.count(/^GET \/gtm\/data\/v1\/lookup\//)).toBe(lookups);
    expect((await zoominfo.observations()).map(({ description, subresources }) => [description, subresources]))
      .toEqual([
        ["Resolved 1 value(s) for the `industries` taxonomy.", [ALICE_ID]],
        ["Resolved 1 value(s) for the `industries` taxonomy (cached).", [ALICE_ID]],
      ]);
  });

  it("returns nothing when its observation is refused", async () => {
    const fake = new FakeZoomInfo().install();
    const zoominfo = await aliceBinding(fake);
    await hooks().refuseObservations(zoominfo.name, true);
    expect(failure(await zoominfo.run(["searchCompanies", {}]))).toMatch(/refused this observation/);
    expect((await zoominfo.observations()).map(observation => observation.subresources)).toEqual([[ALICE_ID]]);
  });
});

describe("verifyObserverAccess", () => {
  it("allows no collaborator, one connected as the same ZoomInfo user included", async () => {
    const fake = new FakeZoomInfo().install();
    const zoominfo = await aliceBinding(fake);
    const observers = [
      { id: "alice-elsewhere", userObjectId: await seedAccount(fake, ALICE) },
      { id: "colleague", userObjectId: await seedAccount(fake, { sub: "00u3carol", name: "Carol", email: "carol@example.com" }) },
    ];
    expect(unwrap(await hooks().verifyObserverAccess(zoominfo.name, zoominfo.props, observers, [ALICE_ID])))
      .toEqual({ allowedObserverIds: [] });
  });

  it.each([
    "user/00u1alice/company/7",
    "zoominfo/user/00u1alice",
    "company/7",
    "user/00u1%61lice",
    "user/",
    "",
  ])("refuses the whole call for %j, which names no ZoomInfo user", async id => {
    const fake = new FakeZoomInfo().install();
    const zoominfo = await aliceBinding(fake);
    const observers = [{ id: "alice-elsewhere", userObjectId: await seedAccount(fake, ALICE) }];
    expect(failure(await hooks().verifyObserverAccess(zoominfo.name, zoominfo.props, observers, [ALICE_ID, id])))
      .toMatch(/subresource ID/);
  });
});

describe("addObserver", () => {
  it("still refuses every observer, so what was read before reads reported their user stays private", async () => {
    const fake = new FakeZoomInfo().install();
    const zoominfo = await aliceBinding(fake);
    unwrap(await zoominfo.run(["searchCompanies", {}]));
    const aliceElsewhere = await seedAccount(fake, ALICE);
    expect(failure(await hooks().addObserver(zoominfo.name, zoominfo.props, "alice-elsewhere", aliceElsewhere)))
      .toMatch(/may only be observed by its owner/);
  });
});
