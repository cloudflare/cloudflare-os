import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { resolveRequestedResource, type SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { agentToolExecutionMode, REQUEST_CONNECTION_TOOL_DESCRIPTION } from "../src/agent.js";

function makeModel(): Model<any> {
  return {
    id: "test-model",
    provider: "test-provider",
    api: "anthropic-messages",
    input: ["text"],
  } as Model<any>;
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
  };
}

function makeAssistantMessage(toolNames: string[]): AssistantMessage {
  return {
    role: "assistant",
    content: toolNames.map((name, index) => ({
      type: "toolCall" as const,
      id: `call-${index}`,
      name,
      arguments: {},
    })),
    api: "anthropic-messages",
    provider: "test-provider",
    model: "test-model",
    stopReason: "toolUse",
    timestamp: 1,
    usage: zeroUsage(),
  } as AssistantMessage;
}

function makeStreamFn(message: AssistantMessage): StreamFn {
  return () => ({
    async *[Symbol.asyncIterator]() {
      yield {type: "done" as const};
    },
    result: async () => message,
  });
}

function deferred(): {promise: Promise<void>, resolve: () => void} {
  let resolve!: () => void;
  let promise = new Promise<void>(r => { resolve = r; });
  return {promise, resolve};
}

function makeTool(
    name: string,
    hooks: {
      onStart?: (name: string) => void;
      onFinish?: (name: string) => void;
      wait?: () => Promise<void>;
    } = {}): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    executionMode: agentToolExecutionMode(name),
    execute: async () => {
      hooks.onStart?.(name);
      await hooks.wait?.();
      hooks.onFinish?.(name);
      return {content: [{type: "text", text: `result:${name}`}], details: {}};
    },
  } as AgentTool;
}

async function runToolBatch(
    toolNames: string[],
    tools: AgentTool[],
    events: AgentEvent[] = []): Promise<AgentEvent[]> {
  let context: AgentContext = {
    systemPrompt: "test",
    messages: [{role: "user", content: "go", timestamp: 0} as Message],
    tools,
  };
  let config: AgentLoopConfig = {
    model: makeModel(),
    convertToLlm: messages => messages as Message[],
    toolExecution: "parallel",
    shouldStopAfterTurn: () => true,
  };
  await runAgentLoopContinue(
      context, config, async event => { events.push(event); }, undefined,
      makeStreamFn(makeAssistantMessage(toolNames)));
  return events;
}

describe("agent tool parallelism policy", () => {
  it("classifies only explicit read-only tools as parallel", () => {
    expect(agentToolExecutionMode("readFile")).toBe("parallel");
    expect(agentToolExecutionMode("describeBinding")).toBe("parallel");
    expect(agentToolExecutionMode("listBlueprints")).toBe("parallel");
    expect(agentToolExecutionMode("listConnectableResources")).toBe("parallel");

    for (let name of [
      "writeFile",
      "editFile",
      "createGadget",
      "setGadgetBinding",
      "executeCode",
      "requestConnection",
      "giveUp",
      "webFetch",
      "unknownFutureTool",
    ]) {
      expect(agentToolExecutionMode(name)).toBe("sequential");
    }
  });

  it("describes vendor-only connection requests as explicit user picker flows", () => {
    expect(REQUEST_CONNECTION_TOOL_DESCRIPTION).toContain(
        "omit resourceUrl; the accept flow will show the user that vendor's explicit resource picker");
    expect(REQUEST_CONNECTION_TOOL_DESCRIPTION).toContain(
        "reuse an already-connected account when possible");
    expect(REQUEST_CONNECTION_TOOL_DESCRIPTION).not.toContain(
        "if the vendor offers multiple resource types with no whole-instance option you MUST pass");
  });

  it("keeps explicit invalid resource URLs rejected instead of falling back to a wrong type", () => {
    const resources: SupportedResource[] = [{
      title: "Jira issue",
      description: "Pick a Jira issue.",
      urlPattern: "https://:site.atlassian.net/browse/:issueKey",
    }, {
      title: "Jira project",
      description: "Pick a Jira project.",
      urlPattern: "https://:site.atlassian.net/projects/:projectKey",
    }];

    expect(resolveRequestedResource(resources, "https://acme.atlassian.net/wiki/spaces/ENG").ok)
      .toBe(false);
  });

  it("runs an all-read-only batch concurrently but persists results in model call order", async () => {
    let readMayFinish = deferred();
    let starts: string[] = [];
    let finishes: string[] = [];
    let events = await runToolBatch(
        ["readFile", "describeBinding"],
        [
          makeTool("readFile", {onStart: name => starts.push(name),
                                onFinish: name => finishes.push(name),
                                wait: () => readMayFinish.promise}),
          makeTool("describeBinding", {onStart: name => {
            starts.push(name);
          }, onFinish: name => {
            finishes.push(name);
            readMayFinish.resolve();
          }}),
        ]);

    expect(starts).toEqual(["readFile", "describeBinding"]);
    expect(finishes).toEqual(["describeBinding", "readFile"]);

    let turnEnd = events.find(event => event.type === "turn_end");
    expect(turnEnd?.type).toBe("turn_end");
    expect(turnEnd?.toolResults.map(result => result.toolName)).toEqual([
      "readFile",
      "describeBinding",
    ]);
  });

  it("keeps mixed read/write batches sequential", async () => {
    let first = deferred();
    let readStarted = deferred();
    let starts: string[] = [];
    let finishes: string[] = [];
    let eventsPromise = runToolBatch(
        ["readFile", "writeFile"],
        [
          makeTool("readFile", {onStart: name => {
                                  starts.push(name);
                                  readStarted.resolve();
                                },
                                onFinish: name => finishes.push(name),
                                wait: () => first.promise}),
          makeTool("writeFile", {onStart: name => starts.push(name),
                                 onFinish: name => finishes.push(name)}),
        ]);

    await readStarted.promise;
    expect(starts).toEqual(["readFile"]);
    first.resolve();

    let events = await eventsPromise;
    expect(starts).toEqual(["readFile", "writeFile"]);
    expect(finishes).toEqual(["readFile", "writeFile"]);

    let turnEnd = events.find(event => event.type === "turn_end");
    expect(turnEnd?.type).toBe("turn_end");
    expect(turnEnd?.toolResults.map(result => result.toolName)).toEqual([
      "readFile",
      "writeFile",
    ]);
  });
});
