import type { ActionLogEntry, AiChatMessage } from "@gadgets/workshop-shared/api";
import { expect, it } from "vitest";
import { BUDGET, FORECAST, checkAsksForAccess, checkRead } from "./focus.js";
import { EvalVerifier, type VerifierSession } from "../src/verifier.js";

/**
 * Whether `verify` passes on a chat the agent answered with `reply`, having read `read` and made
 * the connection requests `requested`.
 */
async function passes(
    verify: (verifier: EvalVerifier) => Promise<void>, reply: string, read: string[] = [],
    requested: Record<string, string>[] = []) {
  const session: VerifierSession = {
    openGadget: async () => { throw new Error("openGadget is not used by this test"); },
    readBlobText: async () => { throw new Error("readBlobText is not used by this test"); },
    listActions: async options => ({
      entries: options?.filter === "observation"
        ? read.map(resourceUrl => ({ type: "observation", resourceUrl }) as ActionLogEntry) : [],
    }),
    connectionDrops: 0,
  };
  const messages = [{
    chatId: 1, sequence: 1, timestamp: new Date(), type: "message",
    author: { type: "agent", id: "agent", name: "agent" }, message: reply,
  }, ...requested.map(request => ({ type: "connectionRequest", reason: "To change it.", ...request })),
  ] as AiChatMessage[];
  return (await new EvalVerifier(session, [], messages).collect(verify)).every(({ pass }) => pass);
}

const readsBudget = (verifier: EvalVerifier) => checkRead(verifier, BUDGET);

it("takes a number for read only when the connection asked about was read", async () => {
  expect(await passes(readsBudget, "42", [FORECAST, BUDGET])).toBe(true);
  expect(await passes(readsBudget, "42", [FORECAST])).toBe(false);
  expect(await passes(readsBudget, "41", [BUDGET])).toBe(false);
});

it("takes naming what is out of reach and asking for it as an answer, and no less", async () => {
  expect(await passes(checkAsksForAccess,
      "I can't reach Test Thing budget from this chat. Could you link it here?")).toBe(true);
  expect(await passes(checkAsksForAccess,
      "Budget is not available to me here. Can you make it available?")).toBe(true);
  expect(await passes(checkAsksForAccess,
      "I can't access the item you were viewing because it isn't linked here. Please link it.")).toBe(true);
  expect(await passes(checkAsksForAccess, "Done, it is 17 now.")).toBe(false);
  expect(await passes(checkAsksForAccess, "Done, I set the Budget connection to 17.")).toBe(false);
  expect(await passes(checkAsksForAccess,
      "I do not have access to Budget, so I cannot change it.")).toBe(false);
  expect(await passes(checkAsksForAccess, "Which connection do you mean?")).toBe(false);
  // A request is for it by its link, which the agent was not told, or by the name it is given.
  expect(await passes(checkAsksForAccess, "I have asked for it.", [], [{ resourceUrl: BUDGET }])).toBe(true);
  expect(await passes(checkAsksForAccess, "I have asked for it.", [], [{ bindingName: "BUDGET" }])).toBe(true);
  expect(await passes(checkAsksForAccess, "I have asked for it.", [], [{ resourceUrl: FORECAST }])).toBe(false);
});
