// What a gatekeeper's workerd suite would otherwise carry its own copy of: a connected account to
// start from, and the gatekeeper reached as the overseer reaches it. Only tests import this.

import { DurableObject, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, Gatekeeper, GitCache, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { CredentialCoordinator, type CredentialsKv } from "./credentials";

/**
 * Stores `credentials` as a completed connect flow leaves them, so that a test can start from a
 * connected account without writing the coordinator's records itself.
 * @param kv The account's storage, as its `CredentialCoordinator` is given it.
 * @param credentials The grant, in the shape the account stores.
 */
export function seedCredentials<Creds>(kv: CredentialsKv, credentials: Creds): void {
  new CredentialCoordinator<Creds>(kv).connect(credentials);
}

/**
 * A call's result as plain data. A rejection that crosses RPC is reported as unhandled even where
 * the test expects it, so a test worker catches it and returns one of these.
 */
export type Outcome<T> = { ok: T } | { error: string };

/** Runs `fn`, and returns its result or its failure's message. */
export async function outcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The result of a call that succeeded.
 * @throws Error with the message of one that failed.
 */
export function unwrap<T>(result: Outcome<T>): T {
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}

/**
 * The message of a call that failed.
 * @throws Error for one that succeeded.
 */
export function failure(result: Outcome<unknown>): string {
  if (!("error" in result)) throw new Error(`Expected a failure, got ${JSON.stringify(result.ok)}`);
  return result.error;
}

/** One call in a scenario: a method and its arguments. */
export type Step = [method: string, ...args: unknown[]];

/**
 * An approval queue that records what it is asked, and decides nothing. It answers what a read
 * or a staged action asks; for a session that asks more, such as binding a hook, a host returns a
 * subclass from {@link GatekeeperTestHost.newQueue}.
 */
export class RecordingQueue extends RpcTarget implements Pick<ApprovalQueue, "submitAction" | "authorizeObservation"> {
  /** Each action submitted for approval, oldest first. */
  readonly submitted: { actionId: number; description: ActionDescription }[] = [];
  /** Each observation authorized, oldest first. */
  readonly observations: ObservationDescription[] = [];
  /** Set to refuse each observation asked for, as a user who denies a read does. */
  refuseObservations = false;

  async submitAction(actionId: number, description: ActionDescription): Promise<void> {
    this.submitted.push({ actionId, description });
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    if (this.refuseObservations) throw new Error("The approval queue refused this observation.");
    this.observations.push(description);
  }
}

class EmptyGitCache extends RpcTarget {}

/**
 * The Durable Object a test worker exports to reach its gatekeeper as the overseer does: as a
 * facet, the only way to instantiate a `DurableObjectClass` that carries props. A stub to a facet,
 * or to a session it mints, cannot be handed to a test, so each scenario runs here and comes back
 * as plain data.
 *
 * A test worker subclasses it to name the gatekeeper's class, and adds what its suites need
 * besides, such as minting a verifier or binding a hook, over {@link gatekeeper} and {@link queue}.
 */
export abstract class GatekeeperTestHost<Props, Env = unknown> extends DurableObject<Env> {
  readonly #queues = new Map<string, RecordingQueue>();

  /** The gatekeeper's class for a binding with `props`: `this.ctx.exports.<Class>({ props })`. */
  protected abstract gatekeeperClass(props: Props): DurableObjectClass<Gatekeeper<any>>;

  /**
   * The gatekeeper facet named `facetName`, made with `props` on first use. A facet keeps its
   * storage, so each scenario takes a fresh name.
   */
  protected gatekeeper(facetName: string, props: Props): Fetcher<Gatekeeper<any>> {
    return this.ctx.facets.get(facetName, () => ({ class: this.gatekeeperClass(props) }));
  }

  /** Makes a facet's approval queue: a subclass's, where its sessions ask more than a recording one answers. */
  protected newQueue(): RecordingQueue {
    return new RecordingQueue();
  }

  /** The approval queue every session of the facet named `facetName` is given. */
  protected queue(facetName: string): RecordingQueue {
    let queue = this.#queues.get(facetName);
    if (!queue) this.#queues.set(facetName, queue = this.newQueue());
    return queue;
  }

  /**
   * Opens a session and makes each call in `steps` on what the call before returned, starting
   * with the session. Every capability the scenario walked through is disposed.
   * @returns The last call's result, or nothing where `steps` has no call: the session is not a result.
   */
  async run(facetName: string, props: Props, steps: Step[]): Promise<Outcome<unknown>> {
    return await outcome(async () => {
      // A fake of the part of the queue a scenario reaches; a call on the rest fails as unimplemented.
      const queue = this.queue(facetName) as Partial<ApprovalQueue> as ApprovalQueue;
      // @ts-expect-error Cap'n Web's types are cyclic here, as in the overseer.
      const owned = [await this.gatekeeper(facetName, props).startSession(queue)];
      try {
        for (const [method, ...args] of steps) owned.push(await owned.at(-1)[method](...args));
        // The result is the caller's, and no longer this scenario's to dispose.
        return steps.length > 0 ? owned.pop() : undefined;
      } finally {
        for (const capability of owned.toReversed()) capability?.[Symbol.dispose]?.();
      }
    });
  }

  /** What the sessions of the facet named `facetName` have asked of their approval queue. */
  queueLog(facetName: string): Pick<RecordingQueue, "submitted" | "observations"> {
    const { submitted, observations } = this.queue(facetName);
    return { submitted, observations };
  }

  /** Has the queue of the facet named `facetName` refuse each observation, or authorize them again. */
  refuseObservations(facetName: string, refuse: boolean): void {
    this.queue(facetName).refuseObservations = refuse;
  }

  /** Applies an action the user approved, with a git cache that answers nothing. */
  async applyAction(facetName: string, props: Props, actionId: number): Promise<Outcome<void>> {
    return await outcome(() => this.gatekeeper(facetName, props).applyAction(actionId, new EmptyGitCache() as GitCache));
  }

  /** Rejects an action, and returns what the gatekeeper asks of the overseer for it. */
  async rejectAction(facetName: string, props: Props, actionId: number): Promise<Outcome<unknown>> {
    return await outcome<unknown>(() => this.gatekeeper(facetName, props).rejectAction(actionId));
  }
}
