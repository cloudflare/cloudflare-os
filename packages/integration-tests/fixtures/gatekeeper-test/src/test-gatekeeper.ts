// A real gatekeeper Worker whose verification outcomes the tests decide.
//
// WHY THIS EXISTS. The overseer tests need a gatekeeper that will refuse to admit an observer on
// command. Every shipping public gatekeeper can do that only at a cost that would dominate the test:
// the OAuth ones need a whole vendor's auth surface mocked before an account exists at all, and the
// Context Library only refuses once an observation has been *recorded*, which takes a gadget read
// session (so a Worker Loader) or a slash-command invocation. It is also a singleton, so it can never
// produce the two simultaneously-failing bindings one of these cases needs.
//
// So the overseer's own logic -- collect every failure, re-prompt once, then name what failed -- is
// tested against this fixture, where an outcome is one HTTP call away. Realism about a *particular*
// vendor is a different question, answered the way a per-vendor suite answers it: run the real
// gatekeeper unmodified and mock the vendor's external surfaces through a NetworkInterceptor handler
// module. This file deliberately does not try to be that.
//
// Note what the fixture does NOT model: a settled denial ("you may not read this") and an operational
// failure ("the credential expired") reach the overseer identically, as a thrown error, and the
// overseer cannot tell them apart -- by design, since it treats every failure as repairable. So there
// is one control knob here, `allow`, and the reason string is what carries the distinction to the
// user. Tests exercise both narratives by choosing reason text.

