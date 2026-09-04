// A rejected creation's gatekeeper is retained only to explain its dead binding, so it must not
// stay an observer requirement: a build collaborator without an account of that vendor would be
// locked out of the workspace by a resource the user declined.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// observer-exclude-scope.test.ts).

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// The slice of OverseerImpl this test touches; records go in as plain literals.
type TestImpl = {
  storage: {
    gatekeepers: { put(record: unknown): void };
    actions: { put(record: unknown): void };
  };
  listObserverRequirements(role: "build" | "use"): Array<{ gatekeeperId: number }>;
};

const GATEKEEPER_ID = 1;
const CREATION_ACTION_ID = 42;

let doCounter = 0;

async function withImpl(fn: (impl: TestImpl) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`rejected-creation-scope-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // Private member access: tests in this suite reach the impl behind the DO facade.
    await fn((instance as unknown as { impl: TestImpl }).impl);
  });
}

// A createExternalResource mint whose creation action is in the given state.
function putCreation(impl: TestImpl, state: "pending" | "rejected"): void {
  impl.storage.gatekeepers.put({
    id: GATEKEEPER_ID,
    resourceTitle: "Provisional Doc",
    class: {},
    creationSpec: {
      type: "gatekeeper",
      vendorId: "testvendor",
      resourceUrl: "https://example.com/provisional-1",
      typeUrlPattern: "https://*",
    },
    creation: { chatId: 1, bindingName: "DOC", actionId: CREATION_ACTION_ID },
  });
  impl.storage.actions.put({
    id: CREATION_ACTION_ID,
    gatekeeperId: GATEKEEPER_ID,
    type: "action",
    state,
    caller: { from: "agent", chatId: 1 },
    resourceTitle: "Provisional Doc",
    createdAt: new Date(0),
    action: {},
    description: { title: "Create", description: "Create it", implementsRevert: false },
  });
}

describe("rejected creations and observer verification scope", () => {
  it("a pending creation is a build-scope requirement; a rejected one is not",
      () => withImpl(async impl => {
    putCreation(impl, "pending");
    expect(impl.listObserverRequirements("build")).toEqual([
      expect.objectContaining({ gatekeeperId: GATEKEEPER_ID }),
    ]);

    putCreation(impl, "rejected");
    expect(impl.listObserverRequirements("build")).toEqual([]);
  }));
});
