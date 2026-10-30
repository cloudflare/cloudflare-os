import type { OverseerDurableObject } from "../src/overseer";

type Impl = OverseerDurableObject["impl"];
const AGENT = {type: "agent" as const, id: "test", name: "Test"};
const USER = {type: "user" as const, id: "test-user", name: "Test"};

/** Use the actual execution row rather than a second integration-only turn machine. */
export function beginReplicaTurn(impl: Impl, chatId: number) {
  const row = impl.storage.activeAgents.get(chatId);
  const meta = impl.storage.chatMeta.get(chatId)!;
  impl.storage.chatMeta.put({...meta, activeAgent: AGENT});
  if (!row) impl.storage.activeAgents.put({chatId, initiatorUserId: "unused",
    modelId: AGENT.id, initiator: USER, callbackInitiated: false});
  return impl.captureAgentTurn(chatId)!;
}

/** A real pending decision prevents a synthetic model execution from resuming on eviction. */
export function pauseReplicaTurn(impl: Impl, chatId: number) {
  const row = impl.storage.activeAgents.get(chatId);
  const meta = impl.storage.chatMeta.get(chatId);
  if (!row || !meta?.activeAgent) return;
  impl.addChatMessages(chatId, AGENT, [{type: "connectionRequest", requestId: crypto.randomUUID(),
    vendorId: "fixture", vendorName: "Fixture", reason: "Replica test barrier", state: "pending"}]);
  impl.storage.chatMeta.put({...impl.storage.chatMeta.get(chatId)!, activeAgent: undefined});
}

export async function closeReplicaTurn(impl: Impl, chatId: number, reason: string) {
  if (reason === "approval") { pauseReplicaTurn(impl, chatId); return; }
  impl.storage.activeAgents.delete(chatId);
  const meta = impl.storage.chatMeta.get(chatId);
  if (meta) impl.storage.chatMeta.put({...meta, activeAgent: undefined});
}
