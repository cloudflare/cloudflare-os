import type { AiChatMessage } from "@gadgets/workshop-shared/api";

// When AI Gateway Guardrails blocks a turn's prompt (see PromptBlockedError), the input that turn
// added never reached the model, and every request that still carries it is blocked the same way.
// So replay, and the compaction checkpoint built from the same log, leave that input out. These
// helpers decide which records it covers, once, for both.

/**
 * Whether a record is input the user (or a gadget) added for the model to read: a message, or a
 * batch of their own edits and uploads, which replay shows the model as an observation. Agent
 * records end the input a turn answers.
 */
function isUserInput(msg: AiChatMessage): boolean {
  return (msg.type === "message" && msg.author.type !== "agent") ||
      (msg.type === "changes" && msg.author.type === "user" && !msg.conversionBoundary);
}

/**
 * The input of the newest turn the agent has not answered: the user's messages and edits since
 * the agent's last message. A blocked prompt is only reported when this is non-empty, since it is
 * what replay would leave out.
 */
export function unansweredInput(messages: Iterable<AiChatMessage>): number[] {
  let unanswered: number[] = [];
  for (let msg of messages) {
    if (msg.type === "message" && msg.author.type === "agent") unanswered = [];
    else if (isUserInput(msg)) unanswered.push(msg.sequence);
    else if (msg.type === "error" && msg.code === "prompt_blocked") {
      let before = msg.blockedBefore ?? msg.sequence;
      unanswered = unanswered.filter(sequence => sequence >= before);
    }
  }
  return unanswered;
}

/**
 * Sequences of the records a "prompt_blocked" error covers: the user input added since the agent
 * last spoke, up to the error's `blockedBefore`. Steers the failed request never read are logged
 * after that point, just before the error, so they stay in the conversation.
 */
export function blockedPromptSequences(messages: Iterable<AiChatMessage>): Set<number> {
  let blocked = new Set<number>();
  let unanswered: number[] = [];
  for (let msg of messages) {
    if (msg.type === "message" && msg.author.type === "agent") {
      unanswered = [];
    } else if (isUserInput(msg)) {
      unanswered.push(msg.sequence);
    } else if (msg.type === "error" && msg.code === "prompt_blocked") {
      let before = msg.blockedBefore ?? msg.sequence;
      for (let sequence of unanswered) if (sequence < before) blocked.add(sequence);
      unanswered = unanswered.filter(sequence => sequence >= before);
    }
  }
  return blocked;
}
