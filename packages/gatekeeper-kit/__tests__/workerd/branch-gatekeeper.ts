/**
 * A gatekeeper that has adopted branches, built the way the kit tells an author to: a session
 * handle per session, `applyActions()`, `stageActions()` and `rejectAction()` delegated to the
 * bound set, and reads that overlay the handle's pending actions on what the provider holds. Its
 * provider is a set of markers in its own storage. A facet named `leaky-…` overlays every branch's
 * pending actions instead, the mistake the branch harness exists to catch.
 */

import { DurableObject, RpcTarget, type RpcStub } from "cloudflare:workers";
import type {
  ApplyActionsResult,
  ApprovalQueue,
  BranchView,
  GitCache,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  ActionJournal,
  defineActions,
  type ActionSession,
  type BoundActionSet,
  type TaggedAction,
} from "../../src/actions";

type Actions = { mark: { marker: string } };

type Provider = { add(marker: string): void };

const declared = defineActions<Provider, Actions>({
  mark: {
    kind: { tag: "mark", label: "Mark" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: ({ marker }) => ({
      title: "Mark",
      description: `Adds the marker ${marker}.`,
      implementsRevert: false,
    }),
    apply: async ({ marker }, provider) => provider.add(marker),
  },
}, { fence: "none" });

/** What a gadget holds: writes go through the handle, reads overlay what it shows pending. */
export class MarkerSession extends RpcTarget {
  readonly #queue: RpcStub<ApprovalQueue>;
  readonly #actions: ActionSession<Actions>;
  readonly #host: BranchGatekeeper;

  constructor(queue: RpcStub<ApprovalQueue>, actions: ActionSession<Actions>, host: BranchGatekeeper) {
    super();
    this.#queue = queue;
    this.#actions = actions;
    this.#host = host;
  }

  async write(marker: string): Promise<number> {
    return this.#actions.submit("mark", { marker });
  }

  async read(marker: string): Promise<boolean> {
    await this.#queue.authorizeObservation({ title: "Markers", description: "Read the markers." });
    const pending = this.#host.leaky ? this.#host.everyBranch() : this.#actions.pending();
    return this.#host.real().includes(marker)
      || pending.some(({ action }) => action.payload.marker === marker);
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }
}

export class BranchGatekeeper extends DurableObject {
  readonly #journal = new ActionJournal<TaggedAction<Actions>>(this.ctx.storage.kv, {
    namespace: "markers",
  });

  readonly #actions: BoundActionSet<Actions> = declared.bind(this.#journal, {
    add: marker => this.ctx.storage.kv.put("real", [...this.real(), marker]),
  });

  get leaky(): boolean {
    return this.ctx.id.name?.startsWith("leaky") ?? false;
  }

  real(): string[] {
    return this.ctx.storage.kv.get<string[]>("real") ?? [];
  }

  everyBranch() {
    return this.#journal.listPendingAcrossBranches();
  }

  async startSession(queue: RpcStub<ApprovalQueue>, branch?: BranchView): Promise<MarkerSession> {
    const kept = queue.dup();
    return new MarkerSession(kept, await this.#actions.session(kept, branch), this);
  }

  applyActions(branch: BranchView, actions: number[], _cache: RpcStub<GitCache>)
    : Promise<ApplyActionsResult> {
    return this.#actions.applyList(branch, actions);
  }

  stageActions(branch: BranchView, actions: number[]): Promise<void> {
    return this.#actions.stageList(branch, actions);
  }

  rejectAction(id: number) {
    return this.#actions.rejectAction(id);
  }
}
