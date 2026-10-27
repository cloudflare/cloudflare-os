// Test worker for the workerd suites (fake Graph and live contract). Re-exports the production
// entrypoints so miniflare can bind the Durable Objects, and adds `TestHooks`, which reaches the
// gatekeeper as the overseer does.
//
// `TestHooks` has to be a Durable Object: a `DurableObjectClass` from `ctx.exports.X({props})` is
// only reachable through `ctx.facets`, which is how the overseer instantiates a gatekeeper. A stub to
// a facet, or to a session it mints, cannot be handed to the test, so TestHooks runs each scenario
// itself -- a chain of method calls on a session -- and returns the result as plain data.

import { DurableObject, RpcTarget, WorkerEntrypoint, restore, type RpcStub } from "cloudflare:workers";
import type {
  ActionDescription, ConnectHandoff, GatekeeperConnectCallback, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { CalendarGatekeeperProps, OutlookGatekeeperProps, SharePointAccess, SharePointGatekeeperProps } from "../../src/microsoft-env.js";
import { GraphApi } from "../../src/graph-api.js";
import { accountSource } from "../../src/microsoft-credentials.js";
import { SharePointConfiguratorUI } from "../../src/sharepoint-configurator.js";
import { resolveSharePointUrl } from "../../src/sharepoint-resolve.js";
import { resolveOutlookUrl } from "../../src/outlook-resolve.js";
import type { OutlookAccessLevel } from "../../src/outlook-scope.js";
import { resolveCalendarUrl } from "../../src/calendar-resolve.js";
import type { CalendarAccessLevel } from "../../src/calendar-scope.js";

export { default } from "../../src/microsoft.js";
export * from "../../src/microsoft.js";
import {
  GatekeeperUserImpl, MicrosoftVerifier, OutlookGatekeeper, OutlookHookController as ProductionHookController,
} from "../../src/microsoft.js";

/**
 * The account entrypoint, reachable for tests. Under the capnweb-validate *vite* plugin, which
 * applies `@validateRpc()` in memory here, decorated `WorkerEntrypoint` exports are not registered in
 * `ctx.exports`; the production build registers them. An undecorated subclass registers, and
 * inherits the production behaviour exactly.
 */
export class TestUser extends GatekeeperUserImpl {}

/** The verifier entrypoint, reachable for tests -- see `TestUser`. */
export class TestVerifier extends MicrosoftVerifier {}

/** The hook controller the facet mints, registered for tests -- see `TestUser`. Shadows the star export. */
export class OutlookHookController extends ProductionHookController {}

type DeliveryProps = { hooks: string; facet: string; props: OutlookGatekeeperProps };

/**
 * Stands in for the stub the facet mints with `ctx.restore()`, which this pool can't make (its
 * Durable Object wrappers don't forward `[restore]`): it reaches the facet's real `[restore]`
 * target through TestHooks.
 */
export class TestOutlookHookDelivery extends WorkerEntrypoint<Cloudflare.Env, DeliveryProps> {
  deliver(callback: RpcStub<RpcTarget>, approvalQueue: RpcStub<RpcTarget>, messageId: string) {
    const { hooks, facet, props } = this.ctx.props;
    const exports = this.ctx.exports as unknown as { TestHooks: DurableObjectNamespace<TestHooks> };
    return exports.TestHooks.get(exports.TestHooks.idFromString(hooks)).outlookDeliver(facet, props, callback, approvalQueue, messageId);
  }
}

type TestOutlook = OutlookGatekeeper & {
  testRestoreThrough(hooks: string, facet: string, props: OutlookGatekeeperProps): void;
  testDeliver(callback: RpcStub<RpcTarget>, approvalQueue: RpcStub<RpcTarget>, messageId: string): Promise<void>;
};
const testOutlook = OutlookGatekeeper.prototype as TestOutlook;

/** Makes this facet's `ctx.restore()` mint TestOutlookHookDelivery stubs that route back to `[restore]`. */
testOutlook.testRestoreThrough = function(hooks, facet, props) {
  const { ctx } = this as unknown as { ctx: DurableObjectState & { restore(params: unknown): Promise<unknown> } };
  const exports = ctx.exports as unknown as { TestOutlookHookDelivery(options: { props: DeliveryProps }): Fetcher };
  ctx.restore = async () => Object.assign(exports.TestOutlookHookDelivery({ props: { hooks, facet, props } }), { [Symbol.dispose]() {} });
};

testOutlook.testDeliver = function(callback, approvalQueue, messageId) {
  return this[restore]({}).deliver(callback as never, approvalQueue as never, messageId);
};

/** What hooks were called with, by the key their subscription was made under. */
const hookDeliveries = new Map<string, { subject: string; id: string; markdown?: string; error?: string }[]>();

/** An agent's new-message hook: records each message, and reads it through the session it was handed. */
class RecordingHook extends RpcTarget {
  constructor(private readonly key: string) {
    super();
  }

  async receiveMessage(entry: { message: { id: string; subject: string }; mail: Callable }): Promise<void> {
    const delivered = hookDeliveries.get(this.key) ?? [];
    hookDeliveries.set(this.key, delivered);
    try {
      const content = await entry.mail.readMessage!(entry.message.id) as { markdown: string };
      delivered.push({ subject: entry.message.subject, id: entry.message.id, markdown: content.markdown });
    } catch (error) {
      delivered.push({ subject: entry.message.subject, id: entry.message.id, error: String(error) });
    } finally {
      entry.mail[Symbol.dispose]?.();
    }
  }
}

/** The Workshop's side of a hook firing: a new session's queue, and the hook the agent bound. */
export class TestInitiator extends WorkerEntrypoint<Cloudflare.Env, { key: string }> {
  async startHook(): Promise<{ callback: RecordingHook; approvalQueue: RecordingQueue }> {
    return { callback: new RecordingHook(this.ctx.props.key), approvalQueue: new RecordingQueue() };
  }
}

export type GatekeeperProps = SharePointGatekeeperProps;
/** Any resource's binding props: an Outlook scope names a mailbox, and only a Calendar scope carries its access. */
export type AnyGatekeeperProps = SharePointGatekeeperProps | OutlookGatekeeperProps | CalendarGatekeeperProps;

type UserProps = { userObjectId: string };

type TestExports = {
  SharePointGatekeeper(options: { props: SharePointGatekeeperProps }): DurableObjectClass;
  OutlookGatekeeper(options: { props: OutlookGatekeeperProps }): DurableObjectClass;
  CalendarGatekeeper(options: { props: CalendarGatekeeperProps }): DurableObjectClass;
  TestUser(options: { props: UserProps }): Record<string, (...args: unknown[]) => Promise<unknown>>;
  TestVerifier(options: { props: UserProps }): Record<string, (...args: unknown[]) => Promise<unknown>>;
  TestCallback(options: { props: UserProps }): Fetcher<GatekeeperConnectCallback>;
  TestInitiator(options: { props: { key: string } }): Fetcher;
};

/** A stand-in for the Workshop's connect callback, persistent as the Workshop's own is. */
export class TestCallback extends WorkerEntrypoint<Cloudflare.Env, UserProps> {
  async credentialsExpired(): Promise<void> {
    expiredNotices.set(this.ctx.props.userObjectId, (expiredNotices.get(this.ctx.props.userObjectId) ?? 0) + 1);
  }

  /** A reconnect's handoff carries its stage id as the ticket, so a test can commit that stage. */
  async reconnectComplete(stageId: string): Promise<ConnectHandoff> {
    return { targetOrigin: "http://localhost:8787", ticket: stageId };
  }

  async complete(): Promise<ConnectHandoff> {
    return { targetOrigin: "http://localhost:8787", ticket: "first-connect" };
  }
}

const expiredNotices = new Map<string, number>();

/** An approval queue that records what it is asked, and refuses observations it is told to. */
export class RecordingQueue extends RpcTarget {
  readonly submitted: Array<{ actionId: number; description: ActionDescription }> = [];
  readonly observations: ObservationDescription[] = [];
  refuseObservations = false;

  async submitAction(actionId: number, description: ActionDescription): Promise<void> {
    this.submitted.push({ actionId, description });
  }

  readonly hooks: Array<{ description: { title: string; description: string } }> = [];
  readonly controllers: { enable(initiator: unknown, target: unknown): Promise<void>; disable(): Promise<void> }[] = [];

  async bindHook(controller: RecordingQueue["controllers"][number], _callback: unknown, description: { title: string; description: string }): Promise<void> {
    this.hooks.push({ description });
    this.controllers.push(controller);
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    if (this.refuseObservations) throw new Error("The approval queue refused this observation.");
    this.observations.push(description);
  }
}

/** A forwarded call's result as plain data: an expected rejection crossing RPC also reports as unhandled. */
export type Outcome<T> = { ok: T } | { error: string };

async function outcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** One call in a scenario: a method and its arguments. */
export type Step = [method: string, ...args: unknown[]];

type Callable = Record<string, (...args: unknown[]) => Promise<unknown>> & Partial<Disposable>;

type GatekeeperFacet = {
  describe(): Promise<unknown>;
  getAutoApprovableActions(): Promise<unknown>;
  startSession(queue: RecordingQueue): Promise<Callable>;
  applyAction(actionId: number, cache: RpcTarget): Promise<void>;
  rejectAction(actionId: number): Promise<unknown>;
  revertAction(actionId: number): Promise<unknown>;
  addObserver(id: string, verifier: unknown): Promise<void>;
  removeObserver(id: string): Promise<void>;
};

class NullGitCache extends RpcTarget {}

export class TestHooks extends DurableObject<Cloudflare.Env> {
  #queues = new Map<string, RecordingQueue>();

  get #exports(): TestExports {
    return this.ctx.exports as unknown as TestExports;
  }

  /**
   * The gatekeeper facet named `facetName`, made with `props` on first use. A facet is cached per
   * name, storage and all, so each scenario takes a fresh name.
   */
  #gatekeeper(facetName: string, props: AnyGatekeeperProps): GatekeeperFacet {
    return this.ctx.facets.get(facetName, () => ({
      class: "mailbox" in props.scope
        ? this.#exports.OutlookGatekeeper({ props: props as OutlookGatekeeperProps })
        : "access" in props.scope
          ? this.#exports.CalendarGatekeeper({ props: props as CalendarGatekeeperProps })
          : this.#exports.SharePointGatekeeper({ props: props as SharePointGatekeeperProps }),
    })) as unknown as GatekeeperFacet;
  }

  #queue(facetName: string): RecordingQueue {
    let queue = this.#queues.get(facetName);
    if (!queue) this.#queues.set(facetName, queue = new RecordingQueue());
    return queue;
  }

  /**
   * Opens a session and makes each call in `steps` on what the call before returned, starting with
   * the session. The last call's result comes back; with `pages`, it is a cursor, walked for at most
   * that many pages.
   */
  async run(facetName: string, props: AnyGatekeeperProps, steps: Step[], options: { pages?: number } = {}):
      Promise<Outcome<unknown>> {
    return await outcome(async () => {
      const session = await this.#gatekeeper(facetName, props).startSession(this.#queue(facetName));
      try {
        let target: Callable = session;
        for (const [index, [method, ...args]] of steps.entries()) {
          const result = await target[method](...args);
          if (index === steps.length - 1) {
            if (options.pages === undefined) return result;
            const cursor = result as { next(): Promise<unknown[] | null> };
            const pages: unknown[][] = [];
            for (let page; pages.length < options.pages && (page = await cursor.next()) !== null;) pages.push(page);
            return pages;
          }
          target = result as Callable;
        }
        return undefined;
      } finally {
        session[Symbol.dispose]?.();
      }
    });
  }

  /** Starts one session and makes every call on it at once, answering each call's own outcome. */
  async runTogether(facetName: string, props: AnyGatekeeperProps, calls: Step[]): Promise<Outcome<unknown>[]> {
    const session = await this.#gatekeeper(facetName, props).startSession(this.#queue(facetName));
    try {
      return await Promise.all(calls.map(([method, ...args]) => outcome(() => session[method](...args))));
    } finally {
      session[Symbol.dispose]?.();
    }
  }

  /** What the facet's approval queue has recorded. */
  queueLog(facetName: string): { submitted: RecordingQueue["submitted"]; observations: RecordingQueue["observations"]; hooks: RecordingQueue["hooks"] } {
    const queue = this.#queue(facetName);
    return { submitted: queue.submitted, observations: queue.observations, hooks: queue.hooks };
  }

  /**
   * Subscribes a recording hook through a session, then enables it as the Workshop does once the
   * user approves. Deliveries are recorded under `key`.
   */
  async subscribe(facetName: string, props: AnyGatekeeperProps, key: string): Promise<Outcome<void>> {
    return await outcome(async () => {
      const queue = this.#queue(facetName);
      const gatekeeper = this.#gatekeeper(facetName, props);
      await (gatekeeper as unknown as TestOutlook).testRestoreThrough(this.ctx.id.toString(), facetName, props as OutlookGatekeeperProps);
      const session = await gatekeeper.startSession(queue);
      try {
        await session.subscribeNewMessages!(new RecordingHook(key));
      } finally {
        session[Symbol.dispose]?.();
      }
      const controller = queue.controllers.at(-1);
      if (!controller) throw new Error("the session bound no hook");
      await controller.enable(this.#exports.TestInitiator({ props: { key } }), { workspaceId: "test-workspace" });
    });
  }

  /** Disables the last hook a facet bound, as removing it in the Workshop does. */
  async unsubscribe(facetName: string): Promise<Outcome<void>> {
    return await outcome(async () => this.#queue(facetName).controllers.at(-1)!.disable());
  }

  async outlookDeliver(facetName: string, props: OutlookGatekeeperProps, callback: RpcStub<RpcTarget>, approvalQueue: RpcStub<RpcTarget>, messageId: string): Promise<void> {
    await (this.#gatekeeper(facetName, props) as unknown as TestOutlook).testDeliver(callback, approvalQueue, messageId);
  }

  hookDeliveries(key: string): { subject: string; id: string; markdown?: string; error?: string }[] {
    return hookDeliveries.get(key) ?? [];
  }

  refuseObservations(facetName: string, refuse: boolean): void {
    this.#queue(facetName).refuseObservations = refuse;
  }

  async describe(facetName: string, props: AnyGatekeeperProps): Promise<Outcome<unknown>> {
    return await outcome(() => this.#gatekeeper(facetName, props).describe());
  }

  async autoApprovable(facetName: string, props: AnyGatekeeperProps): Promise<Outcome<unknown>> {
    return await outcome(() => this.#gatekeeper(facetName, props).getAutoApprovableActions());
  }

  async applyAction(facetName: string, props: AnyGatekeeperProps, actionId: number): Promise<Outcome<void>> {
    return await outcome(() => this.#gatekeeper(facetName, props).applyAction(actionId, new NullGitCache()));
  }

  async rejectAction(facetName: string, props: AnyGatekeeperProps, actionId: number): Promise<Outcome<unknown>> {
    return await outcome(() => this.#gatekeeper(facetName, props).rejectAction(actionId));
  }

  async revertAction(facetName: string, props: AnyGatekeeperProps, actionId: number): Promise<Outcome<unknown>> {
    return await outcome(() => this.#gatekeeper(facetName, props).revertAction(actionId));
  }

  /** `addObserver` with a verifier minted for `observerUserObjectId`'s account. */
  async addObserver(facetName: string, props: AnyGatekeeperProps, observerId: string, observerUserObjectId: string):
      Promise<Outcome<void>> {
    const verifier = this.#exports.TestVerifier({ props: { userObjectId: observerUserObjectId } });
    return await outcome(() => this.#gatekeeper(facetName, props).addObserver(observerId, verifier));
  }

  async removeObserver(facetName: string, props: AnyGatekeeperProps, observerId: string): Promise<Outcome<void>> {
    return await outcome(() => this.#gatekeeper(facetName, props).removeObserver(observerId));
  }

  /** Restarts the gatekeeper, as an eviction would: its storage stays, its memory does not. */
  restart(facetName: string): void {
    this.ctx.facets.abort(facetName, new Error("test restart"));
  }

  // -- configurator -----------------------------------------------------------------------

  /** Calls `method` on a configurator capability for `userObjectId`, as the frame would. */
  async configurator(userObjectId: string, access: SharePointAccess, method: string, ...args: unknown[]):
      Promise<Outcome<unknown>> {
    const ui = new SharePointConfiguratorUI(this.ctx.exports, userObjectId, access) as unknown as Callable;
    return await outcome(() => ui[method](...args));
  }

  // -- Graph, as an account ---------------------------------------------------------------

  /** The scope a URL names, resolved as `getGatekeeperClassFor` resolves it. */
  async resolve(userObjectId: string, url: string): Promise<Outcome<unknown>> {
    return await outcome(async () => {
      const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
      const tenant = (await account.getIdentity()).sharePointTenant;
      if (tenant === undefined) throw new Error("no SharePoint");
      return await accountSource(this.ctx.exports, userObjectId)
        .run(creds => resolveSharePointUrl(new GraphApi(creds.accessToken), url, tenant), { replayable: true });
    });
  }

  /** An Outlook URL's scope, resolved as `getGatekeeperClassFor` resolves it. */
  async resolveOutlook(userObjectId: string, url: string, ceiling: OutlookAccessLevel = "send"): Promise<Outcome<unknown>> {
    return await outcome(async () => {
      const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
      const identity = await account.getIdentity();
      return await accountSource(this.ctx.exports, userObjectId)
        .run(creds => resolveOutlookUrl(new GraphApi(creds.accessToken), url, ceiling, identity.email ?? identity.username ?? "", identity.objectId), { replayable: true });
    });
  }

  /** A Calendar URL's scope, resolved as `getGatekeeperClassFor` resolves it. */
  async resolveCalendar(userObjectId: string, url: string, ceiling: CalendarAccessLevel = "schedule"): Promise<Outcome<unknown>> {
    return await outcome(async () => {
      const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
      const identity = await account.getIdentity();
      return await accountSource(this.ctx.exports, userObjectId)
        .run(creds => resolveCalendarUrl(new GraphApi(creds.accessToken), url, ceiling, identity.email ?? identity.username ?? ""), { replayable: true });
    });
  }

  /** One Graph request as the account, for a test's own setup and cleanup. */
  async graph(userObjectId: string, method: string, path: string, body?: unknown): Promise<Outcome<unknown>> {
    return await outcome(() => accountSource(this.ctx.exports, userObjectId)
      .run(creds => new GraphApi(creds.accessToken).request(method, path, { ...(body === undefined ? {} : { body }), allow: [404] }),
        { replayable: method === "GET" }));
  }

  /**
   * A file as Microsoft 365 renders it to PDF, as the account: proof Office for the web opens it.
   * Returns the PDF's size and page count, not its bytes.
   */
  async renderPdf(userObjectId: string, driveId: string, itemId: string): Promise<Outcome<{ size: number; pages: number }>> {
    return await outcome(() => accountSource(this.ctx.exports, userObjectId).run(async creds => {
      const pdf = await new GraphApi(creds.accessToken).download(`/drives/${driveId}/items/${itemId}/content`, 50 * 1024 * 1024, { format: "pdf" });
      const text = new TextDecoder("latin1").decode(pdf.bytes);
      if (!text.startsWith("%PDF-")) throw new Error("Microsoft 365 didn't return a PDF");
      return { size: pdf.bytes.byteLength, pages: text.match(/\/Type\s*\/Page[^s]/g)?.length ?? 0 };
    }, { replayable: true }));
  }

  // -- account ----------------------------------------------------------------------------

  /** Gives the account a Workshop callback and an initiation nonce, as `connectAccount` does. */
  async installCallback(userObjectId: string, initiationNonce: string, scopes: string[]): Promise<void> {
    const callback = this.#exports.TestCallback({ props: { userObjectId } });
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    await account.setCallback(callback, initiationNonce, scopes);
  }

  expiredNotices(userObjectId: string): number {
    return expiredNotices.get(userObjectId) ?? 0;
  }

  /** Calls `method` on the account entrypoint for `userObjectId`. */
  async user(userObjectId: string, method: string, ...args: unknown[]): Promise<Outcome<unknown>> {
    return await outcome(() => this.#exports.TestUser({ props: { userObjectId } })[method](...args));
  }

  /** Calls `method` on the verifier for `userObjectId`. */
  async verifier(userObjectId: string, method: string, ...args: unknown[]): Promise<Outcome<unknown>> {
    return await outcome(() => this.#exports.TestVerifier({ props: { userObjectId } })[method](...args));
  }

  /** Calls `method` on the account Durable Object, failures carried back as data. */
  async account(userObjectId: string, method: string, ...args: unknown[]): Promise<Outcome<unknown>> {
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    return await outcome(() => (account as unknown as Callable)[method](...args));
  }
}
