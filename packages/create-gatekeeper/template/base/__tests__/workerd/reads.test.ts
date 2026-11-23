// What a read returns and reports, through a binding's session as a gadget holds it.

import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { failure, unwrap } from "@gadgets/gatekeeper-kit/test-support";
import { itemUrl } from "../../src/acme-urls";
import { connected, fakeAcme } from "./fake-acme";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A binding to the provider's one item on a facet of its own, as a facet keeps its storage. */
async function binding() {
  const requests = fakeAcme([{ id: "item1", title: "First", updated_at: "2026-01-01T00:00:00Z" }]);
  const host = env.TEST_HOST.get(env.TEST_HOST.idFromName("host"));
  return { requests, host, facet: crypto.randomUUID(), props: { userObjectId: await connected(), itemId: "item1" } };
}

it("reads the binding's item as the connected user, and reports it", async () => {
  const { requests, host, facet, props } = await binding();

  expect(unwrap(await host.run(facet, props, [["get"]])))
    .toEqual({ id: "item1", title: "First", updatedAt: "2026-01-01T00:00:00Z", url: itemUrl("item1") });
  // Spelled out, not asked of the helper the read names it with.
  expect((await host.queueLog(facet)).observations.map(({ subresources }) => subresources))
    .toEqual([["item/item1"]]);
  expect(requests).toEqual(["GET /items/item1"]);
});

// The log above shows the read was reported, not that it waited to be allowed.
it("returns nothing of an item whose read is refused", async () => {
  const { host, facet, props } = await binding();
  await host.refuseObservations(facet, true);

  expect(failure(await host.run(facet, props, [["get"]]))).toMatch(/refused this observation/);
});
