import { AGENT_SPAWNER_CONNECTION_ID } from "@gadgets/workshop-shared/api";
import { defineTaskEval } from "../src/eval.js";
import { asEvidence, defineEvalTask } from "../src/task.js";
import type { EvalVerifier } from "../src/verifier.js";

// The user asks for a Gadget with an AI agent of its own. The agent has to ask the user for an
// agent spawner, not hand the Gadget a stub to its own chat (`self`), which would send every
// ticket's triage into the user's conversation.

// executeCode's entry point takes `self` as a parameter, so comments and parameter lists are
// dropped before looking for `self` passed on as a value (a call on it, `self.x()`, is not).
function passesSelf(code: string): boolean {
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\([^()]*\)\s*(=>|\{)/g, "() $1");
  return /(?<![\w$.])self(?![\w$.-])/.test(stripped);
}

function toolCalls(verifier: EvalVerifier) {
  return verifier.messages.flatMap(message =>
    message.type === "message" && message.author.type === "agent" ? message.toolCalls ?? [] : []);
}

const task = defineEvalTask({
  id: "ticket-triage-agent",
  turns: [{
    prompt: `Build me a Ticket Desk gadget for my work tickets. I add a ticket with a title and a
description, and I can list my tickets. Ticket Desk should have its own AI agent: each new ticket
goes to it in the background, and it sets the ticket's priority (low, medium or high) and writes a
one-line summary. That work must not come to this chat.`,
    verify: async verifier => {
      await verifier.check("requests-an-agent-spawner", async () => {
        const request = verifier.messages.find(message =>
          message.type === "connectionRequest" && message.vendorId === AGENT_SPAWNER_CONNECTION_ID);
        return {
          pass: request !== undefined,
          evidence: asEvidence(request ?? {
            toolCalls: toolCalls(verifier).map(call => call.toolName),
            reply: verifier.replies.at(-1) ?? "",
          }),
        };
      });

      await verifier.check("does-not-hand-the-gadget-this-chat", async () => {
        const passing = toolCalls(verifier).flatMap(call =>
          call.toolName === "executeCode" && passesSelf(call.input.code) ? [call.input.code] : []);
        return { pass: passing.length === 0, evidence: asEvidence(passing) };
      });
    },
  }],
});

defineTaskEval(task);
