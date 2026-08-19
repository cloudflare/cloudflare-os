import type { RpcCompatible, RpcStub } from "capnweb";
import type {
  AiChatMessage, AiChatMetadata, AiChatStreamEvent, AiChatSubscriber, AiChatAuthorInfo,
  AuthenticatedApi, CodeSubscriber, CodeUpdate, GadgetClient, OutputFormatOffer, Overseer, PublicApi,
  WorkpieceId, WorkpieceSummary, WorkpiecesSubscriber,
} from "@gadgets/workshop-shared/api";
import * as Y from "yjs";
import {
  AgentTurnCompletion, buildSourceSnapshot, loadAllChatHistory,
} from "./agent-session-internals.js";
import type { SourceSnapshot } from "./agent-session-internals.js";
import { RpcTarget, connect, nextUsernames, signUp, stubFor, waitFor } from "./rpc-client.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SETTLE_DEBOUNCE_MS = 500;

function connectTyped<Session extends RpcCompatible<Session>>(
    gadget: RpcStub<GadgetClient>, chatId?: number): Promise<RpcStub<Session>>;
function connectTyped(gadget: RpcStub<GadgetClient>, chatId?: number) {
  return gadget.connectToGadget(chatId);
}

/** Options for creating an isolated production Workshop agent session. */
export type AgentSessionOptions = {
  /** Model to use. It must appear in the new workspace's `listModels()` result. Defaults to the first. */
  modelId?: string;
  /** Alphanumeric prefix for the fresh account name. */
  usernamePrefix?: string;
  /** Hard limit for each agent turn. Defaults to two minutes. */
  timeoutMs?: number;
};

/** Options for one prompt in an agent session. */
export type AgentTurnOptions = {
  /** Merge all proposed changes, including the current live draft, after the agent settles. */
  acceptChanges?: boolean;
  /** Cancels the turn by calling `stopAgent()` and rejecting the run. */
  signal?: AbortSignal;
};

/** The branch a verifier should connect to. */
export type AgentGadgetBranch = "accepted" | "chat";

/** Sources accepted from a turn, keyed by each `WorkpieceSummary.filesRoot`. */
export type AgentSourceSnapshot = SourceSnapshot;

/** Authoritative state returned after one agent turn settles. */
export type AgentTurnResult = {
  /** Chat created by the first turn and reused by later turns. */
  chatId: number;
  /** Complete canonical chat history in ascending sequence order. */
  history: AiChatMessage[];
  /** Workpieces known when the turn finished. */
  workpieces: WorkpieceSummary[];
  /** Agent error messages posted during the turn. Empty when the turn completed normally. */
  agentErrors: string[];
  /** Present only when `acceptChanges` was requested. */
  source?: AgentSourceSnapshot;
};

/** Return the final user-visible assistant text from canonical chat history. */
export function finalAssistantText(history: readonly AiChatMessage[]): string {
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index];
    if (entry?.type === "message" && entry.author.type === "agent" && entry.message !== "") {
      return entry.message;
    }
  }
  return "";
}

class ChatSubscriber extends RpcTarget implements AiChatSubscriber {
  completion: AgentTurnCompletion | undefined;

  streamGeneration(_generation: number): void {}
  metadata(chat: AiChatMetadata): void { this.completion?.metadata(chat); }
  deleted(_chatId: number): void {}
  message(_entry: AiChatMessage): void {}
  draftUpdate(
      _chatId: number, _timestamp: Date, _author: AiChatAuthorInfo, _update: Uint8Array): void {}
  draftCleared(_chatId: number): void {}
  stream(_chatId: number, _event: AiChatStreamEvent): void {}
}

class WorkpieceSubscriber extends RpcTarget implements WorkpiecesSubscriber {
  readonly entries = new Map<WorkpieceId, WorkpieceSummary>();
  readonly readyPromise: Promise<void>;
  #resolveReady: () => void = () => {};

