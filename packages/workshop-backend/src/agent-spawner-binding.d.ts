// This file declares the type of an agent spawner binding. The gatekeeper serves the agent-facing
// section of it as text (agent-spawner-binding.txt is a symlink to this file, shipped as a Text
// module), so everything below the marker is written for the agent as its audience, which may
// assume `RpcStub` and `RpcTarget` are already imported.

import type { RpcStub, RpcTarget } from "cloudflare:workers";

// Everything below the following line is returned to agents via `describeBinding`.
// ---- BEGIN AGENT API ----

/** Binding which spawns agents. */
export interface AgentSpawnerBinding {
  /**
   * Spawn an agent to perform a task.
   *
   * `title` is the title of the new agent chat which will appear in the Gadget's chat history.
   *
   * `prompt` tells the agent what to do. This effectively creates a new AI agent chat (which the
   * user will be able to see in the conversation history) beginning with this prompt as the first
   * message.
   */
  spawn(title: string, prompt: string): Promise<void>;

  /**
   * Like spawn(), but the agent does not start immediately. The agent starts when a call is made
   * on the returned stub.
   *
   * This method returns a special stub that delivers calls to the new chat thread. This behaves
   * exactly like the `self` reference available to the `executeCode` tool, but targets the
   * newly-spawned agent. You may call any method name on this stub; the method's name and
   * parameters will be delivered to the agent, and it will then begin executing. The call returns
   * a promise that resolves as soon as the call is durably queued; the agent proceeds
   * asynchronously.
   *
   * The parameters to an agent call are encouraged to contain stubs which the agent may use to
   * call back to the gadget. Any such stubs must be persistent (created with `ctx.restore()`).
   *
   * Note that there is no built-in notification when the agent is done. If the gadget needs such a
   * notification, it should define a callback stub as part of the interface.
   *
   * The returned stub can be stored in Durable Object storage in order to invoke the same agent
   * again in the future. Of course, you should only reuse the same agent when continuing the same
   * logical task; it's better to spawn a new agent for a new task.
   *
   * Prefer spawnAgent() in new code: it returns the same stub as part of a SpawnedAgent.
   */
  spawnCallable(title: string, options: SpawnCallableOptions): Promise<CallableAgent>;

  /**
   * Like spawnCallable(), but returns a SpawnedAgent: a handle to the new agent, of which the
   * stub spawnCallable() would return is one part (see SpawnedAgent.getAgent()).
   */
  spawnAgent(title: string, options: SpawnCallableOptions): Promise<RpcStub<SpawnedAgent>>;
}

/**
 * A spawned agent, returned by AgentSpawnerBinding.spawnAgent(). It is an RPC stub, so its methods
 * return promises.
 *
 * The stub is persistent: it can be stored in Durable Object storage in order to use the same
 * agent again in the future. It stops working once the agent's chat is deleted.
 */
export interface SpawnedAgent extends RpcTarget {
  /**
   * Returns the stub that calls the agent, exactly like the one spawnCallable() returns. It can be
   * used without awaiting, e.g. `spawned.getAgent().process(document)`.
   */
  getAgent(): CallableAgent;

  /**
   * Returns an opaque string naming this agent's chat. To show the user the chat, the gadget's UI
   * passes it to `host.openAgentChat()` (`host` being the second argument of client.js's
   * `main(gadget, host)`).
   */
  getChatToken(): string;
}

export type SpawnCallableOptions = {
  /**
   * TypeScript declarations defining the interface this agent is meant to implement, including any
   * dependencies such as interfaces of callback stubs. These type definitions should have doc
   * comments explaining, among other things, what the agent is expected to do when it receives
   * each call.
   *
   * These type declarations may assume that the Workers RPC / Cap'n Web types `RpcStub` and
   * `RpcTarget` have already been imported. Use e.g. `RpcStub<SomeInterface>` to declare a
   * parameter that is an RPC callback. As usual, `SomeInterface` should either be an interface
   * inheriting `RpcTarget`, or it can be a simple callable function type.
   */
  types: string;

  /** Name of the interface within `types` that the agent implements. */
  mainType: string;
};

/**
 * Calls the agent. Any method name may be called; it should be one declared on the interface
 * named by `SpawnCallableOptions.mainType`. Every method resolves once the call is recorded.
 */
export type CallableAgent = { [method: string]: (...args: unknown[]) => Promise<void> };
