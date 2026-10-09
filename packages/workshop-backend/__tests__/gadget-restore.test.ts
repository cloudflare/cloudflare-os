// A gadget can only call its own `ctx.restore()` -- the way it mints persistent callbacks for
// spawned agents and hooks -- if the request reached its facet through a stub the overseer minted
// with *its* `ctx.restore()`; that stub is what tells the runtime how to recreate the facet. So
// every stub the overseer hands out for a gadget facet (getGadgetFacet, behind the client's
// connectToGadget and every binding loopback) must come from there, never from a bare
// `ctx.facets.get()`.
//
// Runs a real gadget, loaded from a real commit, inside a real OverseerDurableObject.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const GADGET_ID = 1;

// A gadget whose method mints a persistent callback from inside the gadget itself.
const SERVER_JS = `
import { DurableObject, RpcTarget, restore } from "cloudflare:workers";

export class Gadget extends DurableObject {
  hello() {
    return "hi";
  }

  mintCallback(tag) {
    return this.ctx.restore({ type: "callback", tag });
  }

  [restore](params) {
    if (params.type !== "callback") throw new TypeError("unknown restore type");
    return new Callback(params.tag);
  }
}

class Callback extends RpcTarget {
  constructor(tag) {
    super();
    this.tag = tag;
  }
  ping() {
    return "pong:" + this.tag;
  }
}
`;

let doCounter = 0;

async function withGadget(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`gadget-restore-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let commitId = await impl.gitStore.writeFilesAsCommit(new Map([["server.js", SERVER_JS]]), {
      parents: [],
      author: { name: "Alice", email: "alice@example.com" },
      message: "test commit",
      timestamp: new Date(1700000000_000),
    });
    impl.storage.gadgets.put({
      type: "gadget", id: GADGET_ID, title: "G", created: new Date(0), bindingName: "G",
      bindings: {}, commitId,
    });
    await fn(impl);
  });
}

describe("gadget ctx.restore()", () => {
  it("works through the stub getGadgetFacet hands out, and the result survives storage",
      () => withGadget(async impl => {
    using gadget = await impl.getGadgetFacet(GADGET_ID);
    using callback = await gadget.mintCallback("a");
    expect(await callback.ping()).toBe("pong:a");

    // The stub is persistent: written to storage and read back, it restores through the
    // overseer's [restore]() to the gadget facet and then through the gadget's own.
    await impl.ctx.storage.put("callback", callback);
    using restored = await impl.ctx.storage.get("callback");
    expect(await restored.ping()).toBe("pong:a");
  }));

  it("is refused through a bare facet stub (what the fix guards against)",
      () => withGadget(async impl => {
    // Start the facet the supported way, then reach the same running facet directly.
    using gadget = await impl.getGadgetFacet(GADGET_ID);
    using callback = await gadget.mintCallback("a");
    expect(await callback.ping()).toBe("pong:a");

    let bare = impl.ctx.facets.get(impl.gadgetFacetName(GADGET_ID), () => {
      throw new Error("facet should already be running");
    });
    expect(await bare.hello()).toBe("hi");
    // The gadget's ctx.restore() throws "cannot be used in this context because the system does
    // not know how to restore this context itself" (visible in the gadget's own log); the message
    // that reaches the caller is currently garbled by the runtime, so only the rejection is
    // asserted.
    await expect(bare.mintCallback("b")).rejects.toThrow();
  }));
});
