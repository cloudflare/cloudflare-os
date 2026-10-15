import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { AgentContext, AgentTurnEvent, AgentTurnInfo, AgentTurnParticipant,
  GatekeeperActionContext } from "@gadgets/workshop-shared/agent-integration";
import type { GitCache } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "./overseer";
import type { ActiveAgentRecord, AgentIntegrationOrigin, ActionRecord } from "./storage-schema/overseer-storage";
import { GitCacheImpl } from "./git-cache";

type Impl = OverseerDurableObject["impl"];
const RETRY_MS = 30_000;

/** Independent, fail-closed deployment grants; gatekeepers cannot assert their own permissions. */
export function agentIntegrationGrant(config: string | undefined, vendor: string) {
  try {
    const parsed: unknown = JSON.parse(config ?? "null");
    const grant: unknown = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.getOwnPropertyDescriptor(parsed, vendor)?.value : undefined;
    if (!grant || typeof grant !== "object" || Array.isArray(grant) ||
        Object.entries(grant).some(([k, v]) => !["lifecycle", "contextualActions"].includes(k) || typeof v !== "boolean")) return {};
    return {lifecycle: Reflect.get(grant, "lifecycle") === true,
      contextualActions: Reflect.get(grant, "contextualActions") === true};
  } catch { return {}; }
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
        if (old.integration && old.integration.turnId !== next.integration?.turnId) this.emit(old, "finished");
      },
      remove: old => this.emit(old, "finished"),
    });
  }

  capture(chatId: number): AgentIntegrationOrigin | undefined {
    const row = this.impl.storage.activeAgents.get(chatId);
    if (!row || !this.impl.storage.chatMeta.get(chatId)?.activeAgent) return;
    if (!row.integration) {
      row.integration = {turnId: crypto.randomUUID(), segmentId: crypto.randomUUID()};
      this.impl.storage.activeAgents.put(row);
    }
    return {chatId, ...row.integration};
  }

  /** Rotate capability identity only; execution phase and readiness remain in #797's row/log. */
  enter(chatId: number): void {
    const row = this.impl.storage.activeAgents.get(chatId);
    if (!row?.integration) return;
    this.impl.storage.transaction(() => {
      row.integration!.segmentId = crypto.randomUUID();
      this.impl.storage.activeAgents.put(row);
      this.emit(row, "resumed");
    });
  }

  emit(row: ActiveAgentRecord, kind: AgentTurnEvent["kind"]): void {
    if (!row.integration) return;
    // Buffer before writes: the DO's KV permits only one live iterator, including index reads.
    for (const r of Array.from(this.impl.storage.agentParticipants.byChat.get(row.chatId))) {
      const event = {...row.integration, kind, eventId: `${r.id}:${row.integration.segmentId}:${kind}`};
      if (r.turnId !== event.turnId || r.lastEvent === event.eventId ||
          r.pending.some(e => e.eventId === event.eventId)) continue;
      r.pending.push(event);
      r.retryAt = Date.now();
      this.impl.storage.agentParticipants.put(r);
    }
    this.changed();
  }

  context(gatekeeperId: number, origin: AgentIntegrationOrigin | undefined,
      phase: "running" | "applyingAction" = "running", valid = () => true): AgentContext | null {
    if (!origin) return null;
    const grant = this.impl.integrationGrant(gatekeeperId);
    if (!grant.lifecycle && !grant.contextualActions) return null;
    this.turn(origin, phase);
    return new AgentContextImpl(this, gatekeeperId, origin, phase, undefined, valid);
  }

  checkContext(gatekeeperId: number, origin: AgentIntegrationOrigin,
      phase: "running" | "applyingAction"): AgentTurnInfo {
    const grant = this.impl.integrationGrant(gatekeeperId);
    if (!grant.lifecycle && !grant.contextualActions) throw new Error("Agent integration grant revoked.");
    return this.turn(origin, phase);
  }

  turn(origin: AgentIntegrationOrigin, phase: "running" | "applyingAction"): AgentTurnInfo {
    const row = this.impl.storage.activeAgents.get(origin.chatId);
    if (row?.integration?.turnId !== origin.turnId || row.integration.segmentId !== origin.segmentId ||
        (phase === "running" && !this.impl.storage.chatMeta.get(origin.chatId)?.activeAgent)) {
      throw new Error("Agent integration context expired.");
    }
    return {...origin, chatId: String(origin.chatId), phase};
  }

  register(gatekeeperId: number, origin: AgentIntegrationOrigin,
      phase: "running" | "applyingAction", participant: Fetcher<AgentTurnParticipant>): void {
    if (!this.impl.integrationGrant(gatekeeperId).lifecycle) throw new Error("Lifecycle access not granted.");
    this.turn(origin, phase);
    const id = `${origin.turnId}:${gatekeeperId}`;
    if (this.impl.storage.agentParticipants.get(id)) return;
    this.impl.storage.agentParticipants.put({id, chatId: origin.chatId, gatekeeperId,
      turnId: origin.turnId, participant, pending: [{turnId: origin.turnId,
        segmentId: origin.segmentId, eventId: `${id}:${origin.segmentId}:started`, kind: "started"}],
      retryAt: Date.now()});
    this.changed();
  }

  deliveryTurn(id: string, event: AgentTurnEvent): AgentTurnInfo {
    const receipt = this.impl.storage.agentParticipants.get(id);
    if (receipt?.pending[0]?.eventId !== event.eventId) throw new Error("Lifecycle delivery context expired.");
    const row = this.impl.storage.activeAgents.get(receipt.chatId);
    // Old deliveries retain only cleanup authority, even after revocation or chat deletion.
    const closing = receipt.pending.findLast(e => e.kind === "suspended" || e.kind === "finished");
    const phase = closing?.kind === "finished" || row?.integration?.turnId !== event.turnId ? "finishing"
      : closing || row.integration.segmentId !== event.segmentId ||
          !this.impl.storage.chatMeta.get(receipt.chatId)?.activeAgent ? "suspending" : "running";
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
          const closing = this.deliveryTurn(id, event).phase !== "running";
          if (closing || this.impl.integrationGrant(r.gatekeeperId).lifecycle) {
            const context = new AgentContextImpl(this, r.gatekeeperId,
              {chatId: r.chatId, turnId: event.turnId, segmentId: event.segmentId}, "running", {id, event}, () => active);
            await Promise.race([r.participant.onAgentTurnEvent(event, context), new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Lifecycle callback timed out.")), 60 * 60 * 1_000);
            })]);
          }
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

  /** Await cleanup/entry before the next model invocation or destructive workspace deletion. */
  async drain(chatId?: number): Promise<void> {
    const records = chatId === undefined ? [...this.impl.storage.agentParticipants.list()]
      : [...this.impl.storage.agentParticipants.byChat.get(chatId)];
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
      private origin: AgentIntegrationOrigin, private phase: "running" | "applyingAction",
      private delivery?: {id: string; event: AgentTurnEvent}, private valid = () => true) { super(); }
  #turn() {
    if (!this.valid()) throw new Error("Agent integration context expired.");
    return this.delivery ? this.integrations.deliveryTurn(this.delivery.id, this.delivery.event)
      : this.integrations.checkContext(this.gatekeeperId, this.origin, this.phase);
  }
  async getTurn(): Promise<AgentTurnInfo> {
    return this.#turn();
  }
  async participate(participant: Fetcher<AgentTurnParticipant>): Promise<void> {
    const turn = this.#turn();
    if (this.delivery) {
      if (turn.phase !== "running") throw new Error("Cannot participate during cleanup.");
      return; // Already registered; never await our own callback or replace its durable target.
    }
    this.integrations.register(this.gatekeeperId, this.origin, this.phase, participant);
  }
}

/** Apply-time scope expires with the dispatch; it never adopts a later turn's authority. */
@validateRpc()
export class GatekeeperActionContextImpl extends RpcTarget implements GatekeeperActionContext {
  #active = true;
  constructor(private impl: Impl, private record: ActionRecord & {type: "action"}) { super(); }
  #check() {
    if (!this.#active || !this.impl.integrationGrant(this.record.gatekeeperId).contextualActions) {
      throw new Error("Action context expired or grant revoked.");
    }
  }
  [Symbol.dispose]() { this.#active = false; }
  async getGitCache(): Promise<GitCache> {
    this.#check();
    return new GitCacheImpl(this.impl.gitCache, this.record.gatekeeperId, this.record.id);
  }
  async getAgentContext(): Promise<AgentContext | null> {
    this.#check();
    const origin = this.record.integrationOrigin;
    const current = origin && this.impl.storage.activeAgents.get(origin.chatId)?.integration;
    if (!origin || current?.turnId !== origin.turnId) return null;
    return this.impl.integrations.context(this.record.gatekeeperId,
      {...origin, segmentId: current.segmentId}, "applyingAction", () => this.#active);
  }
}