  constructor() {
    super();
    this.readyPromise = new Promise<void>(resolve => { this.#resolveReady = resolve; });
  }

  entry(summary: WorkpieceSummary): void { this.entries.set(summary.id, summary); }
  removed(id: WorkpieceId): void { this.entries.delete(id); }
  ready(): void { this.#resolveReady(); }
}

class SourceSubscriber extends RpcTarget implements CodeSubscriber {
  readonly readyPromise: Promise<void>;
  version = 0;
  #doc: Y.Doc;
  #resolveReady: () => void = () => {};

  constructor(doc: Y.Doc) {
    super();
    this.#doc = doc;
    this.readyPromise = new Promise<void>(resolve => { this.#resolveReady = resolve; });
  }

  update(update: CodeUpdate): void {
    Y.applyUpdateV2(this.#doc, update.update);
    this.version = update.version;
  }

  ready(): void { this.#resolveReady(); }
}

/**
 * Drives the production Workshop RPC lifecycle for one fresh user and workspace.
 *
 * The class deliberately does not interpret agent output. Callers own verification and evaluation.
 * Dispose the session when finished; verifier stubs returned by this class remain caller-owned.
 */
export class AgentSession implements Disposable {
  /** Model selected from the workspace's `listModels()` result. */
  readonly modelId: string;
  /** ID of the fresh workspace owned by this session's fresh user. */
  readonly workspaceId: string;
  #publicApi: RpcStub<PublicApi>;
  #authenticatedApi: RpcStub<AuthenticatedApi>;
  #overseer: RpcStub<Overseer>;
  #chatSubscriber = new ChatSubscriber();
  #chatSubscriberStub: RpcStub<ChatSubscriber> | undefined;
  #chatSubscription: RpcStub<{}> | undefined;
  #workpieceSubscriber = new WorkpieceSubscriber();
  #workpieceSubscriberStub: RpcStub<WorkpieceSubscriber> | undefined;
  #workpieceSubscription: RpcStub<{}> | undefined;
  #chatId: number | undefined;
  #turn: AgentTurnCompletion | undefined;
  #timeoutMs: number;
  #settleDebounceMs: number;
  #disposed = false;
  #failed = false;

  private constructor(
      publicApi: RpcStub<PublicApi>,
      authenticatedApi: RpcStub<AuthenticatedApi>,
      overseer: RpcStub<Overseer>,
      workspaceId: string,
      modelId: string,
      timeoutMs: number) {
    this.#publicApi = publicApi;
    this.#authenticatedApi = authenticatedApi;
    this.#overseer = overseer;
    this.workspaceId = workspaceId;
    this.modelId = modelId;
    this.#timeoutMs = timeoutMs;
    this.#settleDebounceMs = DEFAULT_SETTLE_DEBOUNCE_MS;
  }

  /** Create a fresh account and workspace, then establish subscriptions before any chat starts. */
  static async create(baseUrl: URL, options: AgentSessionOptions = {}): Promise<AgentSession> {
    const publicApi = connect(baseUrl);
    let authenticatedApi: RpcStub<AuthenticatedApi> | undefined;
    let overseer: RpcStub<Overseer> | undefined;
    let session: AgentSession | undefined;
    try {
      const username = nextUsernames(options.usernamePrefix ?? "agent").at(0);
      if (username === undefined) throw new Error("Failed to allocate an integration-test username");
      authenticatedApi = await signUp(publicApi, username);
      overseer = await authenticatedApi.newGadget();
      const [metadata, models] = await Promise.all([
        overseer.getMetadata(),
        overseer.listModels(),
      ]);
      const modelId = AgentSession.#selectModel(models, options.modelId);
      session = new AgentSession(
          publicApi, authenticatedApi, overseer, metadata.id, modelId,
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      await session.#initializeSubscriptions();
      return session;
    } catch (error) {
      if (session === undefined) {
        overseer?.[Symbol.dispose]();
        authenticatedApi?.[Symbol.dispose]();
        publicApi[Symbol.dispose]();
      } else {
        session[Symbol.dispose]();
      }
      throw error;
    }
  }

  /**
   * Send a prompt. The first call creates a chat; later calls continue that same chat.
   * History is fetched through every compaction page after the turn settles.
   */
  async run(prompt: string, options: AgentTurnOptions = {}): Promise<AgentTurnResult> {
    this.#assertUsable();
    if (this.#turn !== undefined) throw new Error("An agent turn is already running");

    const existingChatId = this.#chatId ?? null;
    const completion = new AgentTurnCompletion(
        existingChatId,
        () => this.#stopCurrentAgent(),
        this.#timeoutMs,
        this.#settleDebounceMs,
        options.signal);
    this.#turn = completion;
    this.#chatSubscriber.completion = completion;
    try {
      if (this.#chatId === undefined) {
        this.#chatId = await this.#overseer.newChat(prompt, this.modelId);
        completion.attach(this.#chatId);
      } else {
        await this.#overseer.sendChatMessage(this.#chatId, prompt, this.modelId);
      }
      await completion.promise;

      let history = await this.#loadHistory(this.#chatId);
      let source: AgentSourceSnapshot | undefined;
      if (options.acceptChanges) {
        source = await this.#acceptChanges(this.#chatId, history);
        history = await this.#loadHistory(this.#chatId);
      }
      return {
        chatId: this.#chatId,
        history,
        workpieces: this.workpieces(),
        agentErrors: history.flatMap(entry => entry.type === "error" ? [entry.message] : []),
        ...(source === undefined ? {} : { source }),
      };
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      completion.dispose();
      if (this.#chatSubscriber.completion === completion) {
        this.#chatSubscriber.completion = undefined;
      }
      if (this.#turn === completion) this.#turn = undefined;
    }
  }

  /** Stop and reject the active turn. Does nothing while idle. */
  cancel(): void {
    this.#turn?.cancel();
  }

  /** Current workpieces discovered through `subscribeToWorkpieces()`. */
  workpieces(): WorkpieceSummary[] {
    return [...this.#workpieceSubscriber.entries.values()];
  }

  /** Obtain a caller-owned verifier capability for one gadget workpiece. */
  getGadget(id: WorkpieceId): Promise<RpcStub<GadgetClient>> {
    this.#assertUsable();
    return this.#overseer.getGadget(id);
  }

  /**
   * Connect a caller-owned, typed verifier stub to accepted code or this session's chat branch.
   */
  async connectToGadget<Session extends RpcCompatible<Session>>(
      id: WorkpieceId, branch: AgentGadgetBranch = "chat"): Promise<RpcStub<Session>> {
    this.#assertUsable();
    using gadget = await this.#overseer.getGadget(id);
    if (branch === "chat" && this.#chatId === undefined) {
      throw new Error("The session has no chat branch yet");
    }
    return connectTyped<Session>(gadget, branch === "chat" ? this.#chatId : undefined);
  }

  /**
   * Wait until the deployment's standard output formats are installed.
   *
   * Installation is fire-and-forget on the first `/api` request — the same request that opens this
   * session — so a turn started immediately can race it and get a system prompt with no formats
   * section, silently changing what the agent is told it can instantiate.
   */
  async waitForOutputFormats(): Promise<OutputFormatOffer[]> {
    this.#assertUsable();
    return waitFor(
        "the output formats to install (is workshop-backend built? see its README)", async () => {
      const offers = await this.#authenticatedApi.listOutputFormats();
      return offers.length > 0 ? offers : null;
    });
  }

  /**
   * Create a gadget with hand-written source, bypassing the agent entirely.
   *
   * For tests that need a known implementation — a deliberately broken one to prove an assertion
   * can fail, or a deliberately correct one to measure the platform rather than the model. The
   * gadget is permanent rather than provisional to a chat, so connect to it on the accepted branch.
   *
   * `files` must contain `server.js` exporting a Durable Object class named `Gadget`; only `.js`
   * entries become worker modules.
   */
  async seedGadget(spec: {
    title: string;
    bindingName: string;
    files: Record<string, string>;
  }): Promise<WorkpieceId> {
    this.#assertUsable();
    using gadget = await this.#overseer.createGadget(spec.title, undefined, spec.bindingName);
    const id = await gadget.getId();
    // The server owns the files root, so read it back rather than re-deriving the naming rule.
    const filesRoot = await waitFor(`workpiece ${id} to publish its files root`, async () =>
      this.#workpieceSubscriber.entries.get(id)?.filesRoot ?? null);

    const doc = new Y.Doc();
    const subscriber = new SourceSubscriber(doc);
    using subscriberStub = stubFor(subscriber);
    let subscription: RpcStub<{}> | undefined;
    const updates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => { updates.push(update); };
    try {
      // Sync the doc before writing. A write from an unsynced doc is a concurrent Y.Map set that
      // resolves by client ID, i.e. a coin flip; a write from a synced one carries a causal delete
      // of the existing entry and deterministically wins.
      subscription = await this.#overseer.subscribeToCode(subscriberStub);
      await subscriber.readyPromise;
      doc.on("updateV2", collect);
      doc.transact(() => {
        const root = doc.getMap<Y.Text>(filesRoot);
        for (const [name, content] of Object.entries(spec.files)) {
          const text = new Y.Text();
          text.insert(0, content);
          root.set(name, text);
        }
      });
      doc.off("updateV2", collect);
      if (updates.length === 0) throw new Error("Seeding a gadget produced no code update");
      // updateCode bumps the workspace code version, which both aborts the facet and changes the
      // Worker Loader cache key, so the next connect loads exactly what was just written.
      await this.#overseer.updateCode(Y.mergeUpdatesV2(updates));
      return id;
    } finally {
      doc.off("updateV2", collect);
      subscription?.[Symbol.dispose]();
      doc.destroy();
    }
  }

  /**
   * Abruptly restart every Gadget server in this workspace, as the platform itself does whenever
   * code changes. Storage is preserved; in-memory state is discarded.
   *
   * Existing gadget stubs are invalidated and throw on their next call, so callers must reconnect —
   * which is also how a caller proves the restart really happened rather than silently no-opping.
   *
   * Implemented as an empty update to the mainline code, which advances the workspace's code
   * version. That is what forces the restart, and it is also why this must not be called *between*
   * turns of a multi-turn conversation: the agent stamps the code version it observed onto its
   * history and rejects an inconsistent one on replay. Call it within the final turn, or in a
   * single-turn task.
   */
  async restartGadgets(): Promise<void> {
    this.#assertUsable();
    if (this.#turn !== undefined) {
      throw new Error("Cannot restart gadgets while an agent turn is running");
    }
    await this.#overseer.updateCode(Y.encodeStateAsUpdateV2(new Y.Doc()));
  }

  /** Merge the current provisional chat branch and return its accepted source snapshot. */
  async acceptChanges(): Promise<AgentSourceSnapshot> {
    this.#assertUsable();
    if (this.#turn !== undefined) throw new Error("Cannot accept changes while an agent turn is running");
    if (this.#chatId === undefined) throw new Error("The session has no chat branch to accept");
    const history = await this.#loadHistory(this.#chatId);
    return this.#acceptChanges(this.#chatId, history);
  }

  async #acceptChanges(chatId: number, history: readonly AiChatMessage[]): Promise<AgentSourceSnapshot> {
    const mergeThrough = history.at(-1)?.sequence ?? null;
    await this.#overseer.mergeChanges(chatId, mergeThrough, { includeDraft: true });
    return this.#readAcceptedSource();
  }

  /** Dispose subscriptions, callback targets, RPC capabilities, and the WebSocket session. */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#turn?.cancel();
    this.#turn?.dispose();
    this.#chatSubscription?.[Symbol.dispose]();
    this.#workpieceSubscription?.[Symbol.dispose]();
    this.#chatSubscriberStub?.[Symbol.dispose]();
    this.#workpieceSubscriberStub?.[Symbol.dispose]();
    this.#overseer[Symbol.dispose]();
    this.#authenticatedApi[Symbol.dispose]();
    this.#publicApi[Symbol.dispose]();
  }

  async #initializeSubscriptions(): Promise<void> {
    this.#chatSubscriberStub = stubFor(this.#chatSubscriber);
    this.#chatSubscription = await this.#overseer.subscribeToChat(this.#chatSubscriberStub);
    this.#workpieceSubscriberStub = stubFor(this.#workpieceSubscriber);
    this.#workpieceSubscription = await this.#overseer.subscribeToWorkpieces(
        this.#workpieceSubscriberStub);
    await this.#workpieceSubscriber.readyPromise;
  }

  async #loadHistory(chatId: number): Promise<AiChatMessage[]> {
    return loadAllChatHistory(before => this.#overseer.getChatHistory(chatId, before));
  }

  async #readAcceptedSource(): Promise<AgentSourceSnapshot> {
    const doc = new Y.Doc();
    const subscriber = new SourceSubscriber(doc);
    using subscriberStub = stubFor(subscriber);
    let subscription: RpcStub<{}> | undefined;
    try {
      subscription = await this.#overseer.subscribeToCode(subscriberStub);
      await subscriber.readyPromise;
      return buildSourceSnapshot(doc, subscriber.version, this.workpieces());
    } finally {
      subscription?.[Symbol.dispose]();
      doc.destroy();
    }
  }

  #stopCurrentAgent(): Promise<void> {
    if (this.#chatId === undefined) return Promise.resolve();
    return this.#overseer.stopAgent(this.#chatId);
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error("AgentSession is disposed");
    if (this.#failed) throw new Error("AgentSession cannot be reused after a failed or cancelled turn");
  }

  static #selectModel(models: AiChatAuthorInfo[], requested: string | undefined): string {
    if (models.length === 0) throw new Error("The Workshop exposes no configured agent models");
    if (requested === undefined) {
      const first = models.at(0);
      if (first === undefined) throw new Error("The Workshop exposes no configured agent models");
      return first.id;
    }
    if (!models.some(model => model.id === requested)) {
      throw new Error(`Model "${requested}" is not exposed by this workspace`);
    }
    return requested;
  }
}
