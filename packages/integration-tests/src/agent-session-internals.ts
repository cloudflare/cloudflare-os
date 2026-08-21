import type {
  AiChatHistoryPage, AiChatMessage, AiChatMetadata, WorkpieceSummary,
} from "@gadgets/workshop-shared/api";
import * as Y from "yjs";

export type SourceWorkpiece = {
  /** Workpiece whose `filesRoot` keys this entry. */
  summary: WorkpieceSummary;
  /** UTF-8 source text keyed by file name. */
  files: ReadonlyMap<string, string>;
};

export type SourceSnapshot = {
  /** Workshop code version included in the snapshot. */
  version: number;
  /** Source-bearing workpieces keyed by `WorkpieceSummary.filesRoot`. */
  workpieces: ReadonlyMap<string, SourceWorkpiece>;
};

export class AgentTurnCompletion {
  readonly promise: Promise<void>;
  #chatId: number | null;
  #resolve: () => void = () => {};
  #reject: (error: Error) => void = () => {};
  #stopAgent: () => Promise<void>;
  #settleDebounceMs: number;
  #hardTimeout: ReturnType<typeof setTimeout> | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #signal: AbortSignal | undefined;
  #sawActive = false;
  #isSettled = false;
  #stopRequested = false;
  #pendingMetadata: AiChatMetadata[] = [];

  constructor(
      chatId: number | null,
      stopAgent: () => Promise<void>,
      timeoutMs: number,
      settleDebounceMs: number,
      signal?: AbortSignal) {
    this.#chatId = chatId;
    this.#stopAgent = stopAgent;
    this.#settleDebounceMs = settleDebounceMs;
    this.#signal = signal;
    this.promise = new Promise<void>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = error => reject(error);
    });
    // Mark the promise handled while the RPC that reveals a new chat ID is still in flight.
    this.promise.catch(() => {});
    this.#hardTimeout = setTimeout(() => {
      this.#stopRequested = true;
      this.#requestStop();
      this.#fail(new Error(`Timed out after ${timeoutMs}ms waiting for the agent turn`));
    }, timeoutMs);
    signal?.addEventListener("abort", this.#onAbort, { once: true });
    if (signal?.aborted) this.#onAbort();
  }

  get settled(): boolean {
    return this.#isSettled;
  }

  attach(chatId: number): void {
    if (this.#chatId !== null && this.#chatId !== chatId) {
      throw new Error(`Agent turn is already attached to chat ${this.#chatId}`);
    }
    this.#chatId = chatId;
    const metadata = this.#pendingMetadata;
    this.#pendingMetadata = [];
    for (const entry of metadata) this.metadata(entry);
    if (this.#stopRequested) this.#requestStop();
  }

  metadata(chat: AiChatMetadata): void {
    if (this.#chatId === null) {
      this.#pendingMetadata.push(chat);
      return;
    }
    if (chat.id !== this.#chatId) return;
    if (this.#isSettled) {
      if (chat.activeAgent && this.#stopRequested) this.#requestStop();
      return;
    }
    if (chat.activeAgent) {
      this.#sawActive = true;
      this.#clearIdleTimer();
    } else if (this.#sawActive) {
      this.#clearIdleTimer();
      this.#idleTimer = setTimeout(() => this.#succeed(), this.#settleDebounceMs);
    }
  }

  cancel(): void {
    if (this.#isSettled) return;
    this.#stopRequested = true;
    this.#requestStop();
    this.#fail(new Error("Agent turn was cancelled"));
  }

  dispose(): void {
    this.#clearTimers();
    this.#signal?.removeEventListener("abort", this.#onAbort);
  }

  #onAbort = (): void => {
    this.cancel();
  };

  #requestStop(): void {
    if (this.#chatId !== null) this.#stopAgent().catch(() => {});
  }

  #succeed(): void {
    if (this.#isSettled) return;
    this.#isSettled = true;
    this.dispose();
    this.#resolve();
  }

  #fail(error: Error): void {
    if (this.#isSettled) return;
    this.#isSettled = true;
    this.dispose();
    this.#reject(error);
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  #clearTimers(): void {
    this.#clearIdleTimer();
    if (this.#hardTimeout !== undefined) clearTimeout(this.#hardTimeout);
    this.#hardTimeout = undefined;
  }
}

export async function loadAllChatHistory(
    loadPage: (beforeSequence?: number) => Promise<AiChatHistoryPage>): Promise<AiChatMessage[]> {
  let page = await loadPage();
  let messages = page.messages;
  const boundaries = new Set<number>();
  while (page.compacted) {
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

export function buildSourceSnapshot(
    doc: Y.Doc, version: number, summaries: readonly WorkpieceSummary[]): SourceSnapshot {
  const workpieces = new Map<string, SourceWorkpiece>();
  for (const summary of summaries) {
    if (summary.filesRoot === undefined) continue;
    const files = new Map<string, string>();
    doc.getMap<Y.Text>(summary.filesRoot).forEach((text, name) => {
      files.set(name, text.toString());
    });
    workpieces.set(summary.filesRoot, { summary, files });
  }
  return { version, workpieces };
}
