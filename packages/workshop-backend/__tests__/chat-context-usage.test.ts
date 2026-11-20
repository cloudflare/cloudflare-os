import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall} from "@earendil-works/pi-ai";
import type {AiModelConfig} from "@gadgets/workshop-shared/api";
import type {OverseerDurableObject} from "../src/overseer";
import {runAgent} from "../src/agent";
import {getModelTokenLimits} from "../src/agent-compaction";
import {obsContext} from "../src/observability";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const USER = {type: "user" as const, id: "test-user", name: "Test"};
const AUTHOR = {type: "agent" as const, id: "faux-model", name: "Faux"};
// A budget of the config's own, below what the window leaves for a prompt, so the recorded budget
// can only be the one compaction uses, not the window.
const CONFIG: AiModelConfig = {
  provider: "cloudflare", model: "faux-model", apiToken: "",
  contextWindow: 64_000, outputLimit: 4_000, compactionInputBudget: 40_000,
};
type Impl = OverseerDurableObject["impl"];

async function inKernel(test: (impl: Impl) => Promise<void>): Promise<void> {
  await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    const impl = instance.impl, timestamp = impl.getChatTimestamp();
    impl.storage.chatMeta.put({id: 1, title: "Context", started: timestamp, lastActive: timestamp});
    impl.addChatMessages(1, USER, [{type: "message", message: "Create an app."}]);
    impl.getInstanceInstructions = async () => "";
    impl.describeStandardFormats = async () => [];
    impl.listConnectableVendors = async () => [];
    await obsContext.with({gadgetId: "test-workspace", modelId: AUTHOR.id, operation: "agent.run"},
        () => test(impl));
  });
}

describe("chat context usage", () => {
  it("records the last step's tokens against the budget compaction uses, on the step's model", async () => {
    await inKernel(async impl => {
      const faux = createFauxCore({models: [{id: "faux-model"}]});
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("createGadget", {title: "Board", bindingName: "BOARD"}),
            {stopReason: "toolUse"}),
        fauxAssistantMessage(fauxText("Done.")),
      ]);
      await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, AUTHOR,
          new AbortController().signal, USER, CONFIG);

      const lastStep = [...impl.storage.chatModelData.list()].at(-1)!.message;
      const meta = impl.chatMetaForClient(impl.storage.chatMeta.get(1)!);
      expect(lastStep.usage.totalTokens).toBeGreaterThan(0);
      expect(meta.totalTokens).toBe(lastStep.usage.totalTokens);
      expect(meta.contextBudget).toEqual({tokens: getModelTokenLimits(CONFIG).inputBudget, model: AUTHOR.id});
      expect(meta.contextBudget?.tokens).toBe(40_000);
      // The next turn weighs its prompt from the same figure.
      expect(impl.loadChatHistory(1).measuredTokens).toBe(lastStep.usage.totalTokens);

      // A compaction changes the next prompt, so the figure goes until a step measures it again.
      impl.commitChatCompaction(1, {
        chatId: 1, compactedTo: 1, summary: "Summary.", chatBindings: [], nextChangeId: 0,
      });
      const compacted = impl.storage.chatMeta.get(1)!;
      expect(compacted.totalTokens).toBeUndefined();
      expect(compacted.contextBudget).toBeUndefined();
      expect(impl.loadChatHistory(1).measuredTokens).toBe(0);
    });
  });
});
