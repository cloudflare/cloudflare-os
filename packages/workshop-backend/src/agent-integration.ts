import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { AgentContext, AgentTurnEvent, AgentTurnInfo, AgentTurnParticipant } from "@gadgets/workshop-shared/agent-integration";
import type { OverseerDurableObject } from "./overseer";
import type { ActiveAgentRecord, AgentIntegrationOrigin } from "./storage-schema/overseer-storage";

type Impl = OverseerDurableObject["impl"];

const RETRY_MS = 30_000;

/** Independent, fail-closed deployment grants; gatekeepers cannot assert their own permissions. */
export function agentIntegrationGrant(config: string | undefined, vendor: string) {
  try {
    return JSON.parse(config ?? "null")?.[vendor]?.lifecycle === true;
  } catch { return false; }
}

/** Lifecycle output of the existing execution row. This class never starts or resumes an agent. */
export class AgentIntegrations {
  #deliveries = new Map<string, Promise<void>>();
  constructor(private impl: Impl, private changed: () => void) {
    // All removal/replacement paths (Stop, deletion, denial, failure, next prompt) share this
    // chokepoint. Subscriber writes commit in the same transaction as the execution mutation.
    impl.storage.activeAgents.subscribe({
      add() {},
      update: (old, next) => {
        if (old.integration && (!old.finishing && next.finishing ||
            old.integration.turnId !== next.integration?.turnId)) this.emit(old, "finished");
      },
      remove: old => this.emit(old, "finished"),
    });
  }

  capture(chatId: number): AgentIntegrationOrigin | undefined {
    const row = this.impl.storage.activeAgents.get(chatId);
    if (!row || row.finishing || !this.impl.storage.chatMeta.get(chatId)?.activeAgent) return;
    if (!row.integration) {
      row.integration = {turnId: crypto.randomUUID(), segmentId: crypto.randomUUID()};
      this.impl.storage.activeAgents.put(row);
    }
    return {chatId, ...row.integration};
  }

  emit(row: ActiveAgentRecord, kind: AgentTurnEvent["kind"]): void {
    if (!row.integration) return;
    // Buffer before writes: the DO's KV permits only one live iterator, including index reads.
    let queued = false;
    for (const r of Array.from(this.impl.storage.agentParticipants.byChat.get(row.chatId))) {
      const event = {...row.integration, kind, eventId: `${r.id}:${row.integration.segmentId}:${kind}`};
      if (r.turnId !== event.turnId || r.lastEvent === event.eventId ||
          r.pending.some(e => e.eventId === event.eventId)) continue;
      r.pending.push(event);
      r.retryAt = Date.now();
      this.impl.storage.agentParticipants.put(r);
      queued = true;
    }
    if (queued) this.changed();
  }

  context(gatekeeperId: number, origin: AgentIntegrationOrigin | undefined): AgentContext | null {
    if (!origin) return null;
    this.checkContext(gatekeeperId, origin);
    return new AgentContextImpl(this, gatekeeperId, origin);
  }

  checkContext(gatekeeperId: number, origin: AgentIntegrationOrigin): AgentTurnInfo {
    this.impl.assertGatekeeperUsable(gatekeeperId);
    if (!this.impl.integrationGrant(gatekeeperId)) throw new Error("Agent integration grant revoked.");
    const row = this.impl.storage.activeAgents.get(origin.chatId);
    if (row?.finishing || row?.integration?.turnId !== origin.turnId || row.integration.segmentId !== origin.segmentId ||
        !this.impl.storage.chatMeta.get(origin.chatId)?.activeAgent) {
      throw new Error("Agent integration context expired.");
    }
    return {...origin, chatId: String(origin.chatId), phase: "running"};
  }

  register(gatekeeperId: number, origin: AgentIntegrationOrigin,
      participant: Fetcher<AgentTurnParticipant>): void {
    this.checkContext(gatekeeperId, origin);
    const id = `${origin.turnId}:${gatekeeperId}`;
    if (this.impl.storage.agentParticipants.get(id)) return;
    this.impl.storage.agentParticipants.put({id, chatId: origin.chatId, gatekeeperId,
      turnId: origin.turnId, participant, pending: []});
  }

