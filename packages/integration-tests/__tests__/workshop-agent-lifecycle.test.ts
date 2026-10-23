import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { openAgentSession } from "../src/agent-session.js";
import {
  startHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { withOwnerWorkspace } from "../src/rpc-client.js";

const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });
beforeAll(() => { network.install(); });
afterAll(() => {
  try { expect(network.getUnmockedCalls()).toEqual([]); }
  finally { network.uninstall(); }
});

const executeCode = (code: string): ChatCompletionStep => ({
  toolCall: { id: "probe-lifecycle", name: "executeCode", arguments: { code } },
});

function outputs(history: AiChatMessage[]) {
  return history.flatMap(message => message.type === "message" ? message.toolCalls ?? [] : [])
      .flatMap(call => call.toolName === "executeCode" ? [call.output] : []);
}

// These run in unwrapped Workers: the Workers Vitest pool's entrypoint wrapper cannot expose
// GatekeeperLoopback's proxy methods. No lifecycle capture/session/queue method is mocked here.
describe.each([false, true])("agent binding lifecycle grant: %s", granted => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startHarness({
      gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR }],
      enableGadgetExecution: true,
      patchWorkshop(config) {
        config.vars = { ...config.vars,
          AGENT_INTEGRATION_GRANTS: JSON.stringify(granted ? { [TEST_VENDOR_ID]: { lifecycle: true } } : {}) };
      },
    });
  });
  afterAll(async () => { await harness?.server.close(); });

  it("carries only granted agent origins through env, loopback, session and approval queue", async () => {
    const model = models.script([
      executeCode(`export default async function(self, env) {
        await env.TEST_AMBIENT.readValue();
        console.log(JSON.stringify(await env.TEST_AMBIENT.readAgentTurn()));
      }`),
      { text: "Done." },
    ]);
    await using session = await openAgentSession(harness.url, {
      modelId: SCRIPTED_MODEL_ID, userModel: model.userModel, ambientVendorIds: [TEST_VENDOR_ID],
    });
    const { outcome, history } = await session.runTurn("Read the current lifecycle identity.");
    expect(outcome).toEqual({ status: "completed" });
    const [output] = outputs(history);
    if (output === undefined) throw new Error("The lifecycle probe did not run.");
    if (granted) {
      expect(JSON.parse(output.trim())).toEqual({ phase: "running", chatId: expect.any(String),
        turnId: expect.any(String), segmentId: expect.any(String) });
    } else expect(JSON.parse(output.trim())).toBeNull();

    // The exact same connection, reached by its human owner, never acquires agent authority.
    const gatekeeperId = (await session.listActions()).entries
        .find(e => e.resourceTitle === "Test Ambient")?.gatekeeperId;
    if (gatekeeperId === undefined) throw new Error("The ambient test observation is missing.");
    await withOwnerWorkspace(harness.url, session.username, async ws => {
      using gatekeeper = await ws.getGatekeeperById(gatekeeperId);
      using ownerSession = await gatekeeper.openSession() as RpcStub<TestSession>;
      expect(await ownerSession.readAgentTurn()).toBeNull();
    });
    expect(model.requests).toHaveLength(2);
  });

  if (granted) it("does not revive an agent env binding saved by a gadget on a later turn", async () => {
    // Persist the ServiceStub's captured props, never the ephemeral AgentContext itself.
    const server = `import { DurableObject } from "cloudflare:workers";
      export class Gadget extends DurableObject {
        async remember(binding) {
          this.ctx.storage.kv.put("binding", binding);
          return await binding.readAgentTurn();
        }
        async readRemembered() {
          const binding = this.ctx.storage.kv.get("binding");
          try { return await binding.readAgentTurn(); }
          catch (error) { return {error: error.message}; }
        }
      }`;
    const model = models.script([
      { toolCall: { id: "create-probe", name: "createGadget",
        arguments: { title: "Saved binding probe", bindingName: "PROBE" } } },
      { toolCall: { id: "write-probe", name: "writeFile",
        arguments: { workpiece: "PROBE", filename: "server.js", content: server } } },
      executeCode(`export default async function(self, env) {
        console.log(JSON.stringify(await env.PROBE.rpc.remember(env.TEST_AMBIENT)));
      }`),
      { text: "Saved." },
      executeCode(`export default async function(self, env) {
        console.log(JSON.stringify(await env.PROBE.rpc.readRemembered()));
        console.log(JSON.stringify(await env.TEST_AMBIENT.readAgentTurn()));
      }`),
      { text: "Checked." },
    ]);
    await using session = await openAgentSession(harness.url, {
      modelId: SCRIPTED_MODEL_ID, userModel: model.userModel, ambientVendorIds: [TEST_VENDOR_ID],
    });
    const first = await session.runTurn("Save the binding for a later call.");
    expect(first.outcome).toEqual({ status: "completed" });
    expect(outputs(first.history)[0]).toContain('"phase":"running"');
    const second = await session.runTurn("Try the saved binding and the fresh binding.");
    expect(second.outcome).toEqual({ status: "completed" });
    const output = outputs(second.history).at(-1);
    expect(output).toContain("Agent integration context expired.");
    expect(output).toContain('"phase":"running"');
    expect(model.requests).toHaveLength(6);
  });
});
