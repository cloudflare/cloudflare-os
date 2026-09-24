import {
  DurableObject, restore, RpcStub, RpcTarget, WorkerEntrypoint,
} from "cloudflare:workers";
import type {
  ActionDescription,
  ApprovalQueue,
  GitCache,
  HookController,
  HookDescription,
  HookInitiator,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { WebhookEvent } from "../src/types.js";
import type { WebhookCredential, WebhookHook, WebhookSession } from "../src/types.js";
import { WebhookGatekeeper } from "../src/webhook.js";

type TestEnv = Cloudflare.Env & {
  TEST_GADGET: DurableObjectNamespace<TestGadget>;
  TEST_WORKSHOP: DurableObjectNamespace<TestWorkshop>;
  WEBHOOK_RECEIVER: DurableObjectNamespace<import("../src/webhook.js").WebhookReceiver>;
};

// The Workers test pool proxies Durable Objects through a wrapper that only forwards string keys.
// Bridge the restore symbol to the real instance, matching Workshop's own workerd test harness.
const restoreTargets = new WeakMap<DurableObjectState, DurableObject>();
function bridgedRestore(this: DurableObject, params: unknown): unknown {
  const target = restoreTargets.get(this.ctx) as {
    [restore]?: (value: unknown) => unknown;
  } | undefined;
  if (target?.[restore] === undefined || target[restore] === bridgedRestore) {
    throw new TypeError("This Durable Object does not implement a [restore]() method.");
  }
  return target[restore](params);
}
(DurableObject.prototype as unknown as Record<symbol, unknown>)[restore] = bridgedRestore;

export { default } from "../src/webhook.js";
export * from "../src/webhook.js";
export { WebhookGatekeeper, WebhookHookController } from "../src/webhook.js";

type TestMode = "success" | "start-reject" | "authorization-reject" | "callback-reject";
let mode: TestMode = "success";
let events: string[] = [];
let deliveries: WebhookEvent[] = [];
let disposedCallbacks = 0;
let disposedQueues = 0;
let callbackBarrier: Promise<void> | undefined;
let releaseBlockedCallback: (() => void) | undefined;
let markCallbackBlocked: (() => void) | undefined;
let callbackBlocked: Promise<void> = Promise.resolve();

class TestApprovalQueue extends RpcTarget {
  #markDisposed!: () => void;
  readonly disposed = new Promise<void>(resolve => { this.#markDisposed = resolve; });
  async authorizeObservation(): Promise<void> {
    events.push("authorize");
    if (mode === "authorization-reject") throw new Error("authorization rejected");
  }
  [Symbol.dispose](): void { disposedQueues++; this.#markDisposed(); }
}

class TestCallback extends RpcTarget {
  #markDisposed!: () => void;
  readonly disposed = new Promise<void>(resolve => { this.#markDisposed = resolve; });
  async onWebhook(event: WebhookEvent): Promise<void> {
    events.push("callback");
    deliveries.push(event);
    if (callbackBarrier) {
      markCallbackBlocked?.();
      await callbackBarrier;
    }
    if (mode === "callback-reject") throw new Error("callback rejected");
  }
  [Symbol.dispose](): void { disposedCallbacks++; this.#markDisposed(); }
}

/** Real HookInitiator entrypoint used by receiver lifecycle tests. */
export class TestHooks extends WorkerEntrypoint {
  async startHook(): Promise<{ callback: TestCallback; approvalQueue: TestApprovalQueue }> {
    events.push("start");
    if (mode === "start-reject") throw new Error("start rejected");
    const callback = new TestCallback();
    const approvalQueue = new TestApprovalQueue();
    this.ctx.waitUntil(Promise.race([
      Promise.all([callback.disposed, approvalQueue.disposed]),
      new Promise(resolve => setTimeout(resolve, 2_000)),
    ]).then(() => undefined));
    return { callback, approvalQueue };
  }
  configure(next: TestMode): void { mode = next; }
  blockCallback(): void {
    callbackBlocked = new Promise(resolve => { markCallbackBlocked = resolve; });
    callbackBarrier = new Promise(resolve => {
      releaseBlockedCallback = resolve;
    });
  }
  waitUntilCallbackBlocked(): Promise<void> { return callbackBlocked; }
  releaseCallback(): void {
    releaseBlockedCallback?.();
    callbackBarrier = undefined;
    releaseBlockedCallback = undefined;
    markCallbackBlocked = undefined;
  }
  read() { return { events: [...events], deliveries: [...deliveries], disposedCallbacks, disposedQueues }; }
  reset(): void {
    mode = "success";
    events = [];
    deliveries = [];
    disposedCallbacks = 0;
    disposedQueues = 0;
    releaseBlockedCallback?.();
    callbackBarrier = undefined;
    releaseBlockedCallback = undefined;
    markCallbackBlocked = undefined;
    callbackBlocked = Promise.resolve();
  }
}

type BoundWebhook = {
  controller: Fetcher<HookController<RpcTarget & WebhookHook>>;
  callback: RpcStub<RpcTarget & WebhookHook>;
};

class GadgetWebhookCallback extends RpcTarget implements WebhookHook {
  constructor(private readonly storage: DurableObjectStorage) { super(); }
  async onWebhook(event: WebhookEvent): Promise<void> {
    const deliveries = await this.storage.get<WebhookEvent[]>("deliveries") ?? [];
    await this.storage.put("deliveries", [...deliveries, event]);
  }
}

/** A real Gadget callback restored by the Workers runtime. */
export class TestGadget extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    restoreTargets.set(ctx, this);
  }
  createWebhookCallback(): RpcStub<WebhookHook> {
    return this.ctx.restore({ type: "webhook" });
  }
  [restore](params: unknown): GadgetWebhookCallback {
    if (!(params && typeof params === "object" && "type" in params && params.type === "webhook")) {
      throw new TypeError("Unknown restore parameters");
    }
    return new GadgetWebhookCallback(this.ctx.storage);
  }
  async readDeliveries(): Promise<WebhookEvent[]> {
    return await this.ctx.storage.get<WebhookEvent[]>("deliveries") ?? [];
  }
}

class WorkshopApprovalQueue extends RpcTarget implements ApprovalQueue {
  constructor(private readonly workshop: DurableObjectStub<TestWorkshop>) { super(); }
  authorizeObservation(description: ObservationDescription): Promise<void> {
    return this.workshop.authorizeObservation(description);
  }
  bindHook<Hook extends RpcTarget>(
    controller: Fetcher<HookController<Hook>>,
    callback: RpcStub<Hook>,
    _description: HookDescription,
  ): Promise<void> {
    return this.workshop.bindWebhook(
      controller as Fetcher<HookController<RpcTarget & WebhookHook>>,
      callback as RpcStub<RpcTarget & WebhookHook>,
    );
  }
  getGitCache(): Promise<GitCache> { throw new Error("Unexpected Git cache request"); }
  submitAction(_id: number, _description: ActionDescription): Promise<void> {
    throw new Error("Unexpected action submission");
  }
}

/** Minimal Workshop hook machinery exercising the production ApprovalQueue/HookInitiator contract. */
export class TestWorkshop extends DurableObject<TestEnv>
  implements HookInitiator<RpcTarget & WebhookHook> {
  async configure(endpointId: string): Promise<WebhookCredential> {
    if (!(await this.env.WEBHOOK_RECEIVER.getByName(endpointId)
      .claim("integration-account", endpointId))) {
      throw new Error("Could not claim integration webhook endpoint");
    }
    const gadget = this.env.TEST_GADGET.getByName("integration-gadget");
    const callback = await gadget.createWebhookCallback();
    const props = {
      accountId: "integration-account", endpointId, label: "Integration webhook",
    };
    // The pool cannot start a props-bearing facet from a test-only DO. Give the real gatekeeper
    // class this DO's branded context while overriding only the props its session reads.
    const gatekeeperContext = new Proxy(this.ctx, {
      get(target, property) {
        if (property === "props") return props;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DurableObjectState<typeof props>;
    const gatekeeper = new WebhookGatekeeper(
      this.ctx as unknown as DurableObjectState<typeof props>, this.env,
    );
    Object.defineProperty(gatekeeper, "ctx", { value: gatekeeperContext });
    const queue = new RpcStub<ApprovalQueue>(new WorkshopApprovalQueue(
      this.env.TEST_WORKSHOP.get(this.ctx.id),
    ));
    using session = await gatekeeper.startSession(queue) as WebhookSession & Disposable;
    await session.subscribe(callback);
    const credential = await session.issueCredential();
    const bound = this.ctx.storage.kv.get<BoundWebhook>("bound");
    if (!bound) throw new Error("Webhook subscription was not bound");
    try {
      await bound.controller.enable(
        this.ctx.exports.TestWorkshopInitiator({ props: { workshopId: this.ctx.id.toString() } }),
        { workspaceId: "integration-workspace", gadgetId: 1 },
      );
    } finally {
      (bound.controller as Fetcher<HookController<RpcTarget & WebhookHook>> &
        Partial<Disposable>)[Symbol.dispose]?.();
      (bound.callback as RpcStub<RpcTarget & WebhookHook> &
        Partial<Disposable>)[Symbol.dispose]?.();
    }
    return credential;
  }
  async bindWebhook(
    controller: Fetcher<HookController<RpcTarget & WebhookHook>>,
    callback: RpcStub<RpcTarget & WebhookHook>,
  ): Promise<void> {
    this.ctx.storage.kv.put<BoundWebhook>("bound", { controller, callback });
  }
  async startHook(): Promise<{
    callback: RpcStub<RpcTarget & WebhookHook>;
    approvalQueue: RpcStub<ApprovalQueue>;
  }> {
    const bound = this.ctx.storage.kv.get<BoundWebhook>("bound");
    if (!bound) throw new Error("Webhook subscription is missing");
    this.ctx.storage.kv.put("startCount", (this.ctx.storage.kv.get<number>("startCount") ?? 0) + 1);
    return {
      callback: bound.callback,
      approvalQueue: new RpcStub<ApprovalQueue>(new WorkshopApprovalQueue(
        this.env.TEST_WORKSHOP.get(this.ctx.id),
      )),
    };
  }
  async authorizeObservation(_description: ObservationDescription): Promise<void> {
    this.ctx.storage.kv.put(
      "authorizationCount",
      (this.ctx.storage.kv.get<number>("authorizationCount") ?? 0) + 1,
    );
  }
  read(): { startCount: number; authorizationCount: number } {
    return {
      startCount: this.ctx.storage.kv.get<number>("startCount") ?? 0,
      authorizationCount: this.ctx.storage.kv.get<number>("authorizationCount") ?? 0,
    };
  }
}

export class TestWorkshopInitiator extends WorkerEntrypoint<
  TestEnv,
  { workshopId: string }
> implements HookInitiator<RpcTarget & WebhookHook> {
  startHook() {
    return this.env.TEST_WORKSHOP.get(
      this.env.TEST_WORKSHOP.idFromString(this.ctx.props.workshopId),
    ).startHook();
  }
}
