// Agent spans in the shape Cloudflare's Agents dashboard reads: OpenTelemetry GenAI semantic
// conventions, plus the `cloudflare.agents.*` attributes the Agents SDK adds. Identity comes from
// the turn's observability context. Prompts, responses, tool arguments or results, and tool names
// the model made up are never recorded.

import { tracing } from "cloudflare:workers";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessageEventStream, Model, Usage } from "@earendil-works/pi-ai";
import type { AiChatAgentContext } from "./agent";
import { AgentTurnError, httpStatusFromError } from "./ai-invoke";
import type { ModelHandle } from "./ai-models";
import { obsContext } from "./observability";

type Attributes = Record<string, string | number | boolean | undefined>;

// A spawned chat runs as a separate subagent.
function agentName(context: AiChatAgentContext): string {
  return context.spawnerConfig ? "workshop-subagent" : "workshop-agent";
}

function agentAttributes(name: string, gadgetId: string, chatId: number): Attributes {
  return {
    "gen_ai.agent.name": name,
    "gen_ai.agent.id": gadgetId,
    "gen_ai.conversation.id": `${gadgetId}:${chatId}`,
  };
}

// Undefined outside an agent turn, so model calls made elsewhere are not attributed to an agent.
function currentAgent(): Attributes | undefined {
  let { agentName: name, gadgetId, chatId } = obsContext.get();
  if (name === undefined || gadgetId === undefined || chatId === undefined) return undefined;
  return agentAttributes(name, gadgetId, chatId);
}

// Past Workers Observability's 64-byte span name budget, the bare operation; the target is on an
// attribute either way.
function spanName(operation: string, target: string | undefined): string {
  if (target === undefined) return operation;
  let name = `${operation} ${target}`;
  return new TextEncoder().encode(name).length <= 64 ? name : operation;
}

function modelAttributes(model: Model<Api>): Attributes {
  return {
    "gen_ai.provider.name": model.provider === "google" ? "gcp.gemini" : model.provider,
    "gen_ai.request.model": model.id,
  };
}

function failureAttributes(error: unknown, canceled: boolean): Attributes {
  if (canceled) return { "cloudflare.agents.canceled": true };
  if (error instanceof AgentTurnError) return { "error.type": requestErrorType(error.statusCode) };
  return { "error.type": error instanceof Error ? error.name : typeof error };
}

// A model request can fail after its 200 response (a refusal, an error mid-stream), so only an
// error status names the failure.
function requestErrorType(status: number | undefined): string {
  return status !== undefined && status >= 400 ? String(status) : "_OTHER";
}

// pi reports cached prompt tokens apart from `input`; OpenTelemetry's input count includes them.
function usageAttributes(usage: Usage): Attributes {
  return {
    "gen_ai.usage.input_tokens": usage.input + usage.cacheRead + usage.cacheWrite,
    "gen_ai.usage.output_tokens": usage.output,
    "gen_ai.usage.cache_read.input_tokens": usage.cacheRead,
    "gen_ai.usage.cache_creation.input_tokens": usage.cacheWrite,
    "gen_ai.usage.reasoning.output_tokens": usage.reasoning,
    "cloudflare.agents.usage.total_tokens": usage.totalTokens,
  };
}

/** The `invoke_agent` span of one agent turn, which the turn fills in as it runs. */
export interface AgentTurnSpan {
  /** Records the model the turn runs, once it is chosen. */
  setModel(model: Model<Api>): void;
  /** Records why a turn that returns without throwing failed, e.g. `usage_limit`. */
  setErrorType(errorType: string): void;
}

/**
 * Runs one agent turn for the chat described by `context` in an `invoke_agent` span. `signal` is
 * the turn's cancel signal, which tells a stop from a failure.
 */
