import { describe, expect, it } from "vitest";
import type { ObserverKv } from "@gadgets/gatekeeper-kit/observers";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import {
  CONTEXT_OBSERVER_DENIED, contextObserverStrategy,
} from "../src/context-observers.js";

function makeKv(): ObserverKv & { map: Map<string, unknown> } {
  let map = new Map<string, unknown>();
  return {
    map,
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, value),
    delete: (key: string) => map.delete(key),
    list: <T>({ prefix }: { prefix?: string } = {}) =>
      [...map.entries()].filter(([key]) => key.startsWith(prefix ?? "")) as Iterable<[string, T]>,
  } as ObserverKv & { map: Map<string, unknown> };
}

function verifier(allowed: string[]) {
  let calls: Array<{ sharingDomain: string; collectionIds: string[] }> = [];
  let user = {
    async hasCollectionsAccess(sharingDomain: string, collectionIds: string[]) {
      calls.push({ sharingDomain, collectionIds });
      return collectionIds.map(id => allowed.includes(id));
    },
  } as unknown as Fetcher<GatekeeperUserVerifier>;
  return { user, calls };
}

describe("contextObserverStrategy", () => {
  it("keeps enforcing collections recorded before the move to the kit tracker", async () => {
    for (let legacy of [true, "observed", "pending"]) {
      let kv = makeKv();
      kv.put("observedCollection:private", legacy);
      let strategy = contextObserverStrategy(kv, "workshop.example");

      await expect(strategy.addObserver("denied", verifier([]).user))
        .rejects.toThrow(CONTEXT_OBSERVER_DENIED);
      let allowed = verifier(["private"]);
      await strategy.addObserver("allowed", allowed.user);
      expect(allowed.calls).toEqual([
        { sharingDomain: "workshop.example", collectionIds: ["private"] },
      ]);
    }
  });

  it("refuses without disclosing which collection the collaborator cannot read", async () => {
    let kv = makeKv();
    let strategy = contextObserverStrategy(kv, "workshop.example");
    let check = await strategy.prepare!(["private-collection-id"]);
    check.commit();

    let denial = strategy.addObserver("denied", verifier([]).user);
    await expect(denial).rejects.toThrow(CONTEXT_OBSERVER_DENIED);
    await expect(denial).rejects.not.toThrow(/private-collection-id/);
  });
});
