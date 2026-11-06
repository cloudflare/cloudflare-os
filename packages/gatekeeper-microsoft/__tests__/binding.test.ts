// What every Microsoft 365 read reports: the subresources it revealed, in the binding's tenant.

import { describe, expect, it } from "vitest";
import type { ObservationGate, ObservationInput, ObservationScope } from "@gadgets/gatekeeper-kit/observers";
import { authorizeRead } from "../src/binding";
import type { StoredIdentity } from "../src/microsoft-credentials";
import { outlookSubresourceId } from "../src/subresources";

const OWNER: StoredIdentity = { tenantId: "AAAAAAAA-0000-0000-0000-00000000000A", objectId: "aaaaaaaa-0000-0000-0000-000000000001", name: "Phillip", fetchedAt: 0 };
const TENANT = OWNER.tenantId.toLowerCase();
const message = outlookSubresourceId({ kind: "mail", userId: OWNER.objectId, messageId: "AAMk1=" });

/** The subresources one read through a binding reports. */
async function reported(revealed: string[], fixesTenant: boolean): Promise<readonly string[]> {
  let scope: ObservationScope | undefined;
  const gate = { authorize: async (_input: ObservationInput, given: ObservationScope) => { scope = given; } } as unknown as ObservationGate;
  await authorizeRead(gate, { owner: async () => OWNER, fixesTenant }, { title: "Read", description: "Read." }, revealed);
  if (scope?.kind !== "subresources") throw new Error("the read reported no subresources");
  return scope.ids;
}

describe("authorizeRead", () => {
  it("names the binding's tenant in every ID where the deployment admits several", async () => {
    expect(await reported([message], false)).toEqual([`outlook/tenant/${TENANT}/user/${OWNER.objectId}/message/AAMk1%3D`]);
  });

  it("leaves a tenant the deployment fixes implicit", async () => {
    expect(await reported([message], true)).toEqual([message]);
  });

  it("names the owner's tenant for a read that revealed nothing narrower, either way", async () => {
    expect(await reported([], true)).toEqual([`tenant/${TENANT}`]);
    expect(await reported([], false)).toEqual([`tenant/${TENANT}`]);
  });
});
