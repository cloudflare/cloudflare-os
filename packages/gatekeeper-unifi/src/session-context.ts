/**
 * What every session object shares: the bound console's API, the binding's action set and pending
 * actions, and -- owned per object -- the approval-queue and observation-gate stubs it authorizes
 * reads and submits actions through. A capability handed out by another (`site.getDevice(id)`)
 * forks its own pair of stubs, so it keeps working after its parent is disposed.
 */

import type { RpcStub } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { BoundActionSet } from "@gadgets/gatekeeper-kit/actions";
import { escapeObservationValue, type ObservationGate } from "@gadgets/gatekeeper-kit/observers";
import type { UnifiApi } from "./api";
import type { UnifiActionPayloads } from "./actions";
import { UnifiError } from "./errors";
import { isValidId } from "./resources";
import type { PendingAction } from "./simulation";

/** What a binding's session objects share. */
export type SessionShared = {
  readonly api: UnifiApi;
  readonly actions: BoundActionSet<UnifiActionPayloads>;
  /** The binding's pending actions, for simulation. */
  readonly pending: () => readonly PendingAction[];
  /** The console's display name. */
  readonly consoleName: () => Promise<string>;
  /** Wall-clock time, replaceable in tests. */
  readonly now: () => number;
};

/** One session object's own stubs and helpers. */
export class SessionContext implements Disposable {
  readonly shared: SessionShared;
  readonly #queue: RpcStub<ApprovalQueue>;
  readonly #gate: ObservationGate;

  /**
   * @param shared What the binding's session objects share.
   * @param queue A duplicate of the approval queue, owned by this context.
   * @param gate An observation gate over its own duplicate, owned by this context.
   */
  constructor(shared: SessionShared, queue: RpcStub<ApprovalQueue>, gate: ObservationGate) {
    this.shared = shared;
    this.#queue = queue;
    this.#gate = gate;
  }

  /** A context for a capability this one hands out, with stubs of its own. */
  fork(): SessionContext {
    return new SessionContext(this.shared, this.#queue.dup(), this.#gate.lease());
  }

  /** Authorizes a read before its data is returned. Every read reaches this. */
  async observe(title: string, description: string): Promise<void> {
    await this.#gate.authorize({ title, description }, { kind: "baseline" });
  }

  /** Submits an action for approval. */
  async submit<K extends keyof UnifiActionPayloads>(kind: K, payload: UnifiActionPayloads[K]): Promise<void> {
    await this.shared.actions.submit(this.#queue, kind, payload);
  }

  [Symbol.dispose](): void {
    this.#gate[Symbol.dispose]();
    this.#queue[Symbol.dispose]();
  }
}

/** Escapes provider text for an observation description. */
export function md(text: string): string {
  return escapeObservationValue(text);
}

/** `n thing(s)`. */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Validates an ID a caller passed in, before it reaches a path. */
export function requireId(value: string, what: string): string {
  if (!isValidId(value)) {
    throw new UnifiError({ kind: "badRequest", message: `That isn't a valid ${what} ID: ${JSON.stringify(value)}` });
  }
  return value;
}

/** Validates an integer argument. */
export function requireInteger(value: number, what: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UnifiError({ kind: "badRequest", message: `${what} must be a whole number from ${min} to ${max}.` });
  }
  return value;
}
