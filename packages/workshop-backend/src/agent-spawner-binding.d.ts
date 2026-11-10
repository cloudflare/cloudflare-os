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
   *
   * `options.attachments` attaches files to that first message, as if the user had uploaded them
   * alongside the prompt -- e.g. images for the agent to look at. See `SpawnOptions`.
   */
  spawn(title: string, prompt: string, options?: SpawnOptions): Promise<void>;

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
   */
  spawnCallable(title: string, options: SpawnCallableOptions): Promise<CallableAgent>;
}

export type SpawnOptions = {
  /**
   * Files to attach to the prompt, handled exactly like files a user uploads to a chat message.
   * Images in a format the agent's model accepts (JPEG, PNG, or WebP) are shown to the model as
   * images, so it can see them rather than only read their bytes; PDFs and text files are inlined
   * where the model supports them. Every attachment is also saved as a file in the new chat's
   * scratch worktree, which the agent can read with its file tools.
   *
   * The limits on a user's uploads apply: at most 5 attachments, each at most 4 MiB, and 5 MiB
   * in total; and the file's content must match `mimeType` (a file labelled `image/png` must
   * really be a PNG). A spawn that breaks them, or names a blob the workspace doesn't have,
   * throws, and no chat is created.
   *
   * Store each file first with `env.GIT.writeBlob()`, then pass its ID:
   *
   *     let oid = await env.GIT.writeBlob(pngBytes);
   *     await env.SPAWNER.spawn("Read receipt", "What's the total on this receipt?",
   *         { attachments: [{ oid, mimeType: "image/png", name: "receipt.png" }] });
   */
  attachments?: SpawnAttachment[];
};

/** One file attached to a spawned agent's prompt. See `SpawnOptions.attachments`. */
export type SpawnAttachment = {
  /** ID of the file's bytes in the workspace's git store, as returned by `env.GIT.writeBlob()`. */
  oid: string;

  /** The file's MIME type, e.g. `"image/png"`. */
  mimeType: string;

  /** A filename to show for it, e.g. `"receipt.png"`. Also names its scratch worktree file. */
  name?: string;
};

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
