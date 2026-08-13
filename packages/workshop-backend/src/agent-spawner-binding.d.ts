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
   * Like spawn(), but the agent does not start immediately. The chat thread is initialized with
   * the first message, but then waits for a call.
   *
   * This method returns a special stub that delivers calls to the new chat thread. This behaves
   * exactly like the `self` reference available to the `executeCode` tool, but targets the
   * newly-spawned agent. You may call any method name on this stub; the method's name and
   * parameters will be delivered to the agent, and it will then begin executing. The call returns
   * a promise that resolves when the agent finishes its turn, or when the agent explicitly
   * returns a value.
   *
   * The `prompt` message should explain to the agent what kind of calls to expect, perhaps even
   * defining a TypeScript interface which the agent is meant to "implement".
   *
   * The returned stub can be stored in Durable Object storage in order to invoke the same agent
   * again in the future. Of course, you should only reuse the same agent when continuing the same
   * logical task; it's better to spawn a new agent for a new task.
   */
  spawnCallable(title: string, prompt: string): Promise<Fetcher<any>>;
}
