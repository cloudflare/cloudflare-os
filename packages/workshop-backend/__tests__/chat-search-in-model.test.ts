import { afterAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { WEB_SEARCH_VENDOR_ID } from "@gadgets/workshop-shared/web-search-gatekeeper";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { ChatBindingEntry, GatekeeperRecord } from "../src/storage-schema/overseer-storage.js";

// The workspace's ambient record of Web Search, and one of another vendor.
const WEB_SEARCH = 11;
const CONTEXT = 12;
const fakeGatekeeperClass = {} as unknown as GatekeeperRecord["class"];

// A chat's bindings to the workpieces `ids`, as its executeCode env holds them.
const holding = (...ids: number[]): ChatBindingEntry[] =>
    ids.map(id => ({ type: "workpiece", id }));

let doCounter = 0;

// Runs `fn` against a fresh workspace that holds both ambient records, on a deployment where the
// Web Search gatekeeper is installed.
async function inOverseer(fn: (impl: any) => void | Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`chat-search-in-model-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // (Bracket access reaches the private field.)
    let impl = instance["impl"] as any;
    impl.env = { ...impl.env, GATEKEEPER_WEBSEARCH: {} };
    for (let [id, vendorId] of [[WEB_SEARCH, "WebSearch"], [CONTEXT, "context"]] as const) {
      impl.storage.gatekeepers.put({
        id, resourceTitle: vendorId, class: fakeGatekeeperClass,
        creationSpec: { type: "ambient", vendorId, accountId: `account-${id}` },
      });
    }
    await fn(impl);
  });
}

afterAll(() => abortAllDurableObjects());

describe("OverseerImpl.chatMaySearchInModel", () => {
  it("lets a chat that holds the Web Search binding search in the model", async () => {
    await inOverseer(impl => {
      expect(impl.storage.gatekeepers.get(WEB_SEARCH).creationSpec.vendorId)
          .not.toBe(WEB_SEARCH_VENDOR_ID);
      expect(impl.chatMaySearchInModel(holding(CONTEXT, WEB_SEARCH))).toBe(true);
      // The bindings can be the live values of a map, which is what a turn passes.
      expect(impl.chatMaySearchInModel(
          new Map(holding(WEB_SEARCH).map(entry => ["WEB_SEARCH", entry])).values())).toBe(true);
    });
  });

  it("refuses a chat that holds no Web Search binding, though the workspace holds the record",
      async () => {
    // A gadget-spawned chat holds only what its spawner gave it and what it gained in its log.
    await inOverseer(impl => {
      expect(impl.chatMaySearchInModel(holding())).toBe(false);
      expect(impl.chatMaySearchInModel(holding(CONTEXT))).toBe(false);
      // Neither the chat's stored seed nor the workspace's list of ambient records is asked.
      impl.storage.chatContext.put({
        chatId: 1, bindings: { WEB_SEARCH }, alwaysAvailableCapsuleIds: [WEB_SEARCH, CONTEXT],
      });
      expect(impl.chatMaySearchInModel(holding(CONTEXT))).toBe(false);
    });
  });

  it("never counts the arguments of a call as a binding to a record", async () => {
    await inOverseer(impl => {
      // A value entry names a chat message, here one whose sequence is the record's id.
      expect(impl.chatMaySearchInModel([{ type: "value", messageSequence: WEB_SEARCH }]))
          .toBe(false);
      expect(impl.chatMaySearchInModel(
          [{ type: "value", messageSequence: WEB_SEARCH }, ...holding(WEB_SEARCH)])).toBe(true);
    });
  });

  it("refuses once the workspace holds restricted data", async () => {
    await inOverseer(impl => {
      impl.storage.containsRestrictedData.put(true);
      expect(impl.chatMaySearchInModel(holding(WEB_SEARCH))).toBe(false);
    });
  });

  it("refuses a binding whose record is gone", async () => {
    await inOverseer(impl => {
      impl.storage.gatekeepers.delete(WEB_SEARCH);
      expect(impl.chatMaySearchInModel(holding(WEB_SEARCH))).toBe(false);
    });
  });

  it("refuses a binding that is held back until the workspace restarts", async () => {
    await inOverseer(impl => {
      impl.gatekeeperUsable = (id: number) => id !== WEB_SEARCH;
      expect(impl.chatMaySearchInModel(holding(WEB_SEARCH))).toBe(false);
    });
  });

  it("refuses on a deployment where the Web Search gatekeeper is not installed", async () => {
    await inOverseer(impl => {
      let { GATEKEEPER_WEBSEARCH: _uninstalled, ...rest } = impl.env;
      impl.env = { ...rest, GATEKEEPER_CONTEXT: {} };
      expect(impl.chatMaySearchInModel(holding(WEB_SEARCH))).toBe(false);
    });
  });

  it("refuses a Web Search connection that is not the ambient record", async () => {
    await inOverseer(impl => {
      impl.storage.gatekeepers.put({
        id: WEB_SEARCH, resourceTitle: "Web Search", class: fakeGatekeeperClass,
        creationSpec: {
          type: "gatekeeper", vendorId: WEB_SEARCH_VENDOR_ID, resourceUrl: "websearch://web",
          typeUrlPattern: "websearch://*",
        },
      });
      expect(impl.chatMaySearchInModel(holding(WEB_SEARCH))).toBe(false);
    });
  });
});
