import type { AiChatMessage, AiToolCall } from "@gadgets/workshop-shared/api";
import { toJsonValue, type JsonValue, type TranscriptEvent } from "vitest-evals";
import { z } from "zod";

const TOOL_ARGUMENTS = z.record(z.string(), z.json());

function toolArguments(call: AiToolCall): Record<string, JsonValue> | undefined {
  const result = TOOL_ARGUMENTS.safeParse(call.input);
  return result.success ? result.data : undefined;
}

/** Convert canonical Workshop history into vitest-evals trajectory events. */
export function toTranscriptEvents(history: readonly AiChatMessage[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const message of history) {
    const metadata = {
      sequence: message.sequence,
      timestamp: message.timestamp.toISOString(),
    };
    if (message.type === "message") {
      // The model receives regular messages from both users and Gadgets; agent-authored
      // ones replay as assistant messages with their tool activity below.
      const role = message.author.type === "user" || message.author.type === "gadget"
        ? "user"
        : message.author.type === "agent" ? "assistant" : undefined;
      if (role === undefined) continue;
      if (message.message !== "") {
        events.push({ type: "message", role, content: message.message, metadata });
      }
      if (role !== "assistant") continue;
      const calls = message.toolCalls ?? [];
      for (const call of calls) {
        const argumentsValue = toolArguments(call);
        const toolCall = {
          type: "tool_call",
          id: call.toolCallId,
          name: call.toolName,
          metadata,
        } satisfies TranscriptEvent;
        events.push(argumentsValue === undefined
          ? toolCall
          : { ...toolCall, arguments: argumentsValue });
      }
      for (const call of calls) {
        if (call.error !== undefined) {
          events.push({
            type: "tool_result",
            toolCallId: call.toolCallId,
            name: call.toolName,
            error: { name: "Error", message: call.error },
            metadata,
          });
          continue;
        }
        const output = "output" in call ? toJsonValue(call.output) : undefined;
        const result = {
          type: "tool_result",
          toolCallId: call.toolCallId,
          name: call.toolName,
          metadata,
        } satisfies TranscriptEvent;
        events.push(output === undefined ? result : { ...result, content: output });
      }
      continue;
    }
    if (message.type === "agentCallback") {
      // agent.ts replays a received callback as a user message naming self.<methodName>()
      // and the callback args, so it is model input too.
      events.push({
        type: "message",
        role: "user",
        content: `A callback was received: \`self.${message.methodName}()\`\n` +
          `Arguments: ${message.argsSummary}`,
        metadata,
      });
      continue;
    }
    if (message.type === "agentNudge") {
      // agent.ts replays a system-generated nudge as a user message so the model is
      // prompted to continue.
      events.push({ type: "message", role: "user", content: message.text, metadata });
      continue;
    }
  }
  return events;
}

/** Count model turns and tool outcomes from canonical history. */
export function measureHistory(history: readonly AiChatMessage[]): {
  modelTurns: number;
  toolCalls: number;
  toolErrors: number;
} {
  let modelTurns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  for (const message of history) {
    if (message.type !== "message" || message.author.type !== "agent") continue;
    modelTurns++;
    for (const call of message.toolCalls ?? []) {
      toolCalls++;
      if (call.error !== undefined) toolErrors++;
    }
  }
  return { modelTurns, toolCalls, toolErrors };
}
