// Overseer.listChatBindings(): a chat's connections as its agent's env holds them, with what the
// agent did through each, read through the real client interface over a real OverseerImpl.

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo, ChatBindingInfo } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const SHEETS = "https://example.com/sheets/*";

function putGatekeeper(impl: any, id: number, creationSpec?: object, resourceUrl?: string): void {
  impl.storage.gatekeepers.put(
      { id, resourceTitle: `Resource ${id}`, class: {}, creationSpec, resourceUrl });
}

function putAgentAction(impl: any, id: number, chatId: number, gatekeeperId: number,
                        action: number | "create", state = "pending") {
  let record = {
    id, gatekeeperId, caller: { from: "agent", chatId }, createdAt: new Date(0), state,
    type: "action", action, description: { title: "Edit", description: "Edit" },
  };
  impl.storage.actions.put(record);
  return record;
}

describe("listChatBindings", () => {
  it("lists the chat's connections with what its agent created and changed", async () => {
    let stub = env.TEST_OVERSEER.getByName("chat-bindings");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.ownerId = impl.users.newUniqueId().toString();
      impl.ensureAmbientCapsules = async () => {};
      impl.markOutputsDirty = () => {};
      impl.getGatekeeperFacet = async () => ({
        applyCreation: async () => ({ class: {}, resourceUrl: "https://example.com/sheets/new" }),
        applyAction: async () => {},
      });
      let client = await instance.open(
          impl.ownerId, "owner-profile", new NativeRpcStub<() => void>(() => {}));

      putGatekeeper(impl, 1, { type: "gatekeeper", vendorId: "sheets", typeUrlPattern: SHEETS },
          "https://example.com/sheets/1");
      putGatekeeper(impl, 2, { type: "ambient", vendorId: "search" });
      putGatekeeper(impl, 3);
      putGatekeeper(impl, 4);
      putGatekeeper(impl, 5, { type: "gatekeeper", vendorId: "sheets", typeUrlPattern: SHEETS });
      putGatekeeper(impl, 6);
      impl.storage.gadgets.put({
        type: "gadget", id: 100, title: "App", created: new Date(0), bindingName: "APP",
        bindings: {},
      });
      impl.storage.chatMeta.put(
          { id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0), compactedTo: 1 });
      // The seed layer, as the chat's first turn stored it; GONE's connection was deleted since.
      impl.storage.chatContext.put(
          { chatId: 1, bindings: { SHEET: 1, SEARCH: 2, APP: 100, GONE: 99 } });
      let putMessage = (body: object) => {
        let sequence = impl.nextChatSequence(1);
        impl.storage.chats.put(
            { chatId: 1, sequence, timestamp: new Date(sequence), message: "", ...body });
      };
      // OLD was pasted before the compaction boundary, so only the checkpoint still names it.
      let capsule = (gatekeeperId: number, bindingName?: string) =>
          ({ position: 0, gatekeeperId, bindingName, description: { title: "Pasted" } });
      putMessage({ type: "message", author: OWNER, capsules: [capsule(3, "OLD")] });
      impl.storage.chatCompactions.put({
        chatId: 1, compactedTo: 1, summary: "", nextChangeId: 0, pins: [],
        chatBindings: [["OLD", { type: "workpiece", id: 3 }]],
      });
      // DOC was pasted and named; the other paste awaits its turn's naming, so isn't in the env.
      putMessage({ type: "message", author: OWNER, capsules: [capsule(4, "DOC"), capsule(6)] });
      putMessage({
        type: "message", author: { type: "agent", id: "model", name: "Agent" },
        toolCalls: [{
          toolName: "createExternalResource", input: { bindingName: "NEW_SHEET" },
          output: { gatekeeperId: 5 },
        }],
      });

      let creation = putAgentAction(impl, 1, 1, 5, "create");
      let edit = putAgentAction(impl, 2, 1, 1, 7);
      putAgentAction(impl, 3, 1, 2, 8, "rejected");
      putAgentAction(impl, 4, 2, 4, 9, "approved");  // another chat's agent
      let list = async () => Object.fromEntries(
          (await client.listChatBindings(1)).map(binding => [binding.name, binding]));

      let unchanged = { alwaysAvailable: false, created: false, changed: false };
      let expected: Record<string, ChatBindingInfo> = {
        SHEET: {
          name: "SHEET", target: 1, resourceTitle: "Resource 1", vendorId: "sheets",
          typeUrlPattern: SHEETS, resourceUrl: "https://example.com/sheets/1", ...unchanged,
        },
        SEARCH: { name: "SEARCH", target: 2, resourceTitle: "Resource 2", vendorId: "search",
                  ...unchanged, alwaysAvailable: true },
        OLD: { name: "OLD", target: 3, resourceTitle: "Resource 3", ...unchanged },
        DOC: { name: "DOC", target: 4, resourceTitle: "Resource 4", ...unchanged },
        NEW_SHEET: {
          name: "NEW_SHEET", target: 5, resourceTitle: "Resource 5", vendorId: "sheets",
          typeUrlPattern: SHEETS, alwaysAvailable: false, created: true, changed: false,
        },
      };
      expect(await list()).toEqual(expected);

      await impl.applyPendingAction(creation, OWNER, false, { creator: {}, configuration: null });
      await impl.applyPendingAction(edit, OWNER, false);
      expected.NEW_SHEET.resourceUrl = "https://example.com/sheets/new";
      expected.SHEET.changed = true;
      expect(await list()).toEqual(expected);
    });
  });
});
