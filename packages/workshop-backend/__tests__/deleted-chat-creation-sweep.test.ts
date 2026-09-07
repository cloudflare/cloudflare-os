// deleteChat settles an undecided creation only when nothing else binds it: a surviving gadget
// edge (merged, or another chat's — the deleted chat's own pending edges are severed first)
// keeps the card approvable, so the sweep must leave the record alone. The unbound case is
// pinned end-to-end by the integration suite ("settles an undecided creation when its chat is
// deleted").
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// observer-rejected-creation-scope.test.ts).

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const CHAT_ID = 9;
const GATEKEEPER_ID = 1;
const CREATION_ACTION_ID = 42;

// The slice of OverseerImpl this test touches; records go in as plain literals.
type TestImpl = {
  storage: {
    gatekeepers: { get(id: number): unknown; put(record: unknown): void };
    actions: { get(id: number): { state: string } | undefined; put(record: unknown): void };
    gadgets: { put(record: unknown): void };
  };
  removeChatWorkpieces(chatId: number): Promise<void>;
};

async function withImpl(fn: (impl: TestImpl) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`deleted-chat-creation-sweep-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // Private member access: tests in this suite reach the impl behind the DO facade.
    await fn((instance as unknown as { impl: TestImpl }).impl);
  });
}

describe("chat deletion and undecided creations", () => {
  it("spares a creation a surviving gadget edge still binds", () => withImpl(async impl => {
    impl.storage.gatekeepers.put({
      id: GATEKEEPER_ID,
      resourceTitle: "Provisional Doc",
      class: {},
      provisional: true,
      creationSpec: {
        type: "gatekeeper",
        vendorId: "testvendor",
        resourceUrl: "https://example.com/provisional-1",
        typeUrlPattern: "https://*",
      },
      creation: { chatId: CHAT_ID, bindingName: "DOC", actionId: CREATION_ACTION_ID },
    });
    impl.storage.actions.put({
      id: CREATION_ACTION_ID,
      gatekeeperId: GATEKEEPER_ID,
      type: "action",
      state: "pending",
      caller: { from: "agent", chatId: CHAT_ID },
      resourceTitle: "Provisional Doc",
      createdAt: new Date(0),
      action: {},
      description: { title: "Create", description: "Create it", implementsRevert: false },
    });
    // A permanent (merged) edge from another chat's gadget.
    impl.storage.gadgets.put({
      type: "gadget", id: 100, title: "G", created: new Date(0), bindingName: "G",
      bindings: { DOC: { target: GATEKEEPER_ID } },
    });

    await impl.removeChatWorkpieces(CHAT_ID);

    expect(impl.storage.gatekeepers.get(GATEKEEPER_ID)).toBeDefined();
    expect(impl.storage.actions.get(CREATION_ACTION_ID)?.state).toBe("pending");
  }));
});
