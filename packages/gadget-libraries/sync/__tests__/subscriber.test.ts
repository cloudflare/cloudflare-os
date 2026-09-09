// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createSubscriber } from "../src/subscriber.ts";

/** Stands in for Cap'n Web's class: the RPC layer exposes prototype methods of an instance, never own properties. */
// oxlint-disable-next-line typescript/no-extraneous-class -- empty on purpose: the real one is only a marker base class here.
class RpcTarget {}

describe("createSubscriber", () => {
  it("builds an RpcTarget whose prototype carries each callback", () => {
    const events: unknown[] = [];
    const subscriber = createSubscriber(RpcTarget, {
      operation(event: { revision: number }) {
        events.push(event);
      },
      presence(event: { clientId: string }) {
        events.push(event);
      },
    });
    expect(subscriber).toBeInstanceOf(RpcTarget);
    expect(Object.keys(subscriber)).toEqual([]);
    expect(Object.hasOwn(subscriber, "operation")).toBe(false);
    expect(typeof Object.getPrototypeOf(subscriber).operation).toBe("function");
    subscriber.operation({ revision: 1 });
    subscriber.presence({ clientId: "ada" });
    expect(events).toEqual([{ revision: 1 }, { clientId: "ada" }]);
  });

  it("refuses a callback that is not a function", () => {
    expect(() => createSubscriber(RpcTarget, { operation: 1 as unknown as () => void })).toThrow('Subscriber callback "operation" is not a function.');
  });
});
