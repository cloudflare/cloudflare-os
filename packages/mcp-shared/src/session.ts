// The capability a Gadget actually holds: one session over one MCP binding. Every tool call a Gadget
// can make arrives here, and the rules applied are the same for both connectors.
//
// What differs per connector is which server and how to reach it, which is what `McpSessionHost`
// supplies. The base never touches the Durable Object, the account, or the endpoint's credentials.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import type { ActionDescription, ActionKind, ApprovalQueue }
  from "@gadgets/workshop-shared/gatekeeper";

import type { McpClient } from "./client.js";
import type { WithClientOptions } from "./connection.js";
import { isWholeEndpoint, type ToolScope } from "./scope.js";
import { describeCall, toCallResult, toolInfo, type ClassifiedTool } from "./tools.js";
import type { McpCallResult, McpToolInfo } from "./types";

/**
 * A queued tool call, awaiting a decision. Persisted by the host in its own storage; the session
 * only ever reads one back by id.
 */
export type StoredAction = {
  id: number;
  toolName: string;
  args: Record<string, unknown>;
  /**
   * `applying` is the window between an approval arriving and the call returning. It exists so a
   * second `applyAction` for the same id cannot find the record still `pending` and call the tool a
   * second time; see `ActionStore.apply`.
   */
  state: "pending" | "applying" | "applied" | "rejected" | "failed";
  submittedAt: number;
  /** When the in-flight apply was claimed, for recovering a claim whose Durable Object died mid-call. */
  claimedAt?: number;
  /**
   * Whether a `failed` record may be sent again. Absent means yes, which is the reading for records
   * written before this field existed. False marks a failure that left the outcome unknown: the
   * request may already have been carried out, so another attempt could duplicate a write that MCP
   * gives no way to undo. See `ActionStore.apply`.
   */
  retryable?: boolean;
  /** Populated once applied; delivered to the Gadget as an observation. */
  result?: Extract<McpCallResult, { status: "ok" }>;
  error?: string;
};

/**
 * What a session needs from the gatekeeper facet that owns it. Narrow: the session is handed to a
 * Gadget, so anything reachable from here is one `followPath` away from untrusted code.
 */
export interface McpSessionHost {
  readonly serverName: string;
  readonly endpoint: string;
  /** How much of the endpoint this binding may call. Only used to word the "no such tool" error. */
  readonly scope: ToolScope;

  tools(): Promise<ClassifiedTool[]>;

  /** Runs `fn` against an initialized client for this binding's endpoint. */
  call<T>(fn: (client: McpClient) => Promise<T>, options?: WithClientOptions): Promise<T>;

  /** The approval-kind tag for one tool, namespaced so pre-approvals cannot cross servers. */
  actionKindFor(toolName: string): ActionKind;

  stageAction(toolName: string, args: Record<string, unknown>): StoredAction;
  discardStagedAction(id: number): void;
  lookupAction(id: number): StoredAction | undefined;
}

/**
 * The Gadget-facing session. A named method per tool is installed on a per-grant subclass (see
 * `session-methods.ts`), each a one-line delegate to `callTool`. Connectors subclass this and apply
 * `@validateRpc()` there, so the decorator is visible in the file that hands it to a Gadget.
 */
export class McpSessionBase extends RpcTarget {
  #host: McpSessionHost;
  #queue: RpcStub<ApprovalQueue>;

  constructor(host: McpSessionHost, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#host = host;
    this.#queue = queue;
  }

  [Symbol.dispose](): void {
    (this.#queue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools = await this.#host.tools();
    await this.#queue.authorizeObservation({
      title: `${this.#host.serverName}: list tools`,
      description:
        `Read the tool catalog of the MCP server **${this.#host.serverName}** ` +
        `(\`${this.#host.endpoint}\`).`,
    });
    return tools.map(toolInfo);
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<McpCallResult> {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("callTool() requires a tool name.");
    }
    const toolArgs = args ?? {};
    if (typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
      throw new Error("callTool() arguments must be an object.");
    }

    const host = this.#host;
    const tools = await host.tools();
    const entry = tools.find(candidate => candidate.tool.name === name);
    if (!entry) {
      // Worded from the grant's point of view: on a scoped binding the tool may exist on the server,
      // and "no such tool" would send an agent looking for a typo.
      const available = tools.map(candidate => candidate.tool.name).join(", ");
      throw new Error(isWholeEndpoint(host.scope)
        ? `The MCP server "${host.serverName}" has no tool named "${name}". Available: ${available}`
        : `This binding grants only these tools: ${available}.`);
    }

    const described = describeCall({
      serverName: host.serverName,
      endpoint: host.endpoint,
      tool: entry.tool,
      toolArgs,
      mode: entry.mode,
      classifiedBy: entry.classifiedBy,
    });

    if (entry.mode === "read") {
      const result = await host.call(client => client.callTool(name, toolArgs));
      // Authorize before the data is handed back, per the gatekeeper contract.
      await this.#queue.authorizeObservation(described);
      return toCallResult(result);
    }

    const staged = host.stageAction(name, toolArgs);
    const description: ActionDescription = {
      ...described,
      // MCP describes no inverse operation for a tool call.
      implementsRevert: false,
      // Nothing about a queued call is simulated, so later reads would show a world in which it
      // never happened. Wait for the decision instead.
      awaitDecision: true,
      autoApprovable: entry.autoApprovable,
      actionKind: host.actionKindFor(name),
    };

    try {
      await this.#queue.submitAction(staged.id, description);
    } catch (err) {
      host.discardStagedAction(staged.id);
      throw err;
    }

    return {
      status: "pending",
      actionId: staged.id,
      message:
        `Calling "${name}" on ${host.serverName} needs approval. If this is running in an ` +
        `agent's executeCode call, return from this executeCode call now so the approval can ` +
        `appear in chat. After approval, call getActionResult(${staged.id}) for the outcome.`,
    };
  }

  async getActionResult(actionId: number): Promise<McpCallResult> {
    if (!Number.isInteger(actionId)) throw new Error("getActionResult() requires an action id.");
    const host = this.#host;
    const stored = host.lookupAction(actionId);
    if (!stored) throw new Error(`No MCP action with id ${actionId}.`);

    switch (stored.state) {
      case "pending":
      case "applying":
        return {
          status: "pending",
          actionId,
          message: stored.state === "applying"
            ? `Calling "${stored.toolName}" on ${host.serverName} was approved and is running.`
            : `Calling "${stored.toolName}" on ${host.serverName} is awaiting approval.`,
        };
      case "rejected":
        return {
          status: "rejected",
          message: `Calling "${stored.toolName}" on ${host.serverName} was not approved.`,
        };
      case "failed":
        return {
          status: "failed",
          message: stored.error
            ?? `Calling "${stored.toolName}" on ${host.serverName} failed.`,
        };
      case "applied": {
        const result = stored.result
          ?? { status: "ok" as const, content: [], text: "", isError: false };
        // The result was produced while the Gadget was not looking, so it becomes an observation at
        // the moment it is handed over rather than when the call was applied.
        await this.#queue.authorizeObservation({
          title: `${host.serverName}: result of ${stored.toolName}`,
          description:
            `Read the response from the approved call to \`${stored.toolName}\` on ` +
            `**${host.serverName}**.`,
        });
        return result;
      }
    }
  }
}