import {
  DurableObject, RpcTarget, WorkerEntrypoint, restore, type RpcStub,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { connectHandoffPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import type {
  AccountDescription, ActionDescription, ActionKind, AgentCatalog, ApprovalQueue, ConnectHandoff,
  Gatekeeper, GatekeeperConnectCallback, GatekeeperUser, GatekeeperUserVerifier, HookController,
  HookInitiator, HookTargetMetadata, ResourceDescription, ResourceConfiguratorFrame,
  SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type {
  ChatGatewayRpcTarget, GadgetResponse, SubmitExternalMessageInput, SubmitExternalMessageResult,
} from "@gadgets/workshop-shared/external-message-gateway";

// Nothing but classes and the default handler may be exported from a Worker entry module: workerd
// treats every named export as an entrypoint and rejects anything that isn't one.
const VENDOR_HOST = "gadgets-test.example";

const SUPPORTED_RESOURCES: SupportedResource[] = [{
  urlPattern: `https://${VENDOR_HOST}/things/*`,
  title: "Test Thing",
  description: "A resource that exists only so tests can bind something.",
  creatable: true,
}];

const TYPES_CODE = `
/** A stand-in resource whose reads and writes are deterministic and audited. */
interface TestThing {
  readValue(): Promise<number>;
  writeValue(value: number): Promise<number>;
  writeValues(values: number[]): Promise<number[]>;
  /** Binds a hook the integration test fires through \`/control/fire-hook\`. */
  watch(key: string, callback: ValueHook): Promise<void>;
}
interface ValueHook {
  onValueRequested(value: number): Promise<void>;
}
`;

// A 1x1 transparent GIF, so nothing here reaches for a network asset.
const AVATAR = {
  url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
};

// ---------------------------------------------------------------------------
// Control state.
//
// Keyed by account label, which is the identity the verifier reports and the same string the Workshop
// shows the user -- so a test that read a label off `description.uniqueName` can aim an outcome at it
// without having to learn any internal id.

type VerifyOutcome = { allow: true } | { allow: false; reason: string };

/**
 * One addObserver()/removeObserver() call, mirrored here as it happens: the gatekeeper is a facet
 * under the gadget's Overseer, unreachable from this worker's routes, and a log (not a boolean)
 * also pins the add/remove ordering.
 */
type ObserverEvent = { resourceUrl: string; type: "add" | "remove"; id: string };

type PendingTestAction = { id: number; value: number };
type TestActionState = {
  nextId: number;
  pending: PendingTestAction[];
  value?: number;
  applyCount: number;
};

type HookState = {
  initiator?: Fetcher<HookInitiator<ValueHook>>;
  target?: HookTargetMetadata;
  disableCount: number;
};

function outcomeKey(label: string, resourceUrl?: string): string {
  return resourceUrl ? `outcome:${label}:${resourceUrl}` : `outcome:${label}`;
}

function newAccountLabel(): string {
  return `test-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}@${VENDOR_HOST}`;
}

@validateRpc()
export class TestControl extends DurableObject<Cloudflare.Env> {
  setVerifyOutcome(label: string, outcome: VerifyOutcome, resourceUrl?: string): void {
    this.ctx.storage.kv.put(outcomeKey(label, resourceUrl), outcome);
  }

  getVerifyOutcome(label: string, resourceUrl?: string): VerifyOutcome {
    // A resource-specific outcome wins over a label-wide one. Default to admitting: a
    // collaborator's first open has to be able to succeed.
    return this.ctx.storage.kv.get<VerifyOutcome>(outcomeKey(label, resourceUrl))
        ?? this.ctx.storage.kv.get<VerifyOutcome>(outcomeKey(label))
        ?? { allow: true };
  }

  recordObserverEvent(event: ObserverEvent): void {
    const events = this.ctx.storage.kv.get<ObserverEvent[]>("observer-events") ?? [];
    events.push(event);
    this.ctx.storage.kv.put("observer-events", events);
  }

  /** Filtered here rather than in the test: tests run concurrently against one shared log. */
  getObserverEvents(resourceUrl: string): ObserverEvent[] {
    return (this.ctx.storage.kv.get<ObserverEvent[]>("observer-events") ?? [])
        .filter(e => e.resourceUrl === resourceUrl);
  }

  recordAmbientVerification(label: string): void {
    const key = `ambient-verifications:${label}`;
    this.ctx.storage.kv.put(key, (this.ctx.storage.kv.get<number>(key) ?? 0) + 1);
  }

  getAmbientVerificationCount(label: string): number {
    return this.ctx.storage.kv.get<number>(`ambient-verifications:${label}`) ?? 0;
  }

  recordRevocation(label: string): void {
    const key = `revocations:${label}`;
    this.ctx.storage.kv.put(key, (this.ctx.storage.kv.get<number>(key) ?? 0) + 1);
  }

  getRevocationCount(label: string): number {
    return this.ctx.storage.kv.get<number>(`revocations:${label}`) ?? 0;
  }

  getActionState(label: string): TestActionState {
    return this.ctx.storage.kv.get<TestActionState>(`actions:${label}`) ?? {
      nextId: 1,
      pending: [],
      applyCount: 0,
    };
  }

  stageAction(label: string, value: number): number {
    const state = this.getActionState(label);
    const id = state.nextId++;
    state.pending.push({ id, value });
    this.ctx.storage.kv.put(`actions:${label}`, state);
    return id;
  }

  discardAction(label: string, id: number): void {
    const state = this.getActionState(label);
    state.pending = state.pending.filter(action => action.id !== id);
    this.ctx.storage.kv.put(`actions:${label}`, state);
  }

  applyAction(label: string, id: number): void {
    const state = this.getActionState(label);
    const action = state.pending.find(candidate => candidate.id === id);
    if (action === undefined) throw new Error(`Unknown pending test action ${id}`);
    state.pending = state.pending.filter(candidate => candidate.id !== id);
    state.value = action.value;
    state.applyCount++;
    this.ctx.storage.kv.put(`actions:${label}`, state);
  }

  /** Moves a simulated thing's staged actions to the account it was created in. */
  adoptActions(from: string, to: string): void {
    const source = this.getActionState(from);
    const state = this.getActionState(to);
    state.pending.push(...source.pending);
    state.nextId = Math.max(state.nextId, source.nextId);
    this.ctx.storage.kv.put(`actions:${to}`, state);
    this.ctx.storage.kv.delete(`actions:${from}`);
  }

  failNextApply(label: string, reason: string): void {
    this.ctx.storage.kv.put(`fail-next-apply:${label}`, reason);
  }

  /** Returns rather than throws, so consuming the failure commits. */
  takeApplyFailure(label: string): string | null {
    const key = `fail-next-apply:${label}`;
    const reason = this.ctx.storage.kv.get<string>(key);
    if (reason === undefined) return null;
    this.ctx.storage.kv.delete(key);
    return reason;
  }

  recordApplyAttempt(label: string): void {
    this.ctx.storage.kv.put(`apply-attempts:${label}`, this.getApplyAttempts(label) + 1);
  }

  /** Every applyAction() call, including ones that then fail: a double dispatch shows up here. */
  getApplyAttempts(label: string): number {
    return this.ctx.storage.kv.get<number>(`apply-attempts:${label}`) ?? 0;
  }

  /** Parks the next applyAction() for `label` until releaseApply(), so a test can race another. */
  holdNextApply(label: string): void {
    this.ctx.storage.kv.put(`hold-next-apply:${label}`, true);
    this.ctx.storage.kv.delete(`release-apply:${label}`);
  }

  /** One-shot, like takeApplyFailure(). */
  takeNextApplyHold(label: string): boolean {
    return this.ctx.storage.kv.delete(`hold-next-apply:${label}`);
  }

  releaseApply(label: string): void {
    this.ctx.storage.kv.put(`release-apply:${label}`, true);
  }

  isApplyReleased(label: string): boolean {
    return this.ctx.storage.kv.get<boolean>(`release-apply:${label}`) ?? false;
  }

  enableHook(
      key: string, initiator: Fetcher<HookInitiator<ValueHook>>, target: HookTargetMetadata): void {
    this.ctx.storage.kv.put(`hook:${key}`, { ...this.#hook(key), initiator, target });
  }

  /**
   * Keeps the initiator, like a gatekeeper that ignores disable(), so `/control/fire-hook` probes
   * the Workshop's own startHook() re-check, which live firings rely on.
   */
  recordHookDisable(key: string): void {
    const hook = this.#hook(key);
    this.ctx.storage.kv.put(`hook:${key}`, { ...hook, disableCount: hook.disableCount + 1 });
  }

  getHookState(key: string) {
    const { initiator, target, disableCount } = this.#hook(key);
    return { enabled: initiator !== undefined, target, disableCount };
  }

  async fireHook(key: string, value: number): Promise<{ fired: true } | { error: string }> {
    const { initiator } = this.#hook(key);
    if (!initiator) return { error: "hook was never enabled" };
    try {
      const { callback, approvalQueue } = await initiator.startHook();
      try {
        await approvalQueue.authorizeObservation({
          title: `Hook ${key} requested ${value}`,
          description: "The integration test fired this hook.",
        });
        await callback.onValueRequested(value);
      } finally {
        callback[Symbol.dispose]();
        approvalQueue[Symbol.dispose]();
      }
      return { fired: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  keepSelfStub(key: string, stub: RpcStub<ConnectionProbe>): void {
    this.ctx.storage.kv.put(`self-stub:${key}`, stub);
  }

  async callSelfStub(key: string): Promise<{ label: string } | { error: string }> {
    try {
      const stub = this.ctx.storage.kv.get<RpcStub<ConnectionProbe>>(`self-stub:${key}`)!;
      return { label: await stub.label() };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  #hook(key: string): HookState {
    return this.ctx.storage.kv.get<HookState>(`hook:${key}`) ?? { disableCount: 0 };
  }

  openConnect(label: string, callback: Fetcher<GatekeeperConnectCallback>): void {
    this.ctx.storage.kv.put(`connect:${label}`, callback);
  }

  /**
   * Keeps the callback (its doc allows storing it) so the account can later expire and reconnect,
   * and starts the live credential generation at 1.
   */
  async finishConnect(label: string): Promise<ConnectHandoff | null> {
    const key = `connect:${label}`;
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>(key);
    if (callback === undefined) return null;
    this.ctx.storage.kv.delete(key);
    const handoff = await callback.complete(this.ctx.exports.TestAccount({ props: { label } }));
    this.ctx.storage.kv.put(`callback:${label}`, callback);
    this.ctx.storage.kv.put(`credential:${label}`, 1);
    return handoff;
  }

  async expireCredentials(label: string): Promise<void> {
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>(`callback:${label}`);
    if (callback === undefined) throw new Error("The test gatekeeper has no credentials to expire.");
    await callback.credentialsExpired();
  }

  /** Auto-provisioned accounts never ran a connect flow, so they have no callback to reconnect. */
  startReconnect(label: string): string {
    if (this.ctx.storage.kv.get(`callback:${label}`) === undefined) {
      throw new Error("The test gatekeeper has no credentials to reconnect.");
    }
    const flow = crypto.randomUUID();
    this.ctx.storage.kv.put(`reconnect:${flow}`, label);
    return flow;
  }

  /** Stages the replacement credentials; only commitReconnect() with this stage makes them live. */
  async finishReconnect(flow: string): Promise<ConnectHandoff | null> {
    const key = `reconnect:${flow}`;
    const label = this.ctx.storage.kv.get<string>(key);
    if (label === undefined) return null;
    this.ctx.storage.kv.delete(key);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>(`callback:${label}`)!;
    const stageId = crypto.randomUUID();
    this.ctx.storage.kv.put(`reconnect-stage:${label}`, stageId);
    return callback.reconnectComplete(stageId);
  }

  /** Activates the staged generation and revokes the grant it replaces. */
  commitReconnect(label: string, stageId: string): void {
    const stageKey = `reconnect-stage:${label}`;
    if (this.ctx.storage.kv.get<string>(stageKey) !== stageId) {
      throw new Error("No reconnect is awaiting confirmation.");
    }
    this.ctx.storage.kv.delete(stageKey);
    this.ctx.storage.kv.put(`credential:${label}`, this.getCredential(label)! + 1);
    this.recordRevocation(label);
  }

  getCredential(label: string): number | null {
    return this.ctx.storage.kv.get<number>(`credential:${label}`) ?? null;
  }

  recordGadgetResponse(messageKey: string, response: GadgetResponse): void {
    const key = `gadget-responses:${messageKey}`;
    this.ctx.storage.kv.put(key, [...this.getGadgetResponses(messageKey), response]);
  }

  getGadgetResponses(messageKey: string): GadgetResponse[] {
    return this.ctx.storage.kv.get<GadgetResponse[]>(`gadget-responses:${messageKey}`) ?? [];
  }

  /**
   * Submits from here rather than returning the target: relayed back through the fetch handler,
   * the stub ctx.restore() mints arrives non-persistent, and the Workshop stores it.
   */
  async submitExternalMessage(input: Omit<SubmitExternalMessageInput, "chatGatewayRpcTarget">)
      : Promise<SubmitExternalMessageResult> {
    using chatGatewayRpcTarget =
        await this.ctx.restore<RpcStub<ChatGatewayRpcTarget>>({ messageKey: input.messageKey });
    return await this.env.WORKSHOP_EXTERNAL_MESSAGES.submitExternalMessage(
        { ...input, chatGatewayRpcTarget });
  }

  [restore]({ messageKey }: { messageKey: string }): GadgetResponseRecorder {
    return new GadgetResponseRecorder(this, messageKey);
  }
}

/** Records each delivery rather than the latest, since delivery is at-least-once. */
@validateRpc()
class GadgetResponseRecorder extends RpcTarget implements ChatGatewayRpcTarget {
  constructor(private readonly owner: TestControl, private readonly messageKey: string) {
    super();
  }

  async onGadgetResponse(response: GadgetResponse): Promise<void> {
    this.owner.recordGadgetResponse(this.messageKey, response);
  }
}

// ctx.exports is typed via the Cloudflare.GlobalProps declaration in env.d.ts, so loopback bindings
// here carry their real prop and return types with no casts.
function control(exports: Cloudflare.Exports): DurableObjectStub<TestControl> {
  return exports.TestControl.getByName("control");
}

// ---------------------------------------------------------------------------
// Vendor

type AccountProps = { label: string };
// `simulated`: minted by GatekeeperVendor.createResource() and not yet created, so nothing may
// apply through it. It belongs to no account, so its `label` keys only its staged actions.
type BindingProps = AccountProps & { resourceUrl: string; ambient?: true; simulated?: true };

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Test Gatekeeper",
      url: `https://${VENDOR_HOST}`,
      logo: AVATAR,
      tagline: "A gatekeeper that exists only for integration tests.",
      // Accounts are minted on request with no auth flow, which is what keeps these tests about the
      // overseer rather than about somebody's OAuth dance.
      autoProvisionsAccount: true,
    };
  }

  /**
   * Reached via provisionAmbientAccount(). Each call mints a distinct account, so two users -- or two
   * concurrent tests -- never share one.
   */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.TestAccount({ props: { label: newAccountLabel() } });
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /**
   * Reached via `AuthenticatedApi.connectAccount()`; the returned URL is served by this worker's
   * `GET /connect/<label>`, named for the account the flow mints.
   */
  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    const label = newAccountLabel();
    await control(this.ctx.exports).openConnect(label, callback);
    return { url: `https://${VENDOR_HOST}/connect/${label}` };
  }

  async createResource(_resourceUrlPattern: string, title: string): Promise<{
    class: DurableObjectClass<Gatekeeper<TestSession>>;
    resource: SupportedResource;
    action: ActionDescription;
  }> {
    const resourceUrl = `https://${VENDOR_HOST}/things/${encodeURIComponent(title)}`;
    return {
      class: this.ctx.exports.TestGatekeeper({
        props: { label: `creation-${crypto.randomUUID()}`, resourceUrl, simulated: true },
      }),
      resource: SUPPORTED_RESOURCES[0],
      action: {
        title: `Create the test thing "${title}"`,
        description: `Create a test thing titled **${title}**.`,
        descriptionIsComplete: true,
        implementsRevert: false,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Account

@validateRpc()
export class TestAccount
    extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: this.ctx.props.label.split("@")[0],
      // What the overseer names in a verification-failure message.
      uniqueName: this.ctx.props.label,
      avatar: AVATAR,
      singleton: { tsType: "TestThing" },
    };
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<TestSession>>> {
    return this.ctx.exports.TestGatekeeper({
      props: { label: this.ctx.props.label, resourceUrl: "test://ambient", ambient: true },
    });
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  /**
   * Bind a resource. The Workshop calls this when the owner pastes a URL; the returned class becomes
   * a Gatekeeper facet under that gadget's Overseer.
   */
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<TestSession>>;
    resource: SupportedResource;
  }> {
    const parsed = new URL(url);
    if (parsed.host !== VENDOR_HOST || !parsed.pathname.startsWith("/things/")) {
      throw new Error(`Not a test-gatekeeper resource URL: ${url}`);
    }
    return {
      class: this.ctx.exports.TestGatekeeper({
        props: { label: this.ctx.props.label, resourceUrl: url },
      }),
      resource: SUPPORTED_RESOURCES[0],
    };
  }

  /** The capability the overseer hands to addObserver() to say "this is the user asking". */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.TestVerifier({ props: this.ctx.props });
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async revoke(): Promise<void> {
    await control(this.ctx.exports).recordRevocation(this.ctx.props.label);
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("The test gatekeeper has no resource configurator; bind a URL directly.");
  }

  async commitReconnect(stageId: string): Promise<void> {
    await control(this.ctx.exports).commitReconnect(this.ctx.props.label, stageId);
  }

  async reconnect(): Promise<{ url: string }> {
    const flow = await control(this.ctx.exports).startReconnect(this.ctx.props.label);
    return { url: `https://${VENDOR_HOST}/reconnect/${flow}` };
  }
}

/**
 * Reports which account is asking.
 *
 * `GatekeeperUserVerifier` has no methods of its own; the convention (see its declaration) is that a
 * gatekeeper adds a non-standard method and trusts the answer, because the overseer only ever hands a
 * verifier back to the vendor that minted it.
 */
export interface TestVerifierApi extends GatekeeperUserVerifier {
  identify(): Promise<string>;
}

@validateRpc()
export class TestVerifier
    extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements TestVerifierApi {
  async identify(): Promise<string> {
    return this.ctx.props.label;
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper (one per bound resource, running as a facet under the gadget's Overseer)

/**
 * A live session against a Test Thing, opened via `GatekeeperClient.openSession()`. `readValue()`
 * records an observation (optionally `containsRestrictedData`); `writeValue()` submits a
 * `set-value` action whose `autoApprovable` verdict and warnings the caller chooses.
 */
export interface TestSession {
  /**
   * `restricted` marks the observation `containsRestrictedData`; `ownerInvitesOnly` marks it
   * `ownerInvitesOnly`. `excludeObservers` lists observer ids (from `/control/observer-events`)
   * that must not see it.
   */
  readValue(restricted?: boolean, ownerInvitesOnly?: boolean, excludeObservers?: string[])
      : Promise<number>;
  /** `incomplete` omits the `descriptionIsComplete` claim, as a summary-only gatekeeper would. */
  writeValue(value: number, opts?: { autoApprovable?: boolean; incomplete?: boolean }): Promise<number>;
  writeValues(values: number[]): Promise<number[]>;
  watch(key: string, callback: RpcStub<ValueHook>): Promise<void>;
  /** Stores a persistent stub to this connection under `key`, for `/control/call-self-stub`. */
  keepSelfStub(key: string): Promise<void>;
}

/** The hook a gadget binds through `TestSession.watch()`. */
export interface ValueHook extends RpcTarget {
  onValueRequested(value: number): Promise<void>;
}

@validateRpc()
class TestSessionTarget extends RpcTarget implements TestSession {
  private readonly approvalQueue: RpcStub<ApprovalQueue>;

  constructor(
      approvalQueue: RpcStub<ApprovalQueue>,
      private readonly state: DurableObjectStub<TestControl>,
      private readonly label: string,
      private readonly ctx: DurableObjectState) {
    super();
    this.approvalQueue = approvalQueue.dup();
  }

  async readValue(
      restricted?: boolean, ownerInvitesOnly?: boolean, excludeObservers?: string[])
      : Promise<number> {
    await this.approvalQueue.authorizeObservation({
      title: "Read the test value",
      description: "Read the deterministic value exposed by the integration-test gatekeeper.",
      ...(restricted ? { containsRestrictedData: true } : {}),
      ...(ownerInvitesOnly ? { ownerInvitesOnly: true } : {}),
      ...(excludeObservers ? { excludeObservers } : {}),
    });
    return 42;
  }

  async writeValue(
      value: number, opts?: { autoApprovable?: boolean; incomplete?: boolean }): Promise<number> {
    const id = await this.state.stageAction(this.label, value);
    try {
      await this.approvalQueue.submitAction(id, {
        title: `Set the test value to ${value}`,
        description: `Set the deterministic integration-test value to **${value}**.`,
        // The number is the whole content of the write.
        ...(opts?.incomplete ? {} : { descriptionIsComplete: true }),
        implementsRevert: false,
        awaitDecision: true,
        actionKind: SET_VALUE_ACTION_KIND,
        ...(opts?.autoApprovable ? { autoApprovable: true } : {}),
      });
      return id;
    } catch (error) {
      await this.state.discardAction(this.label, id);
      throw error;
    }
  }

  async writeValues(values: number[]): Promise<number[]> {
    return Promise.all(values.map(value => this.writeValue(value)));
  }

  async watch(key: string, callback: RpcStub<ValueHook>): Promise<void> {
    await this.approvalQueue.bindHook(
        // @ts-expect-error Workers currently widens the controller's hook type across bindHook RPC.
        this.ctx.exports.TestHookController({ props: { key } }),
        callback,
        { title: `Test hook ${key}`, description: "Delivers values the integration test fires." });
  }

  async keepSelfStub(key: string): Promise<void> {
    await this.state.keepSelfStub(key, await this.ctx.restore<RpcStub<ConnectionProbe>>({}));
  }

  [Symbol.dispose](): void {
    this.approvalQueue[Symbol.dispose]();
  }
}

const SET_VALUE_ACTION_KIND: ActionKind = { tag: "set-value", label: "Set value" };

/** Polls rather than parks a promise: the release arrives on another request to TestControl. */
async function waitForApplyRelease(state: DurableObjectStub<TestControl>, label: string) {
  for (const deadline = Date.now() + 30_000; !await state.isApplyReleased(label);) {
    if (Date.now() > deadline) throw new Error("The held test apply was never released.");
    await scheduler.wait(25);
  }
}

/** What a connection's persistent stub to itself reaches: a narrow target, never the facet. */
interface ConnectionProbe extends RpcTarget {
  label(): Promise<string>;
}

@validateRpc()
class ConnectionProbeTarget extends RpcTarget implements ConnectionProbe {
  constructor(private readonly labelValue: string) {
    super();
  }

  async label(): Promise<string> {
    return this.labelValue;
  }
}

@validateRpc()
export class TestGatekeeper
    extends DurableObject<Cloudflare.Env, BindingProps> implements Gatekeeper<TestSession> {
  async describe(): Promise<ResourceDescription> {
    if (this.ctx.props.ambient) {
      return {
        url: this.ctx.props.resourceUrl,
        title: "Test Ambient",
        snippet: "An automatically-provided test capability.",
        suggestedBindingName: "TEST_AMBIENT",
        tsType: "TestThing",
      };
    }
    const name = decodeURIComponent(new URL(this.ctx.props.resourceUrl).pathname.split("/").pop()!);
    return {
      url: this.ctx.props.resourceUrl,
      // Distinct per binding, so a message covering two failing bindings names both.
      title: `Test Thing ${name}`,
      snippet: `The test resource ${name}.`,
      suggestedBindingName: "TEST_THING",
      tsType: "TestThing",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [SET_VALUE_ACTION_KIND];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<TestSession> {
    return new TestSessionTarget(
        approvalQueue, control(this.ctx.exports), this.ctx.props.label, this.ctx);
  }

  [restore](): ConnectionProbe {
    return new ConnectionProbeTarget(this.ctx.props.label);
  }

  /** No discovery index: the ambient fixture is reached through its session alone. */
  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  /**
   * Admit an observer, or refuse on the test's instruction.
   *
   * Asks the verifier who it speaks for, then consults the control state for that account. Throwing
   * is how a gatekeeper reports "this user may not observe what the gadget has read", and it's the
   * behaviour the overseer's failure handling is built around.
   */
  async addObserver(id: string, user: Fetcher<TestVerifierApi>): Promise<void> {
    const label = await user.identify();
    const { resourceUrl } = this.ctx.props;
    if (this.ctx.props.ambient) {
      await control(this.ctx.exports).recordAmbientVerification(label);
    } else {
      const outcome = await control(this.ctx.exports).getVerifyOutcome(label, resourceUrl);
      if (!outcome.allow) throw new Error(outcome.reason);
    }
    this.ctx.storage.kv.put(`observer:${id}`, label);
    await control(this.ctx.exports).recordObserverEvent({ resourceUrl, type: "add", id });
  }

  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(`observer:${id}`);
    await control(this.ctx.exports).recordObserverEvent(
        { resourceUrl: this.ctx.props.resourceUrl, type: "remove", id });
  }

  async applyAction(action: number): Promise<void> {
    if (this.ctx.props.simulated) throw new Error("This test thing has not been created yet.");
    const state = control(this.ctx.exports);
    const { label } = this.ctx.props;
    const held = await state.takeNextApplyHold(label);
    await state.recordApplyAttempt(label);
    if (held) await waitForApplyRelease(state, label);
    const failure = await state.takeApplyFailure(label);
    if (failure !== null) throw new Error(failure);
    await state.applyAction(label, action);
  }

  async rejectAction(action: number): Promise<void> {
    await control(this.ctx.exports).discardAction(this.ctx.props.label, action);
  }

  async applyCreation(creator: Fetcher<TestVerifierApi>): Promise<{
    class: DurableObjectClass<Gatekeeper<TestSession>>;
    resourceUrl: string;
  }> {
    const label = await creator.identify();
    const { resourceUrl } = this.ctx.props;
    await control(this.ctx.exports).adoptActions(this.ctx.props.label, label);
    return { class: this.ctx.exports.TestGatekeeper({ props: { label, resourceUrl } }), resourceUrl };
  }

  async revertAction(_action: number): Promise<void> {
    throw new Error("Test actions do not support revert.");
  }
}

@validateRpc()
export class TestHookController
    extends WorkerEntrypoint<Cloudflare.Env, { key: string }> implements HookController<ValueHook> {
  async enable(initiator: Fetcher<HookInitiator<ValueHook>>, target: HookTargetMetadata)
      : Promise<void> {
    await control(this.ctx.exports).enableHook(this.ctx.props.key, initiator, target);
  }

  async disable(): Promise<void> {
    await control(this.ctx.exports).recordHookDisable(this.ctx.props.key);
  }
}

// ---------------------------------------------------------------------------
// Control surface
//
// Plain HTTP on the worker's own fetch(), dispatched from tests with
// harness.fetchWorker("gatekeeper-test", ...). No env gating: this worker is never deployed.
//
// The bodies are checked rather than trusted. Not for safety -- the only callers are helpers in this
// package -- but for the failure mode: an unchecked misspelled field registers an outcome for the
// account named `undefined`, so the gatekeeper goes on admitting the account the test meant to fail
// and the test dies several steps later with an assertion that says nothing about the real cause.

/** A 400 whose body says which field was wrong, so a mistyped control call fails where it happens. */
function badRequest(problem: string): Response {
  return new Response(`Bad control request: ${problem}`, { status: 400 });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export default {
  async fetch(req: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // The page a finished connect flow ends on, carrying the handoff ticket to the Workshop.
    if (req.method === "GET" && url.pathname.startsWith("/connect/")) {
      const handoff = await control(ctx.exports).finishConnect(url.pathname.slice("/connect/".length));
      return handoff
        ? htmlResponse(connectHandoffPageHtml(handoff))
        : new Response("Not Found", { status: 404 });
    }

    // The page a finished reconnect flow ends on, carrying the restore ticket to the Workshop.
    if (req.method === "GET" && url.pathname.startsWith("/reconnect/")) {
      const handoff = await control(ctx.exports).finishReconnect(
          url.pathname.slice("/reconnect/".length));
      return handoff
        ? htmlResponse(connectHandoffPageHtml(handoff))
        : new Response("Not Found", { status: 404 });
    }

    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await req.json();
      } catch {
        return badRequest("the body is not JSON");
      }
      if (typeof body !== "object" || body === null) {
        return badRequest("the body is not a JSON object");
      }
    }

    // Set what addObserver() should do for one account, either everywhere or (when `resourceUrl`
    // is given) at one binding only.
    // Body: {"label": "...", "allow": false, "reason": "...", "resourceUrl": "..."}
    if (url.pathname === "/control/verify-outcome" && req.method === "POST") {
      const { label, allow, reason, resourceUrl } = body as Record<string, unknown>;
      if (!isNonEmptyString(label)) return badRequest("`label` must be a non-empty string");
      if (typeof allow !== "boolean") return badRequest("`allow` must be a boolean");
      if (reason !== undefined && typeof reason !== "string") {
        return badRequest("`reason` must be a string when present");
      }
      if (resourceUrl !== undefined && !isNonEmptyString(resourceUrl)) {
        return badRequest("`resourceUrl` must be a non-empty string when present");
      }

      const outcome: VerifyOutcome = allow
        ? { allow: true }
        : { allow: false, reason: reason ?? "The test gatekeeper refused this account." };
      await control(ctx.exports).setVerifyOutcome(label, outcome, resourceUrl);
      return new Response(null, { status: 204 });
    }

    // Read back the addObserver()/removeObserver() calls one binding's gatekeeper has seen, in
    // order.
    // Body: {"resourceUrl": "..."} -> {"events": [{"resourceUrl", "type", "id"}, ...]}
    if (url.pathname === "/control/observer-events" && req.method === "POST") {
      const { resourceUrl } = body as Record<string, unknown>;
      if (!isNonEmptyString(resourceUrl)) {
        return badRequest("`resourceUrl` must be a non-empty string");
      }
      return Response.json({ events: await control(ctx.exports).getObserverEvents(resourceUrl) });
    }

    if (url.pathname === "/control/ambient-verification-count" && req.method === "POST") {
      const { label } = body as Record<string, unknown>;
      if (!isNonEmptyString(label)) return badRequest("`label` must be a non-empty string");
      return Response.json({ count: await control(ctx.exports).getAmbientVerificationCount(label) });
    }

    if (url.pathname === "/control/revocation-count" && req.method === "POST") {
      const { label } = body as Record<string, unknown>;
      if (!isNonEmptyString(label)) return badRequest("`label` must be a non-empty string");
      return Response.json({ count: await control(ctx.exports).getRevocationCount(label) });
    }

    // Tell the Workshop, through the account's stored connect callback, that its grant expired.
    // Body: {"label": "..."}
    if (url.pathname === "/control/expire-credentials" && req.method === "POST") {
      const { label } = body as Record<string, unknown>;
      if (!isNonEmptyString(label)) return badRequest("`label` must be a non-empty string");
      await control(ctx.exports).expireCredentials(label);
      return new Response(null, { status: 204 });
    }

    // The live credential generation: 1 after connect, +1 per committed reconnect.
    // Body: {"label": "..."} -> {"credential": number | null}
    if (url.pathname === "/control/credential" && req.method === "POST") {
      const { label } = body as Record<string, unknown>;
      if (!isNonEmptyString(label)) return badRequest("`label` must be a non-empty string");
      return Response.json({ credential: await control(ctx.exports).getCredential(label) });
    }

    if (url.pathname === "/control/action-state" && req.method === "POST") {
      const { label } = body as Record<string, unknown>;
      if (!isNonEmptyString(label)) return badRequest("`label` must be a non-empty string");
      const state = await control(ctx.exports).getActionState(label);
      return Response.json({
        pending: state.pending,
        value: state.value,
        applyCount: state.applyCount,
      });
    }

    // Body: {"label": "..."} -> {"attempts": number}
    if (url.pathname === "/control/apply-attempts" && req.method === "POST") {
      const { label } = body as Record<string, unknown>;
      if (!isNonEmptyString(label)) return badRequest("`label` must be a non-empty string");
      return Response.json({ attempts: await control(ctx.exports).getApplyAttempts(label) });
    }

    // One-shot: the next applyAction() for `label` waits for /control/release-apply.
    // Body: {"label": "..."}
    if (url.pathname === "/control/hold-next-apply" && req.method === "POST") {
      const { label } = body as Record<string, unknown>;
      if (!isNonEmptyString(label)) return badRequest("`label` must be a non-empty string");
      await control(ctx.exports).holdNextApply(label);
      return new Response(null, { status: 204 });
    }

    // Body: {"label": "..."}
    if (url.pathname === "/control/release-apply" && req.method === "POST") {
      const { label } = body as Record<string, unknown>;
      if (!isNonEmptyString(label)) return badRequest("`label` must be a non-empty string");
      await control(ctx.exports).releaseApply(label);
      return new Response(null, { status: 204 });
    }

    // One-shot: the next applyAction() for `label` throws `reason` without applying.
    // Body: {"label": "...", "reason": "..."}
    if (url.pathname === "/control/fail-next-apply" && req.method === "POST") {
      const { label, reason } = body as Record<string, unknown>;
      if (!isNonEmptyString(label)) return badRequest("`label` must be a non-empty string");
      if (reason !== undefined && typeof reason !== "string") {
        return badRequest("`reason` must be a string when present");
      }
      await control(ctx.exports).failNextApply(
          label, reason ?? "The test gatekeeper failed to apply this action.");
      return new Response(null, { status: 204 });
    }

    // Submit an external chat message through the Workshop's ExternalMessageGateway entrypoint,
    // the way a chat-integration worker would, so tests can drive receiveExternalMessage().
    // Body: {"callerEmail", "gadgetKey", "chatKey", "messageKey", "gadgetTitle", "prompt"}
    // -> SubmitExternalMessageResult
    if (url.pathname === "/control/submit-external-message" && req.method === "POST") {
      const fields =
          ["callerEmail", "gadgetKey", "chatKey", "messageKey", "gadgetTitle", "prompt"] as const;
      const input = {} as Record<(typeof fields)[number], string>;
      for (const field of fields) {
        const value = (body as Record<string, unknown>)[field];
        if (!isNonEmptyString(value)) return badRequest(`\`${field}\` must be a non-empty string`);
        input[field] = value;
      }
      return Response.json(await control(ctx.exports).submitExternalMessage(input));
    }

    // Body: {"messageKey": "..."} -> {"responses": GadgetResponse[]}
    if (url.pathname === "/control/gadget-responses" && req.method === "POST") {
      const { messageKey } = body as Record<string, unknown>;
      if (!isNonEmptyString(messageKey)) return badRequest("`messageKey` must be a non-empty string");
      return Response.json({ responses: await control(ctx.exports).getGadgetResponses(messageKey) });
    }

    // Fire a hook through the initiator its controller's enable() stored.
    // Body: {"key": "...", "value": number} -> {"fired": true} | {"error": string}
    if (url.pathname === "/control/fire-hook" && req.method === "POST") {
      const { key, value } = body as Record<string, unknown>;
      if (!isNonEmptyString(key)) return badRequest("`key` must be a non-empty string");
      if (typeof value !== "number") return badRequest("`value` must be a number");
      return Response.json(await control(ctx.exports).fireHook(key, value));
    }

    // Call the stub a session's keepSelfStub() stored.
    // Body: {"key": "..."} -> {"label": string} | {"error": string}
    if (url.pathname === "/control/call-self-stub" && req.method === "POST") {
      const { key } = body as Record<string, unknown>;
      if (!isNonEmptyString(key)) return badRequest("`key` must be a non-empty string");
      return Response.json(await control(ctx.exports).callSelfStub(key));
    }

    // Body: {"key": "..."} -> {"enabled": boolean, "target"?: HookTargetMetadata, "disableCount"}
    if (url.pathname === "/control/hook-state" && req.method === "POST") {
      const { key } = body as Record<string, unknown>;
      if (!isNonEmptyString(key)) return badRequest("`key` must be a non-empty string");
      return Response.json(await control(ctx.exports).getHookState(key));
    }

    // Map an external gadgetKey to the Overseer id the gateway targets -- the DO named
    // "<source>:<gadgetKey>", where "test" is the `source` prop on WORKSHOP_EXTERNAL_MESSAGES --
    // so a test can open the same workspace over the web API, which addresses by DO id string.
    // Body: {"gadgetKey": "..."} -> {"gadgetId": "..."}
    if (url.pathname === "/control/external-gadget-id" && req.method === "POST") {
      const { gadgetKey } = body as Record<string, unknown>;
      if (!isNonEmptyString(gadgetKey)) return badRequest("`gadgetKey` must be a non-empty string");
      return Response.json(
          { gadgetId: env.WORKSHOP_OVERSEER.idFromName(`test:${gadgetKey}`).toString() });
    }

    // Make this Worker issue a subrequest, so a test can prove that Worker-originated fetches really
    // do route through the interceptor rather than out to the internet.
    //
    // Reports the status rather than just succeeding or failing, because an intercepted-and-rejected
    // request does not reject here: the harness proxies outbound fetches and turns a proxy-side
    // failure into a synthetic 500.
    // Body: {"url": "..."} -> {"status": number} | {"error": string}
    if (url.pathname === "/control/fetch-probe" && req.method === "POST") {
      const { url: target } = body as Record<string, unknown>;
      if (!isNonEmptyString(target)) return badRequest("`url` must be a non-empty string");
      try {
        return Response.json({ status: (await fetch(target)).status });
      } catch (err) {
        return Response.json({ error: String(err) });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
