import type { RpcPromise, RpcStub } from "capnweb";
import type {
  ActionHistoryFilter, ActionHistoryPage, AiChatAuthorInfo, AiChatHistoryPage, AiChatMessage,
  AiChatMetadata, AiChatStreamEvent, AiChatSubscriber, AiModelConfig, AuthenticatedApi, GadgetClient,
  Overseer, PublicApi, WorkpieceId, WorkpieceSummary, WorkpiecesSubscriber,
} from "@gadgets/workshop-shared/api";
import type { CodeChange } from "@gadgets/workshop-shared/code-change";
import {
  type ConnectedAccount, connect, listConnectedAccounts, nextUsernames, signUp, stubFor, waitFor,
  RpcTarget,
} from "./rpc-client.js";

const DEFAULT_TURN_TIMEOUT_MS = 40_000;
const CANCELLATION_TIMEOUT_MS = 15_000;
const PENDING_RPC_GRACE_MS = 5_000;

type UserModel = {
  profile: AiChatAuthorInfo;
  config: AiModelConfig;
};
export type AgentTurnOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** Configuration for one fresh local Workshop account and workspace. */
export type AgentSessionOptions = {
  modelId: string;
  userModel?: UserModel;
  ambientVendorIds?: readonly string[];
  usernamePrefix?: string;
  turnTimeoutMs?: number;
  costAccountingTimeoutMs?: number;
};

/** How one observed agent activation ended. */
export type AgentTurnOutcome =
  | { status: "completed" }
  | { status: "error"; message: string; code?: string }
  | { status: "timedOut"; message: string }
  | { status: "cancelled"; message: string };

/** Canonical state observed after one agent activation ends. */
export type AgentTurnResult = {
  outcome: AgentTurnOutcome;
  history: AiChatMessage[];
  workpieces: WorkpieceSummary[];
  usage: {
    lastStepTokens?: number;
    observedCumulativeChatCostUsd?: number;
  };
};

/** Filters accepted by the public action-history API. */
export type ActionListOptions = { beforeId?: number; filter?: ActionHistoryFilter };

/** Gadget client and chat branch needed to connect to provisional agent code. */
export type ProvisionalGadget = { client: RpcStub<GadgetClient>; chatId: number };

/**
 * Drives a fresh local Workshop account and workspace through the public Cap'n Web API.
 * `runTurn()` observes one active-to-idle agent activation. It does not claim that late callbacks
 * have settled; tests that trigger an approval continuation must use `approveActionsAndWait()`.
 */
export interface WorkshopAgentSession extends AsyncDisposable {
  readonly username: string;
  runTurn(prompt: string, options?: AgentTurnOptions): Promise<AgentTurnResult>;
  approveActionsAndWait(
      ids: readonly [number, ...number[]], options?: AgentTurnOptions): Promise<AgentTurnResult>;
  listActions(options?: ActionListOptions): Promise<ActionHistoryPage>;
  connectedAccount(vendorId: string): ConnectedAccount;
  openGadget(id: WorkpieceId): Promise<ProvisionalGadget>;
  acceptChanges(): Promise<void>;
  close(): Promise<void>;
}

type PendingTurnEvent =
  | { type: "metadata"; chat: AiChatMetadata; latestSequence: number }
  | { type: "message"; entry: AiChatMessage };

