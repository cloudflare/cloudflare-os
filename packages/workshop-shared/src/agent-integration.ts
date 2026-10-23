import type { RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
/** Ephemeral turn capability; only the participant, not this context, may be persisted. */
export interface AgentContext extends RpcTarget {
  /** Read opaque identity and current authority without exposing the user's identity. */
  getTurn(): Promise<AgentTurnInfo>;
  /**
   * Durably register one participant per connection and turn. Repeated registration is a no-op;
   * it does not replace the original participant or await its callback. The receiver must
   * initialize lazily when first used; registration does not send a started notification.
   */
  participate(participant: Fetcher<AgentTurnParticipant>): Promise<void>;
}

/** Identity of an existing durable execution, not a second workflow state machine. */
export interface AgentTurnInfo {
  /** Stable through decision pauses and Durable Object resets. */
  turnId: string;
  /** Opaque workspace-local chat identity, not a user or account ID. */
  chatId: string;
  /** Changes on resumption/reset; capabilities from earlier segments expire. */
  segmentId: string;
  /** Closing contexts authorize cleanup only, never new commands. */
  phase: "running" | "suspending" | "finishing";
}

/** Ordered, at-least-once notification; receivers must durably deduplicate eventId. */
export interface AgentTurnEvent {
  /** Retries retain the same persisted ID, including after a lost acknowledgement. */
  eventId: string;
  /** Original logical turn. */
  turnId: string;
  /** Segment which produced the event. */
  segmentId: string;
  /** Finished requests required cleanup before the logical turn can be released. */
  kind: "resumed" | "suspended" | "finished";
}

/** Persistent, account/workspace-bound Worker entrypoint supplied by a trusted integration. */
export interface AgentTurnParticipant extends WorkerEntrypoint {
  /**
   * For resumed/suspended, acknowledge durable receipt promptly; work proceeds independently
   * of inference. For finished, return only after required cleanup is complete: this is the
   * sole blocking lifecycle boundary, including on Stop. Delivery is retried after failure or
   * a lost reply. A delivery wait timeout does not cancel the receiver, so retries may overlap:
   * durably deduplicate and serialize/coalesce attempts for the same eventId.
   * Read the fresh context's phase before acting:
   * delayed notifications may already have cleanup-only authority.
   */
  onAgentTurnEvent(event: AgentTurnEvent, context: RpcStub<AgentContext>): Promise<void>;
}
