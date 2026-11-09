// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds a hook Durable Object standing in for the overseer.
//
// `TestHooks` has to be a Durable Object rather than a WorkerEntrypoint: a `DurableObjectClass`
// from `ctx.exports.X({props})` is only reachable through `ctx.facets`, which is the same way the
// overseer instantiates a gatekeeper in production. Each binding is one facet, created on first
// use with the props a test chose, and the sessions it starts are handed back to the test.

import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ApprovalQueue, GatekeeperUserVerifier, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  SlackConversationGatekeeperImpl, SlackThreadGatekeeperImpl, SlackWorkspaceGatekeeperImpl,
} from "../../src/slack.js";
import type { SlackConversation, SlackThread, SlackWorkspaceSession } from "../../src/types.js";

export { default } from "../../src/slack.js";
export * from "../../src/slack.js";
// Named as well, since the pool builds `ctx.exports` entrypoints only from exports it can see
// statically, and the bindings and TestHooks mint these.
export { SlackUserImpl, SlackVerifier, UserAccount } from "../../src/slack.js";

// The production bindings plus a way to write their storage directly, for records an earlier
// version stored that today's code no longer writes.

export class TestWorkspaceGatekeeper extends SlackWorkspaceGatekeeperImpl {
  seed(entries: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(entries)) this.ctx.storage.kv.put(key, value);
  }
}

export class TestConversationGatekeeper extends SlackConversationGatekeeperImpl {
  seed(entries: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(entries)) this.ctx.storage.kv.put(key, value);
  }
}

export class TestThreadGatekeeper extends SlackThreadGatekeeperImpl {
  seed(entries: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(entries)) this.ctx.storage.kv.put(key, value);
  }
}

/** Which binding a facet is, and the props its connection was created with. */
export type TestBinding =
  | { kind: "workspace"; facetName: string; props: { userObjectId: string; teamId?: string; reportsSubresources?: true } }
  | {
    kind: "conversation"; facetName: string;
    props: { userObjectId: string; conversationId: string; teamId?: string; reportsSubresources?: true };
  }
  | {
    kind: "thread"; facetName: string;
    props: {
      userObjectId: string; conversationId: string; threadTs: string; permalink: string; teamId?: string;
      reportsSubresources?: true;
    };
  };

/** An observation as the approval queue received it: its title and what it reported. */
export type TestObservation = { title: string; subresources?: string[] };

// The facet methods TestHooks forwards to, spelled structurally: workers-types' `Fetcher<T>`
// return-type inference loses the test subclasses' `seed`.
type BindingFacet = {
  startSession(queue: RpcStub<ApprovalQueue>): Promise<unknown>;
  verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[], subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }>;
  getHistoricalSubresources(): Promise<string[]>;
  addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void>;
  seed(entries: Record<string, unknown>): Promise<void>;
};

type TestExports = {
  [Name in "TestWorkspaceGatekeeper" | "TestConversationGatekeeper" | "TestThreadGatekeeper"]:
    (options: { props: TestBinding["props"] }) => DurableObjectClass;
};

const BINDING_CLASSES = {
  workspace: "TestWorkspaceGatekeeper",
  conversation: "TestConversationGatekeeper",
  thread: "TestThreadGatekeeper",
} as const;

/** Records each observation it is asked to authorize, and authorizes it. */
class TestApprovalQueue extends RpcTarget {
  readonly observations: TestObservation[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push({ title: description.title, subresources: description.subresources });
  }
}

export class TestHooks extends DurableObject<Cloudflare.Env> {
  #queue = new TestApprovalQueue();

  #facet(binding: TestBinding): BindingFacet {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get(binding.facetName, () => ({
      class: exports[BINDING_CLASSES[binding.kind]]({ props: binding.props }),
    })) as unknown as BindingFacet;
  }

  async #open(binding: TestBinding): Promise<unknown> {
    using queue = new RpcStub(this.#queue) as unknown as RpcStub<ApprovalQueue>;
    return await this.#facet(binding).startSession(queue);
  }

  async openWorkspace(binding: TestBinding): Promise<SlackWorkspaceSession> {
    return await this.#open(binding) as SlackWorkspaceSession;
  }

  async openConversation(binding: TestBinding): Promise<SlackConversation> {
    return await this.#open(binding) as SlackConversation;
  }

  async openThread(binding: TestBinding): Promise<SlackThread> {
    return await this.#open(binding) as SlackThread;
  }

  /** Every observation the bindings' sessions authorized so far, in order. */
  observations(): TestObservation[] {
    return this.#queue.observations;
  }

  /** The binding's verifyObserverAccess(), with each observer's verifier minted for its account. */
  async verify(
    binding: TestBinding, observers: { id: string; userObjectId: string }[], subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    return this.#facet(binding).verifyObserverAccess(observers.map(({ id, userObjectId }) => ({
      id, verifier: this.ctx.exports.SlackVerifier({ props: { userObjectId } }),
    })), subresources);
  }

  async historicalSubresources(binding: TestBinding): Promise<string[]> {
    return this.#facet(binding).getHistoricalSubresources();
  }

  async addObserver(binding: TestBinding, observerId: string, userObjectId: string): Promise<void> {
    await this.#facet(binding).addObserver(
      observerId, this.ctx.exports.SlackVerifier({ props: { userObjectId } }));
  }

  /** Writes `entries` into the binding's storage, as an earlier version recorded them. */
  async seed(binding: TestBinding, entries: Record<string, unknown>): Promise<void> {
    await this.#facet(binding).seed(entries);
  }
}
