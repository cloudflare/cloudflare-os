// The per-binding gatekeeper Durable Object: one instance per binding of a PagerDuty connection,
// whether to the whole account, a team, a service, an incident or a schedule. It owns the
// binding's action journal, the temporary IDs of incidents and overrides not yet created, and a
// read cache partitioned by connection. It pins the user and account the connection belongs to,
// and mints the capabilities gadgets hold (the pagerduty-*session*.ts modules) and the delivery
// stubs of their hooks (pagerduty-hooks.ts). Every PagerDuty request runs through the account's
// credential source.

import { DurableObject, restore, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ActionJournal, type ActionSubmitter } from "@gadgets/gatekeeper-kit/actions";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import { ProvisionalIds } from "@gadgets/gatekeeper-kit/simulation";
import {
  actions, dependedRefs, isProvisional, providedRefs, type PagerDutyAction, type PagerDutyActionHost,
  type PagerDutyActions,
} from "./pagerduty-actions";
import { PagerDutyApi } from "./pagerduty-api";
import {
  accountSource, parseSubresource, type AccountKey, type Identity, type PagerDutyVerifierApi,
} from "./pagerduty-credentials";
import { webOrigin, type Env, type PagerDutyGatekeeperImplProps, type ResourceKind } from "./pagerduty-env";
import {
  HOOKS_NOT_CONFIGURED, PagerDutyHookDeliveryImpl, hookDescription, hooksConfigured, watchedKinds,
  type PagerDutyHookDelivery,
} from "./pagerduty-hooks";
import { PagerDutyIncidentImpl } from "./pagerduty-incident-session";
import { PagerDutyScheduleImpl } from "./pagerduty-schedule-session";
import { SessionContext, type HookScope, type ObjectRef, type SessionHost } from "./pagerduty-session-shared";
import { PagerDutyAccountImpl, PagerDutyServiceImpl, PagerDutyTeamImpl } from "./pagerduty-sessions";
import { resourceUrl, sameTenant } from "./pagerduty-urls";
import type { PagerDutyAccount, PagerDutyIncident, PagerDutySchedule, PagerDutyService, PagerDutyTeam } from "./types";
import TYPES_CODE from "./types.txt";

/** How long the connected identity is trusted in memory before the account is asked again. */
const IDENTITY_MEMO_MS = 60 * 1000;

// Storage keys of this class's own. The kit modules own theirs: `pagerduty:` (the journal),
// `refs:` and `cache:@pagerduty:`.
const PINNED_KEY = "pinned";

/** The user and account a binding is pinned to at its first use. */
type Pinned = AccountKey & { userId: string };

/** How each kind of binding is described, and the interfaces it and its hooks implement. */
const BINDINGS: Record<ResourceKind, { noun: string; bindingName: string; tsType: string; hookTsType?: string }> = {
  account: { noun: "account", bindingName: "PAGERDUTY", tsType: "PagerDutyAccount", hookTsType: "PagerDutyEventHook" },
  team: { noun: "team", bindingName: "PAGERDUTY_TEAM", tsType: "PagerDutyTeam", hookTsType: "PagerDutyEventHook" },
  service: { noun: "service", bindingName: "PAGERDUTY_SERVICE", tsType: "PagerDutyService", hookTsType: "PagerDutyEventHook" },
  incident: { noun: "incident", bindingName: "PAGERDUTY_INCIDENT", tsType: "PagerDutyIncident", hookTsType: "PagerDutyEventHook" },
  schedule: { noun: "schedule", bindingName: "PAGERDUTY_SCHEDULE", tsType: "PagerDutySchedule" },
};

const SCHEDULE_TAGS = ["manage-overrides", "delete-overrides"];
const notSchedule = (tag: string) => !SCHEDULE_TAGS.includes(tag);

/**
 * Which action tags each kind of binding can submit, for the auto-approval catalog. Opening an
 * incident, which an incident binding can't, is never auto-approvable, so it needn't be excluded.
 */
const BINDING_ACTIONS: Record<ResourceKind, (tag: string) => boolean> = {
  account: () => true,
  team: () => true,
  service: notSchedule,
  incident: notSchedule,
  schedule: tag => SCHEDULE_TAGS.includes(tag),
};

type PagerDutySession = PagerDutyAccount | PagerDutyTeam | PagerDutyService | PagerDutyIncident | PagerDutySchedule;