class TurnObserver {
  readonly result: Promise<AgentTurnOutcome>;
  readonly timeoutFailure: Promise<never>;
  #resolveResult: (outcome: AgentTurnOutcome) => void = () => {};
  #rejectTimeout: (error: Error) => void = () => {};
  #chatId: number | undefined;
  #pendingEvents: PendingTurnEvent[] = [];
  readonly #expectedPrompt: string | undefined;
  #promptSeen: boolean;
  #deferredMetadata: { chat: AiChatMetadata; latestSequence: number } | undefined;
  #sawActive = false;
  #error: {
    outcome: Extract<AgentTurnOutcome, { status: "error" }>;
    sequence: number;
  } | undefined;
  #startSequence = -1;
  #endSequence: number | undefined;
  #outcome: AgentTurnOutcome | undefined;
  #timer: ReturnType<typeof setTimeout>;
  readonly #signal: AbortSignal | undefined;
  readonly #onAbort = () => {
    const message = "Agent activation was cancelled";
    this.#finish({ status: "cancelled", message });
    this.#rejectTimeout(new Error(message));
  };

  constructor(
      chatId: number | undefined, timeoutMs: number, signal?: AbortSignal,
      expectedPrompt?: string, holdUntilAdmitted = false) {
    this.#chatId = chatId;
    this.#signal = signal;
    this.#expectedPrompt = expectedPrompt;
    this.#promptSeen = expectedPrompt === undefined && !holdUntilAdmitted;
    const result = Promise.withResolvers<AgentTurnOutcome>();
    this.result = result.promise;
    this.#resolveResult = result.resolve;
    const timeout = Promise.withResolvers<never>();
    this.timeoutFailure = timeout.promise;
    this.#rejectTimeout = timeout.reject;
    this.timeoutFailure.catch(() => {});
    this.#timer = setTimeout(() => {
      const message = `Timed out after ${timeoutMs}ms waiting for the agent activation`;
      if (this.#finish({ status: "timedOut", message })) {
        this.#rejectTimeout(new Error(message));
      }
    }, timeoutMs);
    if (signal?.aborted) this.#onAbort();
    else signal?.addEventListener("abort", this.#onAbort, { once: true });
  }

  get outcome(): AgentTurnOutcome | undefined {
    return this.#outcome;
  }

  get startSequence(): number {
    return this.#startSequence;
  }

  get endSequence(): number | undefined {
    return this.#endSequence;
  }

  get aborted(): boolean {
    return this.#signal?.aborted ?? false;
  }

  admit(startSequence?: number): void {
    if (this.#promptSeen) return;
    this.#promptSeen = true;
    if (startSequence !== undefined) this.#startSequence = startSequence;
    const deferred = this.#deferredMetadata;
    this.#deferredMetadata = undefined;
    if (deferred !== undefined) this.#observeMetadata(deferred.chat, deferred.latestSequence);
  }

  attach(chatId: number): void {
    this.#chatId = chatId;
    const events = this.#pendingEvents;
    this.#pendingEvents = [];
    for (const event of events) {
      if (event.type === "metadata") {
        this.metadata(event.chat, event.latestSequence);
      } else {
        this.message(event.entry);
      }
    }
  }

  metadata(chat: AiChatMetadata, latestSequence: number): void {
    if (this.#chatId === undefined) {
      this.#pendingEvents.push({ type: "metadata", chat, latestSequence });
      return;
    }
    if (chat.id !== this.#chatId || this.#outcome !== undefined) return;
    if (!this.#promptSeen) {
      this.#deferredMetadata = { chat, latestSequence };
      return;
    }
    this.#observeMetadata(chat, latestSequence);
  }

  message(entry: AiChatMessage): void {
    if (this.#chatId === undefined) {
      this.#pendingEvents.push({ type: "message", entry });
      return;
    }
    if (entry.chatId !== this.#chatId) return;
    if (!this.#promptSeen && entry.type === "message" && entry.author.type === "user" &&
        entry.message === this.#expectedPrompt) {
      this.admit(entry.sequence);
    }
    if (entry.type !== "error" || this.#outcome !== undefined ||
        (this.#sawActive && entry.sequence <= this.#startSequence)) return;
    const outcome: Extract<AgentTurnOutcome, { status: "error" }> = entry.code === undefined
      ? { status: "error", message: entry.message }
      : { status: "error", message: entry.message, code: entry.code };
    this.#error = { outcome, sequence: entry.sequence };
  }

  #observeMetadata(chat: AiChatMetadata, latestSequence: number): void {
    if (chat.activeAgent !== undefined) {
      if (!this.#sawActive) {
        if (this.#startSequence < 0) this.#startSequence = latestSequence;
        if (this.#error !== undefined && this.#error.sequence <= this.#startSequence) {
          this.#error = undefined;
        }
      }
      this.#sawActive = true;
    } else if (this.#sawActive || this.#error !== undefined) {
      this.#endSequence = latestSequence;
      this.#finish(this.#error?.outcome ?? { status: "completed" });
    }
  }

  race<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.timeoutFailure]);
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#signal?.removeEventListener("abort", this.#onAbort);
  }

  #finish(outcome: AgentTurnOutcome): boolean {
    if (this.#outcome !== undefined) return false;
    clearTimeout(this.#timer);
    this.#outcome = outcome;
    this.#resolveResult(outcome);
    return true;
  }
}

class ChatSubscriber extends RpcTarget implements AiChatSubscriber {
  observer: TurnObserver | undefined;
  readonly #latestSequence = new Map<number, number>();
  readonly #metadata = new Map<number, AiChatMetadata>();
  readonly #costUpdates = new Map<number, number>();
  #costWaiter: {
    chatId: number;
    minimumUpdates: number;
    resolve: (metadata: AiChatMetadata | undefined) => void;
  } | undefined;

  streamGeneration(_generation: number): void {}
  metadata(chat: AiChatMetadata): void {
    const previous = this.#metadata.get(chat.id);
    this.#metadata.set(chat.id, chat);
    if (chat.totalCost !== undefined &&
        (previous === undefined ? chat.totalCost > 0 : chat.totalCost !== previous.totalCost)) {
      this.#costUpdates.set(chat.id, this.costUpdateCount(chat.id) + 1);
    }
    this.observer?.metadata(chat, this.latestSequence(chat.id));
    const waiter = this.#costWaiter;
    if (waiter !== undefined && waiter.chatId === chat.id &&
        this.costUpdateCount(chat.id) >= waiter.minimumUpdates) {
      waiter.resolve(chat);
    }
  }
  deleted(_chatId: number): void {}
  message(entry: AiChatMessage): void {
    this.#latestSequence.set(
        entry.chatId, Math.max(this.latestSequence(entry.chatId), entry.sequence));
    this.observer?.message(entry);
  }
  changeApplied(
      _chatId: number, _generation: number, _revision: number, _author: AiChatAuthorInfo,
      _change: CodeChange, _submission?: { clientId: string; seq: number }): void {}
  stream(_chatId: number, _event: AiChatStreamEvent): void {}

  latestSequence(chatId: number): number {
    return this.#latestSequence.get(chatId) ?? -1;
  }

  latestMetadata(chatId: number): AiChatMetadata | undefined {
    return this.#metadata.get(chatId);
  }

  costUpdateCount(chatId: number): number {
    return this.#costUpdates.get(chatId) ?? 0;
  }

  async waitForCostUpdates(
      chatId: number, minimumUpdates: number,
      timeoutMs: number): Promise<AiChatMetadata | undefined> {
    const current = this.#metadata.get(chatId);
    if (this.costUpdateCount(chatId) >= minimumUpdates) return current;
    const settled = Promise.withResolvers<AiChatMetadata | undefined>();
    this.#costWaiter = { chatId, minimumUpdates, resolve: settled.resolve };
    const timer = setTimeout(() => settled.resolve(this.#metadata.get(chatId)), timeoutMs);
    try {
      return await settled.promise;
    } finally {
      clearTimeout(timer);
      if (this.#costWaiter?.resolve === settled.resolve) this.#costWaiter = undefined;
    }
  }
}

class WorkpieceSubscriber extends RpcTarget implements WorkpiecesSubscriber {
  readonly entries = new Map<WorkpieceId, WorkpieceSummary>();
  readonly readiness: Promise<void>;
  #resolveReady: () => void = () => {};

  constructor() {
    super();
    const ready = Promise.withResolvers<void>();
    this.readiness = ready.promise;
    this.#resolveReady = ready.resolve;
  }

  entry(summary: WorkpieceSummary): void { this.entries.set(summary.id, summary); }
  removed(id: WorkpieceId): void { this.entries.delete(id); }
  ready(): void { this.#resolveReady(); }
}

class WorkshopAgentSessionImpl implements WorkshopAgentSession {
  readonly username: string;
  readonly #modelId: string;
  readonly #publicApi: RpcStub<PublicApi>;
  readonly #authenticatedApi: RpcStub<AuthenticatedApi>;
  readonly #workspace: RpcStub<Overseer>;
  readonly #accounts: ReadonlyMap<string, ConnectedAccount>;
  readonly #chatSubscriber = new ChatSubscriber();
  readonly #turnTimeoutMs: number;
  readonly #costAccountingTimeoutMs: number;
  readonly #pendingRpcs = new Set<Disposable>();
  #chatSubscriberStub: RpcStub<ChatSubscriber> | undefined;
  #chatSubscription: RpcStub<{}> | undefined;
  #chatId: number | undefined;
  #activeTurn: TurnObserver | undefined;
  #reserved = false;
  #closePromise: Promise<void> | undefined;
  #terminal = false;
  #closed = false;
  #lastHistory: AiChatMessage[] = [];
  #lastWorkpieces: WorkpieceSummary[] = [];
  #lastUsage: AgentTurnResult["usage"] = {};

  constructor(options: {
    username: string;
    modelId: string;
    publicApi: RpcStub<PublicApi>;
    authenticatedApi: RpcStub<AuthenticatedApi>;
    workspace: RpcStub<Overseer>;
    accounts: ReadonlyMap<string, ConnectedAccount>;
    turnTimeoutMs: number;
    costAccountingTimeoutMs: number;
  }) {
    this.username = options.username;
    this.#modelId = options.modelId;
    this.#publicApi = options.publicApi;
    this.#authenticatedApi = options.authenticatedApi;
    this.#workspace = options.workspace;
    this.#accounts = options.accounts;
    this.#turnTimeoutMs = options.turnTimeoutMs;
    this.#costAccountingTimeoutMs = options.costAccountingTimeoutMs;
  }

  async initialize(): Promise<void> {
    this.#chatSubscriberStub = stubFor(this.#chatSubscriber);
    this.#chatSubscription = await this.#workspace.subscribeToChat(this.#chatSubscriberStub);
  }

  runTurn(prompt: string, options: AgentTurnOptions = {}): Promise<AgentTurnResult> {
    this.#assertOpen();
    if (this.#activeTurn !== undefined || this.#reserved) {
      throw new Error("An agent activation is already running");
    }
    const chatId = this.#chatId;
    if (options.signal?.aborted) {
      return Promise.resolve(this.#resultWithLastState({
        status: "cancelled",
        message: "Agent activation was cancelled",
      }));
    }
    const observer = new TurnObserver(
        chatId, options.timeoutMs ?? this.#turnTimeoutMs, options.signal, prompt);
    const operation = chatId === undefined
      ? () => this.#startChat(prompt, observer)
      : () => this.#awaitRpc(
          this.#workspace.sendChatMessage(chatId, prompt, this.#modelId), chatId, observer);
    return this.#observeOperation(observer, operation);
  }

  async approveActionsAndWait(
      ids: readonly [number, ...number[]], options: AgentTurnOptions = {}): Promise<AgentTurnResult> {
    this.#assertOpen();
    const chatId = this.#chatId;
    if (chatId === undefined) throw new Error("The session has no chat to resume");
    if (this.#activeTurn !== undefined || this.#reserved) {
      throw new Error("An agent activation is already running");
    }
    if (new Set(ids).size !== ids.length) throw new Error("Action IDs must be unique");
    if (options.signal?.aborted) {
      return this.#resultWithLastState({
        status: "cancelled",
        message: "Agent activation was cancelled",
      });
    }
    this.#reserved = true;
    const observer = new TurnObserver(
        chatId, options.timeoutMs ?? this.#turnTimeoutMs, options.signal, undefined, true);
    let observationStarted = false;
    try {
      const preflight = this.#assertActionsPending(ids);
      preflight.catch(() => {});
      try {
        await observer.race(preflight);
      } catch (error) {
        const status = observer.outcome?.status;
        if (status !== "timedOut" && status !== "cancelled") throw error;
      }
      if (observer.outcome !== undefined) {
        this.#terminal = true;
        return this.#resultWithLastState(observer.outcome);
      }
      this.#assertOpen();
      observationStarted = true;
      return await this.#observeOperation(observer, async () => {
        try {
          for (const [index, id] of ids.entries()) {
            if (observer.outcome !== undefined) break;
            if (index === ids.length - 1) {
              observer.admit(this.#chatSubscriber.latestSequence(chatId));
            }
            await this.#awaitRpc(this.#workspace.approveAction(id), chatId, observer);
          }
        } catch (error) {
          this.#terminal = true;
          await this.#stopAndWaitForIdle(chatId);
          throw error;
        }
      });
    } finally {
      if (!observationStarted) observer.dispose();
      this.#reserved = false;
    }
  }

  listActions(options?: ActionListOptions): Promise<ActionHistoryPage> {
    this.#assertOpen();
    return this.#workspace.listActions(options);
  }

  connectedAccount(vendorId: string): ConnectedAccount {
    this.#assertOpen();
    const account = this.#accounts.get(vendorId);
    if (account === undefined) throw new Error(`No connected account for vendor "${vendorId}"`);
    return account;
  }

  async openGadget(id: WorkpieceId): Promise<ProvisionalGadget> {
    this.#assertNotClosed();
    const chatId = this.#chatId;
    if (chatId === undefined) throw new Error("The session has no chat branch");
    return { client: await this.#workspace.getGadget(id), chatId };
  }

  async acceptChanges(): Promise<void> {
    this.#assertOpen();
    const chatId = this.#chatId;
    if (chatId === undefined) throw new Error("The session has no chat changes to accept");
    const result = await this.#workspace.mergeChanges(chatId);
    if (result.outcome !== "merged") throw new Error("The agent changes are stale");
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async #startChat(prompt: string, observer: TurnObserver): Promise<void> {
    const creating = this.#workspace.newChat(prompt, this.#modelId);
    this.#pendingRpcs.add(creating);
    creating.then(chatId => {
      const status = observer.outcome?.status;
      if (this.#closed || status === "timedOut" || status === "cancelled") {
        Promise.resolve(this.#workspace.stopAgent(chatId)).catch(() => {});
        return;
      }
      this.#chatId = chatId;
      observer.attach(chatId);
    }, () => {}).finally(() => {
      if (this.#pendingRpcs.delete(creating)) creating[Symbol.dispose]();
    }).catch(() => {});
    this.#chatId = await creating;
    observer.attach(this.#chatId);
  }

  async #awaitRpc(
      operation: RpcPromise<void>, chatId: number, observer: TurnObserver): Promise<void> {
    this.#pendingRpcs.add(operation);
    operation.then(() => {
      const status = observer.outcome?.status;
      if (this.#closed || status === "timedOut" || status === "cancelled") {
        Promise.resolve(this.#workspace.stopAgent(chatId)).catch(() => {});
      }
    }, () => {}).finally(() => {
      if (this.#pendingRpcs.delete(operation)) operation[Symbol.dispose]();
    }).catch(() => {});
    await operation;
  }

  async #stopAndWaitForIdle(
      chatId: number, deadline = Date.now() + CANCELLATION_TIMEOUT_MS): Promise<void> {
    await this.#beforeCancellationDeadline(
        () => this.#workspace.stopAgent(chatId), deadline, "Stopping the agent timed out");
    await waitFor("timed-out agent cancellation", async () => {
      const chats = await this.#beforeCancellationDeadline(
          () => this.#workspace.listChats(), deadline,
          "Reading chat state during cancellation timed out");
      const chat = chats.find(entry => entry.id === chatId);
      return chat === undefined || chat.activeAgent === undefined ? true : null;
    }, Math.max(1, deadline - Date.now()));
  }

  async #beforeCancellationDeadline<T>(
      start: () => Promise<T>, deadline: number, message: string): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(message);
    const operation = start();
    const expired = Promise.withResolvers<never>();
    const timer = setTimeout(() => expired.reject(new Error(message)), remaining);
    operation.catch(() => {});
    try {
      return await Promise.race([operation, expired.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #observeOperation(
      observer: TurnObserver, start: () => Promise<void>): Promise<AgentTurnResult> {
    this.#activeTurn = observer;
    this.#chatSubscriber.observer = observer;
    const operation = start();
    operation.catch(() => {});
    try {
      const acknowledgementOrOutcome = Promise.race([
        operation,
        observer.result.then(() => {}),
      ]);
      try {
        await observer.race(acknowledgementOrOutcome);
      } catch (error) {
        const status = observer.outcome?.status;
        if (status !== "timedOut" && status !== "cancelled") throw error;
      }
      const outcome = observer.outcome ?? await observer.result;
      let cancellationDeadline: number | undefined;
      if (outcome.status === "timedOut" || outcome.status === "cancelled") {
        this.#terminal = true;
        cancellationDeadline = Date.now() + CANCELLATION_TIMEOUT_MS;
        const initialChatId = this.#chatId;
        if (initialChatId !== undefined) {
          await this.#beforeCancellationDeadline(
              () => this.#workspace.stopAgent(initialChatId), cancellationDeadline,
              "Stopping the agent timed out");
        }
        const dispatchSettled = Promise.withResolvers<void>();
        const timer = setTimeout(
            dispatchSettled.resolve, Math.max(0, cancellationDeadline - Date.now()));
        try {
          await Promise.race([operation.then(() => {}, () => {}), dispatchSettled.promise]);
        } finally {
          clearTimeout(timer);
        }
        if (this.#chatId !== undefined) {
          await this.#stopAndWaitForIdle(this.#chatId, cancellationDeadline);
        }
      }
      const snapshot = this.#snapshot(
          outcome, observer.startSequence, observer.endSequence, cancellationDeadline);
      if (outcome.status === "timedOut" || outcome.status === "cancelled") return await snapshot;
      try {
        return await observer.race(snapshot);
      } catch (error) {
        if (!observer.aborted) throw error;
        this.#terminal = true;
        return this.#resultWithLastState({
          status: "cancelled",
          message: "Agent activation was cancelled",
        });
      }
    } finally {
      observer.dispose();
      if (this.#chatSubscriber.observer === observer) this.#chatSubscriber.observer = undefined;
      if (this.#activeTurn === observer) this.#activeTurn = undefined;
    }
  }

  async #snapshot(
      observedOutcome: AgentTurnOutcome, startSequence: number,
      endSequence: number | undefined, cancellationDeadline?: number): Promise<AgentTurnResult> {
    const chatId = this.#chatId;
    if (chatId === undefined) {
      return { outcome: observedOutcome, history: [], workpieces: [], usage: {} };
    }
    const loadState = () => Promise.all([
      loadAllChatHistory(before => this.#workspace.getChatHistory(chatId, before)),
      this.#workspace.listChats(),
      this.#loadWorkpieces(),
    ]);
    const [loadedHistory, chats, workpieces] = cancellationDeadline === undefined
      ? await loadState()
      : await this.#beforeCancellationDeadline(
          loadState, cancellationDeadline, "Reading cancelled turn state timed out");
    const history = endSequence === undefined
      ? loadedHistory
      : loadedHistory.filter(message => message.sequence <= endSequence);
    const newMessages = history.filter(message => message.sequence > startSequence);
    const error = newMessages.find(message => message.type === "error");
    let outcome: AgentTurnOutcome = observedOutcome;
    if (error !== undefined && observedOutcome.status !== "timedOut" &&
        observedOutcome.status !== "cancelled") {
      outcome = error.code === undefined
        ? { status: "error", message: error.message }
        : { status: "error", message: error.message, code: error.code };
    }
    let metadata = chats.find(chat => chat.id === chatId);
    if (metadata === undefined) throw new Error(`Chat ${chatId} disappeared`);
    const modelSteps = history.filter(
        message => message.type === "message" && message.author.type === "agent").length;
    if (outcome.status === "completed" && this.#costAccountingTimeoutMs > 0 && modelSteps > 0) {
      metadata = await this.#chatSubscriber.waitForCostUpdates(
          chatId, modelSteps, this.#costAccountingTimeoutMs) ?? metadata;
    }
    const usage: AgentTurnResult["usage"] = {};
    if (metadata.totalTokens !== undefined) usage.lastStepTokens = metadata.totalTokens;
    if (metadata.totalCost !== undefined) {
      usage.observedCumulativeChatCostUsd = metadata.totalCost;
    }
    this.#lastHistory = history;
    this.#lastWorkpieces = workpieces;
    this.#lastUsage = usage;
    return { outcome, history, workpieces, usage };
  }

  #resultWithLastState(outcome: AgentTurnOutcome): AgentTurnResult {
    return {
      outcome,
      history: [...this.#lastHistory],
      workpieces: [...this.#lastWorkpieces],
      usage: { ...this.#lastUsage },
    };
  }

  async #loadWorkpieces(): Promise<WorkpieceSummary[]> {
    const subscriber = new WorkpieceSubscriber();
    using subscriberStub = stubFor(subscriber);
    using _subscription = await this.#workspace.subscribeToWorkpieces(subscriberStub);
    await subscriber.readiness;
    return [...subscriber.entries.values()];
  }

  async #assertActionsPending(ids: readonly number[]): Promise<void> {
    const pending = new Set(ids);
    let beforeId: number | undefined;
    do {
      const page = await this.#workspace.listActions({ beforeId, filter: "pending" });
      for (const entry of page.entries) pending.delete(entry.id);
      beforeId = page.nextBeforeId;
    } while (pending.size > 0 && beforeId !== undefined);
    if (pending.size > 0) {
      throw new Error(`Actions are not pending: ${[...pending].join(", ")}`);
    }
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const deadline = Date.now() + CANCELLATION_TIMEOUT_MS;
    let stopError: Error | undefined;
    let deleteError: Error | undefined;
    try {
      try {
        if (this.#activeTurn !== undefined && this.#chatId !== undefined) {
          await this.#stopAndWaitForIdle(this.#chatId, deadline);
        }
        if (this.#pendingRpcs.size > 0) {
          const pendingDeadline = Math.min(
              deadline, Date.now() + PENDING_RPC_GRACE_MS);
          await waitFor("pending agent RPC cleanup", () =>
            Promise.resolve(this.#pendingRpcs.size === 0 ? true : null),
          Math.max(1, pendingDeadline - Date.now()));
        }
      } catch (error) {
        stopError = error instanceof Error ? error : new Error(String(error));
      }
      try {
        await this.#beforeCancellationDeadline(
            () => this.#workspace.deleteSelf(), Date.now() + CANCELLATION_TIMEOUT_MS,
            "Workspace deletion timed out");
      } catch (error) {
        deleteError = error instanceof Error ? error : new Error(String(error));
      }
    } finally {
      this.#chatSubscription?.[Symbol.dispose]();
      this.#chatSubscriberStub?.[Symbol.dispose]();
      for (const rpc of this.#pendingRpcs) rpc[Symbol.dispose]();
      this.#pendingRpcs.clear();
      this.#workspace[Symbol.dispose]();
      this.#authenticatedApi[Symbol.dispose]();
      this.#publicApi[Symbol.dispose]();
    }
    if (stopError !== undefined && deleteError !== undefined) {
      throw new AggregateError([stopError, deleteError], "Agent shutdown and workspace deletion failed");
    }
    if (stopError !== undefined) throw stopError;
    if (deleteError !== undefined) throw deleteError;
  }

  #assertOpen(): void {
    this.#assertNotClosed();
    if (this.#terminal) throw new Error("WorkshopAgentSession cannot continue after interruption");
  }

  #assertNotClosed(): void {
    if (this.#closed) throw new Error("WorkshopAgentSession is closed");
  }
}

/** Open one fresh local account and workspace for deterministic tests or real-model evals. */
export async function openAgentSession(
    baseUrl: URL, options: AgentSessionOptions): Promise<WorkshopAgentSession> {
  const publicApi = connect(baseUrl);
  let authenticatedApi: RpcStub<AuthenticatedApi> | undefined;
  let workspace: RpcStub<Overseer> | undefined;
  let session: WorkshopAgentSessionImpl | undefined;
  try {
    const username = nextUsernames(options.usernamePrefix ?? "agent").at(0);
    if (username === undefined) throw new Error("Failed to allocate an agent-session username");
    const authenticated = authenticatedApi = await signUp(publicApi, username);
    if (options.userModel !== undefined) {
      await authenticated.addModel(options.userModel.profile, options.userModel.config);
    }
    const models = await authenticated.listModels();
    if (!models.some(model => model.id === options.modelId)) {
      throw new Error(`Model "${options.modelId}" is not available to the test account`);
    }
    await authenticated.setQuickModel(null);
    await authenticated.setPreferredModel(options.modelId);
    await authenticated.completeOnboarding();

    const accounts = new Map<string, ConnectedAccount>();
    for (const vendorId of options.ambientVendorIds ?? []) {
      await authenticated.provisionAmbientAccount(vendorId);
      const account = await waitFor(`the ${vendorId} account to be provisioned`, async () =>
        (await listConnectedAccounts(authenticated)).find(entry => entry.vendorId === vendorId)
          ?? null);
      accounts.set(vendorId, account);
    }

    workspace = await authenticated.newGadget();
    session = new WorkshopAgentSessionImpl({
      username,
      modelId: options.modelId,
      publicApi,
      authenticatedApi,
      workspace,
      accounts,
      turnTimeoutMs: options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      costAccountingTimeoutMs: options.costAccountingTimeoutMs ?? 0,
    });
    await session.initialize();
    return session;
  } catch (error) {
    const setupError = error instanceof Error ? error : new Error(String(error));
    let cleanupError: Error | undefined;
    try {
      if (session !== undefined) {
        await session.close();
      } else {
        workspace?.[Symbol.dispose]();
        authenticatedApi?.[Symbol.dispose]();
        publicApi[Symbol.dispose]();
      }
    } catch (cleanup) {
      cleanupError = cleanup instanceof Error ? cleanup : new Error(String(cleanup));
    }
    if (cleanupError !== undefined) {
      throw new Error(`Agent session setup failed; cleanup also failed: ${cleanupError.message}`,
          { cause: error });
    }
    throw setupError;
  }
}

/** Load every compacted page of one canonical chat history in ascending sequence order. */
export async function loadAllChatHistory(
    loadPage: (beforeSequence?: number) => Promise<AiChatHistoryPage>): Promise<AiChatMessage[]> {
  let page = await loadPage();
  let messages = page.messages;
  const boundaries = new Set<number>();
  while (page.compacted !== undefined) {
    const boundary = page.compacted.to;
    if (boundaries.has(boundary)) {
      throw new Error(`Chat history repeated compaction boundary ${boundary}`);
    }
    boundaries.add(boundary);
    page = await loadPage(boundary);
    messages = [...page.messages, ...messages];
  }
  return messages;
}