export function traceAgentTurn(
    context: AiChatAgentContext, signal: AbortSignal,
    run: (turn: AgentTurnSpan) => Promise<void>): Promise<void> {
  let name = agentName(context);
  return obsContext.with({ agentName: name }, () =>
    tracing.enterSpan(spanName("invoke_agent", name), async (span) => {
      // The turn's own logging fields too, so traces filter by the same names as the logs.
      let { operation, gadgetId, chatId, modelId } = obsContext.get();
      span.setAttributes({
        "gen_ai.operation.name": "invoke_agent",
        ...currentAgent(),
        operation, gadgetId, chatId, modelId,
      });
      try {
        await run({
          setModel: model => span.setAttributes(modelAttributes(model)),
          setErrorType: errorType => span.setAttribute("error.type", errorType),
        });
      } catch (err) {
        span.setAttributes(failureAttributes(err, signal.aborted));
        throw err;
      }
    }));
}

/**
 * Starts one model request in a `chat` span that ends when the response settles. `response`
 * reads this request's own HTTP response metadata, once it has arrived.
 */
export function traceChat(
    model: Model<Api>, response: () => ModelHandle["lastResponse"],
    request: () => AssistantMessageEventStream): AssistantMessageEventStream {
  return tracing.startActiveSpan(spanName("chat", model.id), (span) => {
    span.setAttributes({
      "gen_ai.operation.name": "chat",
      ...currentAgent(),
      ...modelAttributes(model),
    });
    let stream: AssistantMessageEventStream;
    try {
      stream = request();
    } catch (err) {
      span.setAttributes(failureAttributes(err, false)).end();
      throw err;
    }
    void stream.result().then((message) => {
      let received = response();
      span.setAttributes({
        "gen_ai.response.model": message.responseModel,
        "gen_ai.response.id": message.responseId,
        "cloudflare.agents.response.finish_reason": message.stopReason,
        "cloudflare.ai_gateway.log.id": received?.aiGatewayLogId,
        ...usageAttributes(message.usage),
      });
      if (message.stopReason === "aborted") {
        span.setAttribute("cloudflare.agents.canceled", true);
      } else if (message.stopReason === "error") {
        span.setAttribute("error.type",
            requestErrorType(httpStatusFromError(message.errorMessage ?? "", received)));
      }
      span.end();
    });
    return stream;
  });
}

/**
 * Wraps `tool` so each execution runs in an `execute_tool` span, adding each call's id to
 * `executed` as it starts; calls pi rejects before running never reach it.
 */
export function traceTool(tool: AgentTool, executed: Set<string>): AgentTool {
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) => {
      executed.add(toolCallId);
      return tracing.enterSpan(spanName("execute_tool", tool.name), async (span) => {
        span.setAttributes(toolAttributes(tool.name, toolCallId));
        try {
          return await tool.execute(toolCallId, params, signal, onUpdate);
        } catch (err) {
          span.setAttributes(failureAttributes(err, signal?.aborted === true));
          throw err;
        }
      });
    },
  };
}

/**
 * Records a tool call pi rejected before running it: invalid arguments, or a tool that does not
 * exist, whose model-chosen name is passed as undefined.
 */
export function traceRejectedToolCall(
    toolName: string | undefined, toolCallId: string, canceled: boolean) {
  tracing.enterSpan(spanName("execute_tool", toolName), (span) => span.setAttributes({
    ...toolAttributes(toolName, toolCallId),
    ...(canceled ? { "cloudflare.agents.canceled": true } : { "error.type": "rejected" }),
  }));
}

function toolAttributes(toolName: string | undefined, toolCallId: string): Attributes {
  return {
    "gen_ai.operation.name": "execute_tool",
    ...currentAgent(),
    "gen_ai.tool.name": toolName,
    "gen_ai.tool.call.id": toolCallId,
    "gen_ai.tool.type": "function",
  };
}

/**
 * Records an approval step for an action the agent of chat `chatId` (described by `context`)
 * submitted through connection vendor `toolName`, as a zero-length `tool_approval` span.
 */
export function traceToolApproval(
    context: AiChatAgentContext, gadgetId: string, chatId: number, toolName: string | undefined,
    state: "requested" | "approved" | "denied") {
  tracing.enterSpan(spanName("tool_approval", toolName), (span) => span.setAttributes({
    "gen_ai.operation.name": "execute_tool",
    "cloudflare.agents.operation.name": "tool.approval",
    "cloudflare.agents.tool.approval.state": state,
    ...agentAttributes(agentName(context), gadgetId, chatId),
    "gen_ai.tool.name": toolName,
    "gen_ai.tool.type": "function",
  }));
}
