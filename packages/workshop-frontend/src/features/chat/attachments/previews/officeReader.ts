import type { OfficeRead, OfficeReadOptions, OfficeReadRequest, OfficeReadResponse, OfficeReadResult } from "./officeReads";

interface Job {
  readonly request: OfficeReadRequest;
  readonly ahead: boolean;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
}

let worker: Worker | undefined;
let running: Job | undefined;
const queue: Job[] = [];
let nextId = 0;

const settle = (job: Job, response: OfficeReadResponse) => {
  if ("error" in response) job.reject(new Error(response.error));
  else job.resolve(response.result);
};

const startWorker = (): Worker => {
  const started = new Worker(new URL("./officeReader.worker.ts", import.meta.url), { type: "module" });
  started.addEventListener("message", (event: MessageEvent<OfficeReadResponse>) => {
    const job = running;
    if (!job || job.request.id !== event.data.id) return;
    running = undefined;
    settle(job, event.data);
    pump();
  });
  // A worker that fails to start or dies takes its file with it; the next file gets a new one.
  started.addEventListener("error", (event) => {
    event.preventDefault();
    stopWorker(new Error("The file couldn’t be read."));
  });
  return started;
};

const stopWorker = (reason: unknown) => {
  worker?.terminate();
  worker = undefined;
  const job = running;
  running = undefined;
  job?.reject(reason);
  pump();
};

// One file at a time, so stopping the worker for one never costs another its work.
const pump = () => {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = job;
  worker ??= startWorker();
  // Copied to the worker, not moved: the caller keeps its bytes for the viewer and for downloads.
  // A Worker takes no target origin.
  // eslint-disable-next-line unicorn/require-post-message-target-origin
  worker.postMessage(job.request);
};

const aborted = (signal: AbortSignal | undefined) => signal?.reason ?? new DOMException("Aborted", "AbortError");

/** How a read is queued. */
export interface OfficeReadHow {
  /** Aborting it drops the read if it is still waiting, or stops the worker if it has started. */
  readonly signal?: AbortSignal;
  /** Read before the reads waiting that are not: a file someone opened, ahead of cards' thumbnails. */
  readonly ahead?: boolean;
}

/** Reads an Office file in a worker, so that however long a file takes, the page stays responsive. */
export const readOffice = <R extends OfficeRead>(
  read: R,
  bytes: Uint8Array,
  options: OfficeReadOptions<R>,
  { signal, ahead = false }: OfficeReadHow = {},
): Promise<OfficeReadResult<R>> => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(aborted(signal));
    return;
  }
  const job: Job = {
    request: { id: nextId++, read, bytes, options },
    ahead,
    resolve: (result) => resolve(result as OfficeReadResult<R>),
    reject,
  };
  signal?.addEventListener("abort", () => {
    const waiting = queue.indexOf(job);
    if (waiting >= 0) {
      queue.splice(waiting, 1);
      reject(aborted(signal));
    } else if (running === job) {
      stopWorker(aborted(signal));
    }
  }, { once: true });
  const behind = ahead ? queue.findIndex((waiting) => !waiting.ahead) : -1;
  queue.splice(behind < 0 ? queue.length : behind, 0, job);
  pump();
});
