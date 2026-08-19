import type { AiChatMessage, AiToolCall } from "@gadgets/workshop-shared/api";
import { JsonObjectSchema, type TranscriptEvent } from "@vitest-evals/core";
import { toJsonValue } from "vitest-evals";
import type { EvalDiagnostics } from "./task.js";

const MESSAGE_LIMIT = 2_000;

function truncate(message: string): string {
  return message.length > MESSAGE_LIMIT ? `${message.slice(0, MESSAGE_LIMIT)}...` : message;
}

function toolArguments(call: AiToolCall) {
  const parsed = JsonObjectSchema.safeParse(toJsonValue(call.input));
  return parsed.success ? parsed.data : undefined;
}

function toolOutput(call: AiToolCall) {
  if (!("output" in call) || call.output === undefined) return undefined;
  return toJsonValue(call.output);
}

/**
 * Maps canonical Workshop history onto reporter events.
 *
 * Reasoning and Yjs lifecycle traffic are dropped: the transcript exists to explain a verdict, and
 * carrying the agent's private reasoning into a stored artifact serves no reader here.
 */
export function canonicalTranscript(history: readonly AiChatMessage[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const message of history) {
    if (message.type !== "message") continue;
    const role = message.author.type === "user" ? "user"
      : message.author.type === "agent" ? "assistant" : undefined;
    if (role === undefined) continue;
    const metadata = {
      sequence: message.sequence,
      timestamp: message.timestamp.toISOString(),
    };
    if (message.message !== "") {
      events.push({ type: "message", role, content: message.message, metadata });
    }
    if (role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      const argumentsValue = toolArguments(call);
      const outputValue = toolOutput(call);
      events.push({
        type: "tool_call",
        id: call.toolCallId,
        name: call.toolName,
        ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
        metadata,
      });
      events.push({
        type: "tool_result",
        toolCallId: call.toolCallId,
        name: call.toolName,
        ...(call.error === undefined
          ? (outputValue === undefined ? {} : { content: outputValue })
          : { error: { name: "Error", message: call.error } }),
        metadata,
      });
    }
  }
  return events;
}

/** Extracts the failure signals a reader needs to explain how a run went. */
export function collectDiagnostics(history: readonly AiChatMessage[]): EvalDiagnostics {
  const diagnostics: EvalDiagnostics =
    { toolCalls: 0, toolErrors: [], agentErrors: [], harnessWarnings: [] };
  for (const message of history) {
    if (message.type === "error") {
      diagnostics.agentErrors.push(truncate(message.message));
      continue;
    }
    if (message.type !== "message") continue;
    for (const call of message.toolCalls ?? []) {
      diagnostics.toolCalls++;
      if (call.error !== undefined) {
        diagnostics.toolErrors.push({ tool: call.toolName, message: truncate(call.error) });
      }
    }
  }
  return diagnostics;
}
