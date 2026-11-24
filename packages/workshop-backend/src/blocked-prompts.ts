import type { AiChatMessage } from "@gadgets/workshop-shared/api";

/**
 * The input a model request carries that no answered request did, as the sequences of its
 * records, reading the chat log newest first. When AI Gateway Guardrails blocks a request, these
 * are the records that can have caused it (see AiChatMessageBody.blockedInput):
 *
 * - What a user, a gadget or a caller wrote since the agent's last step: their messages, a
 *   user's own changes, and a call's arguments. Replay writes the rest of what the model reads
 *   there itself (a revert, an accepted connection), so that is not input.
 * - That last step too when it called tools, since no request has carried their results yet.
 *
 * Input an earlier block names is left out, because replay no longer sends it.
 */
export function unansweredInput(newestFirst: Iterable<AiChatMessage>): number[] {
  let input: number[] = [];
  let withheld = new Set<number>();
  for (let msg of newestFirst) {
    if (msg.type === "error") {
      for (let sequence of msg.blockedInput ?? []) withheld.add(sequence);
    } else if (msg.type === "message" && msg.author.type === "agent") {
      if (msg.toolCalls?.length && !withheld.has(msg.sequence)) input.push(msg.sequence);
      break;
    } else if ((msg.type === "message" || msg.type === "agentCallback" ||
                (msg.type === "changes" && msg.author.type === "user" &&
                 !msg.conversionBoundary)) &&
               !withheld.has(msg.sequence)) {
      input.push(msg.sequence);
    }
  }
  return input;
}
