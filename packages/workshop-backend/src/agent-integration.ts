import type { AgentTurnEvent, AgentTurnInfo } from "@gadgets/workshop-shared/agent-integration";
import type { AgentIntegrationOrigin, AgentIntegrationTurn } from "./storage-schema/overseer-storage";
export type { AgentIntegrationOrigin, AgentIntegrationTurn, AgentIntegrationParticipantRecord } from "./storage-schema/overseer-storage";

/** Trusted deployment grants; none can be asserted by a gatekeeper's description. */
export type AgentIntegrationGrant = {
  lifecycle?: boolean;
  contextualActions?: boolean;
  worktreeReplica?: boolean;
  /** Opt-in to durable approval redelivery; the integration must durably deduplicate effects. */
  recoverableActions?: boolean;
};

/** Parse the deliberately small phase-one grant surface, failing closed on malformed config. */
export function agentIntegrationGrant(config: string | undefined, vendorId: string): AgentIntegrationGrant {
  if (!config) return {};
  try {
    const parsed: unknown = JSON.parse(config);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const grant: unknown = Object.getOwnPropertyDescriptor(parsed, vendorId)?.value;
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) return {};
    if (Object.keys(grant).some(key => !["lifecycle", "contextualActions", "worktreeReplica", "recoverableActions"].includes(key))) return {};
    const lifecycle: unknown = Object.getOwnPropertyDescriptor(grant, "lifecycle")?.value;
    const contextualActions: unknown = Object.getOwnPropertyDescriptor(grant, "contextualActions")?.value;
    const worktreeReplica: unknown = Object.getOwnPropertyDescriptor(grant, "worktreeReplica")?.value;
    const recoverableActions: unknown = Object.getOwnPropertyDescriptor(grant, "recoverableActions")?.value;
    if ((lifecycle !== undefined && typeof lifecycle !== "boolean") ||
        (contextualActions !== undefined && typeof contextualActions !== "boolean") ||
        (worktreeReplica !== undefined && typeof worktreeReplica !== "boolean") ||
        (recoverableActions !== undefined && typeof recoverableActions !== "boolean")) return {};
    return { lifecycle: lifecycle === true, contextualActions: contextualActions === true,
      worktreeReplica: worktreeReplica === true, recoverableActions: recoverableActions === true };
  } catch {
    return {};
  }
}

/** Start/resume transition. Same request resumes only while its logical turn remains unfinished. */
export function beginIntegrationTurn(previous: AgentIntegrationTurn | undefined, chatId: number,
    requestKey: string, randomId: () => string = () => crypto.randomUUID()): AgentIntegrationTurn {
  const resumed = previous?.requestKey === requestKey && previous.state !== "finished";
  const turnId = resumed ? previous.turnId : randomId();
  const segmentId = randomId();
  return { chatId, requestKey, turnId, segmentId, state: "running",
    entry: { eventId: randomId(), turnId, segmentId, kind: resumed ? "resumed" : "started" } };
}

/** Persist a pause or terminal transition; repeated cleanup retains its original event ID. */
export function closeIntegrationTurn(turn: AgentIntegrationTurn,
    outcome: "approval" | "connection" | "completed" | "canceled" | "failed" | "abandoned",
    randomId: () => string = () => crypto.randomUUID()): AgentIntegrationTurn {
  // Suspension can be superseded by cancellation/termination, but never the reverse.
  if (turn.closing && (turn.state === "finished" || outcome === "approval" || outcome === "connection")) return turn;
  const identity = { eventId: randomId(), turnId: turn.turnId, segmentId: turn.segmentId };
  const closing: AgentTurnEvent = outcome === "approval" || outcome === "connection"
    ? { ...identity, kind: "suspended", reason: outcome }
    : { ...identity, kind: "finished", reason: outcome };
  return { ...turn, state: closing.kind === "suspended" ? "suspended" : "finished", closing };
}

/** Reject stale session/action capabilities instead of silently widening them to the latest turn. */
export function requireIntegrationTurn(turn: AgentIntegrationTurn | undefined,
    origin: AgentIntegrationOrigin, phase: AgentTurnInfo["phase"]): AgentTurnInfo {
  if (!turn || turn.turnId !== origin.turnId || turn.segmentId !== origin.segmentId ||
      (turn.state === "finished" && phase !== "finishing") ||
      (phase === "running" && turn.state !== "running")) {
    throw new Error("Agent integration context expired; this request belongs to a different or closed turn.");
  }
  return { turnId: turn.turnId, chatId: String(turn.chatId), segmentId: turn.segmentId, phase };
}

/**
 * Bound callback work without treating timeout as successful delivery. Cleanup can snapshot a large
 * filesystem, and even an entry callback may await prior cleanup; allow an hour before retrying.
 */
export async function deliverIntegrationEvent(deliver: () => Promise<void>, timeoutMs = 60 * 60 * 1_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(deliver), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Agent lifecycle callback timed out.")), timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
