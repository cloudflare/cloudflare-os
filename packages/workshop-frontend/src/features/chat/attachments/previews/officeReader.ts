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

  /** @param latestOnly A new read abandons the ones before it: the viewer shows one file at a time. */
  constructor(private readonly latestOnly: boolean) {}

  add(job: Job) {
    if (this.latestOnly) {
      const superseded = new DOMException("Another file was opened", "AbortError");
      for (const waiting of this.#queue.splice(0)) waiting.reject(superseded);
      if (this.#running && this.#running.request.bytes !== job.request.bytes) this.#stop(superseded);
    }
    this.#queue.push(job);
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
 * the file someone opened. Opening a file stops the read of one opened before it.
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
