import type { OfficeRead, OfficeReadOptions, OfficeReadRequest, OfficeReadResponse, OfficeReadResult } from "./officeReads";

interface Job {
  readonly request: OfficeReadRequest;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * A worker and the files waiting for it, read one at a time so that stopping the worker for one
 * never costs another its work. The worker starts with the first file and again after a stop.
 */
class ReadingLane {
  #worker: Worker | undefined;
  #running: Job | undefined;
  readonly #queue: Job[] = [];

  /**
   * @param latestFirst A new read goes first: the file just opened is read before any opened
   * before it, whose read is put back to finish after it. Nothing is given up on, so two viewers
   * showing at once never take turns stopping each other.
   */
  constructor(private readonly latestFirst: boolean) {}

  add(job: Job) {
    if (!this.latestFirst) {
      this.#queue.push(job);
      return this.#pump();
    }
    this.#queue.unshift(job);
    const running = this.#running;
    if (running && running.request.bytes !== job.request.bytes) {
      // Stopped, not failed: it starts again, from the beginning, once the new one is read.
      this.#running = undefined;
      this.#worker?.terminate();
      this.#worker = undefined;
      this.#queue.splice(1, 0, running);
    }
    this.#pump();
  }

  /** Drops a job still waiting, or stops the worker for the one it is reading. */
  cancel(job: Job, reason: unknown) {
    const waiting = this.#queue.indexOf(job);
    if (waiting >= 0) {
      this.#queue.splice(waiting, 1);
      job.reject(reason);
    } else if (this.#running === job) {
      this.#stop(reason);
    }
  }

  #start(): Worker {
    const worker = new Worker(new URL("./officeReader.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<OfficeReadResponse>) => {
      const job = this.#running;
      if (!job || job.request.id !== event.data.id) return;
      this.#running = undefined;
      if ("error" in event.data) job.reject(new Error(event.data.error));
      else job.resolve(event.data.result);
      this.#pump();
    });
    // A worker that fails to start or dies takes its file with it; the next file gets a new one.
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      this.#stop(new Error("The file couldn’t be read."));
    });
    return worker;
  }

  #stop(reason: unknown) {
    this.#worker?.terminate();
    this.#worker = undefined;
    const job = this.#running;
    this.#running = undefined;
    job?.reject(reason);
    this.#pump();
  }

  #pump() {
    if (this.#running) return;
    const job = this.#queue.shift();
    if (!job) return;
    this.#running = job;
    this.#worker ??= this.#start();
    // Copied to the worker, not moved: the caller keeps its bytes for the viewer and for downloads.
    // A Worker takes no target origin.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    this.#worker.postMessage(job.request);
  }
}

/**
 * Files someone opened and cards' thumbnails are read in workers of their own: a large file left
 * reading in a closed viewer never holds up the cards, and a chat full of cards never holds up
 * the file someone opened. Opening a file reads it first, ahead of one opened before it.
 */
const lanes = { viewer: new ReadingLane(true), cards: new ReadingLane(false) };

let nextId = 0;

/** How a read is made. */
export interface OfficeReadHow {
  /** Aborting it drops the read if it is still waiting, or stops its worker if it has started. */
  readonly signal?: AbortSignal;
  /** Whose read it is: the open viewer's, or a card's. */
  readonly lane?: keyof typeof lanes;
}

const aborted = (signal: AbortSignal) => signal.reason ?? new DOMException("Aborted", "AbortError");

/** Reads an Office file in a worker, so that however long a file takes, the page stays responsive. */
export const readOffice = <R extends OfficeRead>(
  read: R,
  bytes: Uint8Array,
  options: OfficeReadOptions<R>,
  { signal, lane = "cards" }: OfficeReadHow = {},
): Promise<OfficeReadResult<R>> => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(aborted(signal));
    return;
  }
  const job: Job = {
    request: { id: nextId++, read, bytes, options },
    resolve: (result) => resolve(result as OfficeReadResult<R>),
    reject,
  };
  signal?.addEventListener("abort", () => lanes[lane].cancel(job, aborted(signal)), { once: true });
  lanes[lane].add(job);
});
