import { setTimeout as delay } from "node:timers/promises";
import { asEvidence, thingUrl, type EvalFocus } from "../src/task.js";
import type { EvalVerifier } from "../src/verifier.js";

/** The Test Thing the user reads beside the chat, which holds 42. */
export const BUDGET = thingUrl("budget");

/** Another, also holding 42, which a chat can have talked of last. */
export const FORECAST = thingUrl("forecast");

/** The user viewing it with its number picked, as the UI showing it would report the spot. */
export const VIEWING: EvalFocus = {
  url: BUDGET, spot: { anchor: "value", label: "Value", context: "42" },
};

const SETTLE_MS = 5_000;

/** Checks that the agent answered with the number the Test Thing at `url` holds, having read it. */
export const checkRead = (verifier: EvalVerifier, url: string) =>
  verifier.check("reads-the-linked-connection", async () => {
    const reply = verifier.replies.at(-1) ?? "";
    const read = (await verifier.reads()).map(({ resourceUrl }) => resourceUrl);
    return {
      pass: /\b42\b/.test(reply) && read.includes(url),
      evidence: asEvidence({ reply, read }),
    };
  });

/**
 * Checks that the agent said it cannot reach the Test Thing viewed, by its name or as what was
 * being viewed, and asked for it: in words, or with a connection request for it.
 */
export const checkAsksForAccess = (verifier: EvalVerifier) =>
  verifier.check("asks-for-what-it-cannot-reach", async () => {
    const reply = verifier.replies.join("\n");
    const requested = verifier.messages.some(message => message.type === "connectionRequest" &&
      /budget/i.test(`${message.resourceUrl} ${message.reason} ${message.bindingName}`));
    // Asked for with a verb that would bring it here, or in a question about reaching it. Whole
    // words: "the Budget connection" names it and asks nothing.
    const asked = /budget|\bview|\blooking at/i.test(reply) &&
      /\b(link|connect|share|attach|add|bind|grant|give|paste)\b|\b(access|availab|permission)[^.!]*\?/i
        .test(reply);
    return { pass: requested || asked, evidence: asEvidence({ reply, requested }) };
  });

/**
 * Checks that the agent built no Gadget, and that the writes it asked of the workspace's
 * connections are exactly the `values` set on the Test Thing viewed, in order. A write is in the
 * log shortly after the turn that asked for it ends.
 */
export async function checkWrites(verifier: EvalVerifier, values: readonly number[]): Promise<void> {
  await verifier.check("builds-no-gadget", async () => {
    const gadgets = verifier.workpieces.flatMap(({ type, title }) => type === "gadget" ? [title] : []);
    return { pass: gadgets.length === 0, evidence: gadgets };
  });

  await verifier.check("writes-only-what-was-asked", async () => {
    const expected = values.map(value => `${BUDGET}: Set the test value to ${value}`);
    const asked = async () => (await verifier.writes())
      .map(({ resourceUrl, description }) => `${resourceUrl}: ${description.title}`).toReversed();
    const until = Date.now() + SETTLE_MS;
    let writes = await asked();
    while (writes.length < expected.length && Date.now() < until) {
      await delay(250);
      writes = await asked();
    }
    return {
      pass: JSON.stringify(writes) === JSON.stringify(expected),
      evidence: asEvidence({ writes, expected, reply: verifier.replies.at(-1) ?? "" }),
    };
  });
}