@validateRpc()
export class PagerDutyGatekeeperImpl extends DurableObject<Env, PagerDutyGatekeeperImplProps>
  implements Gatekeeper<PagerDutySession> {
  readonly #creds = accountSource(this.ctx.exports, this.ctx.props.userObjectId);
  readonly #journal = new ActionJournal<PagerDutyAction>(this.ctx.storage.kv, { namespace: "pagerduty" });
  readonly #refs = new ProvisionalIds<string>(this.ctx.storage.kv, { namespace: "refs:", isProvisional });
  readonly #cache = KvTtlCache.partitionedBy(this.ctx.storage.kv, this.#creds, { name: "pagerduty" });
  #identity?: { value: Identity; at: number };

  // Every ID a read reports names the pinned account (see `verifyObserverAccess`), and each
  // observer's own connection answers for them.
  readonly #verifyAccess = observerAccessVerifier<PagerDutyVerifierApi>({
    hasCollectionAccess: (verifier, ids) => verifier.checkSubresourceAccess([...ids]),
  });

  // What apply handlers may do. A plain object, not this class: its stub is the overseer's.
  readonly #actionHost: PagerDutyActionHost = {
    tenant: this.ctx.props,
    refs: this.#refs,
    write: async op => {
      const me = await this.#me();
      return await this.#creds.run(creds => op(new PagerDutyApi(creds.accessToken, me.region, me.email), me));
    },
    invalidate: () => this.#cache.invalidateAll(),
  };

  readonly #actions = actions.bind(this.#journal, this.#actionHost);

  readonly #sessionHost: SessionHost = {
    tenant: this.ctx.props,
    me: () => this.#me(),
    read: op => this.#creds.run(creds => op(new PagerDutyApi(creds.accessToken, this.ctx.props.region)),
      { replayable: true }),
    cached: (key, ttlMs, load) => this.#cache.cached(key, ttlMs, load),
    pending: () => this.#journal.listPending(),
    resolve: id => this.#refs.resolve(id),
    allocate: kind => this.#refs.allocate(sequence => `~${sequence}`, { kind }),
    submit: (queue, kind, payload) => this.#submit(queue, kind, payload),
    subscribe: async (queue, hook, options, scope) => {
      if (!hooksConfigured(this.env)) throw new Error(HOOKS_NOT_CONFIGURED);
      const events = watchedKinds(options);
      // Refuses a binding its connection no longer matches before the user is asked.
      await this.#me();
      using delivery: RpcStub<PagerDutyHookDelivery> = await this.ctx.restore(scope);
      const controller = this.ctx.exports.PagerDutyHookController({ props: {
        key: crypto.randomUUID(), events, delivery,
        ...(scope.incidentId ? { incidentId: scope.incidentId } : {}),
        ...(scope.within.serviceId ? { serviceId: scope.within.serviceId } : {}),
      } });
      // @ts-expect-error Workers widens the controller's hook type across bindHook RPC.
      await queue.bindHook(controller, hook, hookDescription(this.ctx.props, scope, events));
    },
  };

  async describe(): Promise<ResourceDescription> {
    const props = this.ctx.props;
    const { noun, bindingName, tsType, hookTsType } = BINDINGS[props.resourceKind];
    const host = new URL(webOrigin(props)).host;
    const types = { suggestedBindingName: bindingName, tsType, ...(hookTsType ? { hookTsType } : {}) };
    // Descriptions are visible outside observation authorization, so they name objects by ID only.
    return props.resourceKind === "account"
      ? { url: resourceUrl({ ...props, kind: "account" }), title: host, snippet: "PagerDuty account", ...types }
      : {
        url: resourceUrl({ ...props, kind: props.resourceKind }), title: `PagerDuty ${noun} ${props.id}`, snippet: host,
        ...types,
      };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    const submits = BINDING_ACTIONS[this.ctx.props.resourceKind];
    return this.#actions.autoApprovableKinds().filter(kind => submits(kind.tag));
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<PagerDutySession> {
    const props = this.ctx.props;
    const ctx = (...scope: ObjectRef[]) => new SessionContext(this.#sessionHost, approvalQueue.dup(), scope);
    switch (props.resourceKind) {
      case "account": return new PagerDutyAccountImpl(ctx());
      case "team": return new PagerDutyTeamImpl(ctx({ kind: "team", id: props.id }), props.id);
      case "service": return new PagerDutyServiceImpl(ctx({ kind: "service", id: props.id }), props.id, {});
      // An incident's reads report the incident by the ID PagerDuty gives it, which a link by
      // number doesn't carry.
      case "incident": return new PagerDutyIncidentImpl(ctx(), props.id, {});
      case "schedule": return new PagerDutyScheduleImpl(ctx({ kind: "schedule", id: props.id }), props.id, {});
    }
  }

  /** The target of a hook's delivery stub, minted by `SessionHost.subscribe` with the hook's scope. */
  [restore](scope: HookScope): PagerDutyHookDelivery {
    return new PagerDutyHookDeliveryImpl(this.#sessionHost, scope);
  }

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    // Actions are fenced on the user the binding is pinned to; see `#submit`.
    const { userId } = await this.#me();
    await this.#actions.apply(actionId, { generation: userId });
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    // Rejecting an incident or override later actions build on retires those too, and the gadget
    // may hold a capability for its temporary ID: restart it rather than leave that dangling.
    const record = this.#journal.get(actionId);
    const provided = record ? providedRefs(record.action) : [];
    const builtOn = provided.length > 0 && this.#journal.listUndecided().some(({ id, action }) =>
      id !== actionId && dependedRefs(action.payload).some(ref => provided.includes(ref)));
    await this.#actions.reject(actionId);
    return builtOn ? { restart: true } : undefined;
  }

  async revertAction(_actionId: number): Promise<{ message: string; canRetry: boolean }> {
    return { message: "PagerDuty changes can't be undone automatically.", canRetry: false };
  }

  /** A new gatekeeper: no read was ever made without reporting its subresources. */
  async getHistoricalSubresources(): Promise<string[]> {
    return [];
  }

  /**
   * Allows an observer only if their own connection can read every subresource (see
   * `UserAccount.checkSubresourceAccess`). Fails the whole call for an ID naming any account but
   * the one this binding is pinned to, which no read through it reports.
   */
  async verifyObserverAccess(
      observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
      subresources: string[]): Promise<{ allowedObserverIds: string[] }> {
    const pinned = this.ctx.storage.kv.get<Pinned>(PINNED_KEY);
    if (pinned === undefined) throw new Error("This PagerDuty binding has not read anything yet.");
    for (const id of subresources) {
      const { region, accountId } = parseSubresource(id);
      if (region !== pinned.region || accountId !== pinned.accountId) {
        throw new Error("This subresource ID names another PagerDuty account than this binding's.");
      }
    }
    return await this.#verifyAccess(observers, subresources);
  }

  /** Compatibility only: observers are authorized per read, in verifyObserverAccess(). */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** Compatibility only: there is no observer state to remove. */
  async removeObserver(_id: string): Promise<void> {}

  /**
   * The connected user, pinned with their account at the binding's first use. The account already
   * refuses a reconnect as anyone else; the pin keeps a binding from following one regardless.
   */
  async #me(): Promise<Identity> {
    const now = Date.now();
    if (this.#identity && now - this.#identity.at < IDENTITY_MEMO_MS) return this.#identity.value;
    const { UserAccount } = this.ctx.exports;
    const identity = await UserAccount.get(UserAccount.idFromString(this.ctx.props.userObjectId)).getIdentity();
    const kv = this.ctx.storage.kv;
    const pinned = kv.get<Pinned>(PINNED_KEY);
    if (pinned === undefined) {
      if (!sameTenant(identity, this.ctx.props)) {
        throw new Error("This binding is for another PagerDuty account than its connection. Bind it again.");
      }
      kv.put<Pinned>(PINNED_KEY, { region: identity.region, accountId: identity.accountId, userId: identity.userId });
    } else if (pinned.userId !== identity.userId || pinned.accountId !== identity.accountId) {
      throw new Error("This binding was made for a different PagerDuty user than its connection now uses. " +
        "Remove it and bind the PagerDuty resource again.");
    }
    this.#identity = { value: identity, at: now };
    return identity;
  }

  /**
   * Stages an action, fenced on the pinned user rather than the connection generation: a
   * reconnect, always as the same user, must not strand what is waiting.
   */
  async #submit<K extends keyof PagerDutyActions>(
      queue: ActionSubmitter, kind: K, payload: PagerDutyActions[K]): Promise<number> {
    const { userId } = await this.#me();
    return await this.#actions.submit(queue, kind, payload, { fence: { generation: userId } });
  }
}