  deliveryTurn(id: string, event: AgentTurnEvent): AgentTurnInfo {
    const receipt = this.impl.storage.agentParticipants.get(id);
    if (receipt?.pending[0]?.eventId !== event.eventId) throw new Error("Lifecycle delivery context expired.");
    const row = this.impl.storage.activeAgents.get(receipt.chatId);
    // Old deliveries retain only cleanup authority, even after revocation or chat deletion.
    const closing = receipt.pending.findLast(e => e.kind === "suspended" || e.kind === "finished");
    const allowed = this.impl.gatekeeperUsable(receipt.gatekeeperId) &&
      this.impl.integrationGrant(receipt.gatekeeperId);
    let phase: AgentTurnInfo["phase"] = "running";
    if (!allowed || row?.finishing || closing?.kind === "finished" || row?.integration?.turnId !== event.turnId) {
      phase = "finishing";
    } else if (closing || row.integration.segmentId !== event.segmentId ||
        !this.impl.storage.chatMeta.get(receipt.chatId)?.activeAgent) {
      phase = "suspending";
    }
    return {turnId: event.turnId, segmentId: event.segmentId, chatId: String(receipt.chatId), phase};
  }

  async #deliver(id: string): Promise<void> {
    const running = this.#deliveries.get(id);
    if (running) return running;
    const delivery = Promise.resolve().then(async () => {
      for (;;) {
        const r = this.impl.storage.agentParticipants.get(id), event = r?.pending[0];
        if (!r || !event) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let active = true;
        try {
          const context = new AgentContextImpl(this, r.gatekeeperId,
            {chatId: r.chatId, turnId: event.turnId, segmentId: event.segmentId}, {id, event}, () => active);
          await Promise.race([r.participant.onAgentTurnEvent(event, context), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Lifecycle callback timed out.")), 60 * 60 * 1_000);
          })]);
        } catch (error) {
          const latest = this.impl.storage.agentParticipants.get(id);
          if (latest) { latest.retryAt = Date.now() + RETRY_MS; this.impl.storage.agentParticipants.put(latest); }
          throw error;
        } finally { active = false; if (timer !== undefined) clearTimeout(timer); }
        const latest = this.impl.storage.agentParticipants.get(id);
        if (latest?.pending[0]?.eventId !== event.eventId) continue;
        latest.pending.shift();
        latest.lastEvent = event.eventId;
        if (!latest.pending.length) delete latest.retryAt;
        if (event.kind === "finished") this.impl.storage.agentParticipants.delete(id);
        else this.impl.storage.agentParticipants.put(latest);
      }
    });
    this.#deliveries.set(id, delivery);
    try { await delivery; }
    finally { this.#deliveries.delete(id); this.changed(); }
  }

  /** Wait for required end-of-turn cleanup, including earlier ordered notifications. */
  async drain(chatId?: number): Promise<void> {
    const records = chatId === undefined ? [...this.impl.storage.agentParticipants.list()]
      : [...this.impl.storage.agentParticipants.byChat.get(chatId)];
    await Promise.all(records.map(r => this.#deliver(r.id)));
  }

  /** A new prompt may replace a paused turn, but cannot overtake that turn's finalization. */
  async finishPrevious(chatId: number): Promise<void> {
    const records = [...this.impl.storage.agentParticipants.byChat.get(chatId)]
      .filter(r => r.pending.some(event => event.kind === "finished"));
    await Promise.all(records.map(r => this.#deliver(r.id)));
  }

  /** Alarm and immediate best-effort delivery; failed receipts keep a durable retry deadline. */
  async deliverDue(): Promise<void> {
    const records = [...this.impl.storage.agentParticipants.retryAt.list({end: Date.now() + 1})];
    await Promise.all(records.map(r => this.#deliver(r.id).catch(error => {
      this.impl.logger.warn("agent lifecycle delivery deferred", {
        event: "agent.lifecycle.delivery.deferred", chatId: r.chatId, gatekeeperId: r.gatekeeperId, error,
      });
    })));
  }
}

@validateRpc()
class AgentContextImpl extends RpcTarget implements AgentContext {
  constructor(private integrations: AgentIntegrations, private gatekeeperId: number,
      private origin: AgentIntegrationOrigin,
      private delivery?: {id: string; event: AgentTurnEvent}, private valid = () => true) { super(); }
  #turn() {
    if (!this.valid()) throw new Error("Agent integration context expired.");
    return this.delivery ? this.integrations.deliveryTurn(this.delivery.id, this.delivery.event)
      : this.integrations.checkContext(this.gatekeeperId, this.origin);
  }
  async getTurn(): Promise<AgentTurnInfo> {
    return this.#turn();
  }
  async participate(participant: Fetcher<AgentTurnParticipant>): Promise<void> {
    if (this.delivery) {
      this.#turn();
      return; // Already registered; never await our own callback or replace its durable target.
    }
    this.integrations.register(this.gatekeeperId, this.origin, participant);
  }
}
