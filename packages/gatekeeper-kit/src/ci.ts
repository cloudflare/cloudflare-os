/** CI for gatekeepers: reading, normalising, paging, and caching job logs, and when a commit became a head. */

import type { KvScannable } from "./kv";
import { requirePositiveInt } from "./positive-int";

/** Lines a page returns when the caller gives no `maxLines`. */
export const CI_LOG_DEFAULT_LINES = 200;

/** Most lines one page returns; a larger `maxLines` is capped to this. */
export const CI_LOG_MAX_LINES = 2000;

/** One numbered log line. */
export type CiLogLine = {
  /** 1-based line number over the normalised log. */
  number: number;
  /** Normalised line text. */
  text: string;
};

/** One page of a log, as a gatekeeper returns it. */
export type CiLogPage = {
  /** The selected lines, in log order. */
  lines: CiLogLine[];
  /** Lines in the whole normalised log, including any whose text was not kept. */
  totalLines: number;
  /** Number of the first line whose text is available; 1 unless a very long log's head was dropped. */
  firstAvailableLine: number;
  /** Whether the log is final: the job has finished, so later reads return the same lines. */
  complete: boolean;
};

/** What a caller asks of a log page. */
export type CiLogOptions = {
  /** First line to return (1-based). Omitted: the page ends at the log's last line. */
  fromLine?: number;
  /** Most lines to return. Defaults to `CI_LOG_DEFAULT_LINES`, capped at `CI_LOG_MAX_LINES`. */
  maxLines?: number;
  /** Case-insensitive substring; only lines containing it are returned. */
  search?: string;
};

/** Normalised log: kept lines are the last ones; numbering is over normalised lines, 1-based. */
export type CiLog = {
  /** Text of lines `firstLine` through `totalLines`. */
  lines: readonly string[];
  /** Number of `lines[0]`; `totalLines + 1` when no line is kept. */
  firstLine: number;
  /** Lines in the whole normalised log. */
  totalLines: number;
};

/** A log with no lines, such as that of a job that has not written one yet. Frozen: it is shared. */
export const EMPTY_CI_LOG: CiLog = Object.freeze({ lines: Object.freeze([]), firstLine: 1, totalLines: 0 });

/** Normalised lines longer than this many characters are cut, keeping their start. */
const MAX_LINE_LENGTH = 8192;
const TRUNCATED_SUFFIX = "… [line truncated]";
/**
 * Characters an unfinished line may buffer. Past it the line is compacted to the text after its
 * last carriage-return overwrite, or else only its start is kept.
 */
const PENDING_LIMIT = 4 * MAX_LINE_LENGTH;
/** Characters one page may carry; a page stops early (keeping at least one line) past it. */
const PAGE_MAX_CHARS = 1024 * 1024;
/** Approximate per-line bookkeeping cost, so empty lines still count against `retainBytes`. */
const LINE_OVERHEAD_BYTES = 16;
const MIB = 1024 * 1024;
const DEFAULT_RETAIN_BYTES = 8 * MIB;
const DEFAULT_MAX_BYTES = 128 * MIB;

/** Thrown by `readCiLog` once a raw log body exceeds its `maxBytes`. */
export class CiLogTooLargeError extends Error {
  /**
   * @param maxBytes The raw-byte limit the body exceeded.
   */
  constructor(readonly maxBytes: number) {
    super(`The log is larger than ${
      maxBytes % MIB === 0 ? `${maxBytes / MIB} MiB` : `${maxBytes} bytes`} and cannot be read.`);
    this.name = "CiLogTooLargeError";
  }
}

/**
 * Streams a raw log body, rewriting each line with `normalizeLine`, keeping only the tail that fits
 * `retainBytes` (default 8 MiB) and refusing (throws CiLogTooLargeError) past `maxBytes` (default
 * 128 MiB).
 *
 * Decoding is incremental UTF-8 (invalid bytes become U+FFFD), lines split on `\n` across chunk
 * boundaries, a leading byte-order mark is dropped from each line, and a final line without a
 * newline still counts. Every line `normalizeLine` keeps is counted in `totalLines`; lines it drops
 * are not. `retainBytes` approximates the kept text's memory (two
 * bytes per UTF-16 code unit plus a small per-line overhead). Normalised lines longer than 8192
 * characters are cut to their start with a `… [line truncated]` suffix, which also bounds the
 * buffer an unterminated line can grow.
 * @param body Raw log body; cancelled when the read fails or exceeds `maxBytes`.
 * @param normalizeLine Rewrites one raw line (without its `\n`; ANSI escapes and carriage returns
 *   intact) into the text to keep, or returns `null` to drop it as markup. Compose `stripAnsi` and
 *   `applyCarriageReturns` with the provider's own markup rules.
 * @param options Memory and size bounds, both positive safe integers.
 * @returns The normalised log tail with line accounting.
 *
 * @example
 * ```ts
 * const log = await readCiLog(response.body, line => applyCarriageReturns(stripAnsi(line)));
 * return pageCiLog(log, options, job.status === "completed");
 * ```
 */
export async function readCiLog(
  body: ReadableStream<Uint8Array>,
  normalizeLine: (line: string) => string | null,
  options: { retainBytes?: number; maxBytes?: number } = {},
): Promise<CiLog> {
  const retainBytes = requirePositiveInt("retainBytes", options.retainBytes ?? DEFAULT_RETAIN_BYTES);
  const maxBytes = requirePositiveInt("maxBytes", options.maxBytes ?? DEFAULT_MAX_BYTES);
  const tail = new LineTail(retainBytes);
  const splitter = new LineSplitter((line, truncated) => {
    const text = normalizeLine(line.startsWith("\uFEFF") ? line.slice(1) : line);
    if (text === null) return;
    tail.push(truncated || text.length > MAX_LINE_LENGTH
      ? leadingUnits(text, MAX_LINE_LENGTH) + TRUNCATED_SUFFIX
      : text);
  });
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new CiLogTooLargeError(maxBytes);
      splitter.write(decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  splitter.write(decoder.decode());
  splitter.end();
  return tail.result();
}

/**
 * Pages a log. Range-checks options (positive integers, throwing on a bad one; maxLines capped at
 * CI_LOG_MAX_LINES); their types are the RPC layer's to check. Omitted fromLine ⇒ the last
 * maxLines lines (or with `search`, the last maxLines matching lines); fromLine ⇒ lines (or
 * matches) from there.
 * `search` is a case-insensitive substring. fromLine below firstLine starts at firstLine.
 *
 * A page also stops once its text reaches about one million characters, always keeping at least
 * one line; line numbers show where to continue.
 * @param log Normalised log.
 * @param options Caller-supplied page options; range-checked here.
 * @param complete Whether the log is final.
 * @returns The page.
 */
export function pageCiLog(
  log: CiLog,
  options: CiLogOptions | undefined,
  complete: boolean,
): CiLogPage {
  const { fromLine, maxLines, search } = parseLogOptions(options);
  const first = log.firstLine;
  const end = first + log.lines.length;
  const needle = search?.toLowerCase();
  const lines: CiLogLine[] = [];
  let chars = 0;
  // Returns whether to keep scanning.
  const take = (number: number): boolean => {
    const text = log.lines[number - first]!;
    if (needle !== undefined && !text.toLowerCase().includes(needle)) return true;
    if (lines.length > 0 && chars + text.length > PAGE_MAX_CHARS) return false;
    lines.push({ number, text });
    chars += text.length;
    return lines.length < maxLines;
  };
  if (fromLine === undefined) {
    for (let number = end - 1; number >= first && take(number); number--);
    lines.reverse();
  } else {
    for (let number = Math.max(fromLine, first); number < end && take(number); number++);
  }
  return { lines, totalLines: log.totalLines, firstAvailableLine: first, complete };
}

/**
 * Validates page options as `pageCiLog` does, for a caller that refuses bad ones before fetching
 * the log.
 * @param options Caller-supplied page options.
 */
export function validateCiLogOptions(options: CiLogOptions | undefined): void {
  parseLogOptions(options);
}

/** The Durable Object KV surface used by `CiLogCache`. */
export type CiLogCacheKv = KvScannable;

/** Keys, lifetime, and budget for a `CiLogCache`. */
export type CiLogCacheOptions = {
  /** Prefix for every key the cache writes. Defaults to `ciLog:`. */
  prefix?: string;
  /** Entry lifetime in milliseconds. Defaults to one hour. */
  ttlMs?: number;
  /** Total stored log size, measured as two bytes per character. Defaults to 32 MiB. */
  maxTotalBytes?: number;
  /** Clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
};

type CiLogMeta = {
  version: number;
  firstLine: number;
  totalLines: number;
  lineCount: number;
  chunks: number;
  bytes: number;
  storedAt: number;
};

/** The `CiLogMeta.version` this code writes; an entry with another reads as a miss. */
const META_VERSION = 1;

/** Size cap for one stored chunk, measured as two bytes per character. */
const CHUNK_BYTES = 512 * 1024;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_CACHE_BYTES = 32 * MIB;
const EVICTION_BATCH = 64;

/**
 * Durable cache of finished logs in DO KV, chunked (each value ≤ 512 KiB), with TTL and a total
 * size budget (evict oldest). Callers revalidate (e.g. provider says log erased/deleted) before
 * using a hit.
 *
 * Each entry is a metadata record, its newline-joined line chunks, and an age-index record; a
 * total-size counter backs the budget. Writes for one entry happen with no await between them, so
 * Durable Object implicit transactions keep the records consistent. Expired entries read as misses
 * and are deleted; `put` also clears expired entries and evicts the oldest stored until the new one
 * fits. A log larger than the whole budget, or with a line too long for one chunk, is not stored.
 * Keys are caller-chosen and should include everything that identifies the log (project, job id,
 * attempt).
 *
 * @example
 * ```ts
 * #logs = new CiLogCache(this.ctx.storage.kv);
 *
 * async #readLog(jobId: string): Promise<CiLog> {
 *   const cached = this.#logs.get(jobId);
 *   if (cached && !(await this.#api.logErased(jobId))) return cached;
 *   const log = await readCiLog(await this.#api.fetchLog(jobId), normalizeLogLine);
 *   if (await this.#api.jobFinished(jobId)) this.#logs.put(jobId, log);
 *   return log;
 * }
 * ```
 */
export class CiLogCache {
  readonly #kv: CiLogCacheKv;
  readonly #prefix: string;
  readonly #ttlMs: number;
  readonly #maxTotalBytes: number;
  readonly #now: () => number;

  /**
   * Creates a log cache over Durable Object KV.
   * @param kv Durable Object storage; pass the same `ctx.storage.kv` object on every use.
   * @param options Keys, lifetime, and budget; numeric bounds must be positive safe integers.
   */
  constructor(kv: CiLogCacheKv, options: CiLogCacheOptions = {}) {
    this.#kv = kv;
    this.#prefix = options.prefix ?? "ciLog:";
    if (this.#prefix === "") throw new Error("CiLogCache prefix must not be empty.");
    this.#ttlMs = requirePositiveInt("ttlMs", options.ttlMs ?? DEFAULT_TTL_MS);
    this.#maxTotalBytes = requirePositiveInt("maxTotalBytes", options.maxTotalBytes ?? DEFAULT_CACHE_BYTES);
    this.#now = options.now ?? Date.now;
  }

  /**
   * Reads a cached log. Expired or incomplete entries, and ones another version of this cache
   * wrote, are deleted and read as misses.
   * @param key Caller-chosen log key.
   * @returns The log, or `undefined` on a miss.
   */
  get(key: string): CiLog | undefined {
    const id = encodeURIComponent(key);
    const meta = this.#kv.get<CiLogMeta>(this.#metaKey(id));
    if (meta === undefined) return undefined;
    if (meta.version !== META_VERSION || this.#expired(meta, this.#now())) {
      this.#remove(id, meta);
      return undefined;
    }
    const lines: string[] = [];
    for (let index = 0; index < meta.chunks; index++) {
      const chunk = this.#kv.get<unknown>(this.#chunkKey(id, index));
      if (typeof chunk !== "string") {
        this.#remove(id, meta);
        return undefined;
      }
      for (const line of chunk.split("\n")) lines.push(line);
    }
    if (lines.length !== meta.lineCount) {
      this.#remove(id, meta);
      return undefined;
    }
    return { lines, firstLine: meta.firstLine, totalLines: meta.totalLines };
  }

  /**
   * Stores a finished log, replacing any entry under the same key. Evicts expired entries, then the
   * oldest stored, until it fits the budget; a log that cannot fit is not stored.
   * @param key Caller-chosen log key.
   * @param log Normalised log to store.
   */
  put(key: string, log: CiLog): void {
    const id = encodeURIComponent(key);
    this.delete(key);
    const chunks = chunkLines(log.lines);
    if (chunks === undefined) return;
    const bytes = chunks.reduce((sum, chunk) => sum + 2 * chunk.length, 0);
    if (bytes > this.#maxTotalBytes) return;
    const now = this.#now();
    this.#evict(bytes, now);
    chunks.forEach((chunk, index) => this.#kv.put(this.#chunkKey(id, index), chunk));
    this.#kv.put<CiLogMeta>(this.#metaKey(id), {
      version: META_VERSION,
      firstLine: log.firstLine,
      totalLines: log.totalLines,
      lineCount: log.lines.length,
      chunks: chunks.length,
      bytes,
      storedAt: now,
    });
    this.#kv.put(this.#ageKey(now, id), id);
    this.#kv.put(this.#totalKey, this.#total() + bytes);
  }

  /**
   * Removes a cached log, if present.
   * @param key Caller-chosen log key.
   * @returns Whether an unexpired entry of this version was removed, without reading its chunks.
   */
  delete(key: string): boolean {
    const id = encodeURIComponent(key);
    const meta = this.#kv.get<CiLogMeta>(this.#metaKey(id));
    if (meta === undefined) return false;
    this.#remove(id, meta);
    return meta.version === META_VERSION && !this.#expired(meta, this.#now());
  }

  #evict(incoming: number, now: number): void {
    const prefix = `${this.#prefix}age:`;
    for (;;) {
      const batch = [...this.#kv.list<string>({ prefix, limit: EVICTION_BATCH })];
      for (const [ageKey, id] of batch) {
        const meta = this.#kv.get<CiLogMeta>(this.#metaKey(id));
        if (meta === undefined) {
          this.#kv.delete(ageKey);
          continue;
        }
        if (!this.#expired(meta, now) && this.#total() + incoming <= this.#maxTotalBytes) return;
        this.#remove(id, meta);
      }
      if (batch.length < EVICTION_BATCH) return;
    }
  }

  /** Removes an entry; its chunks are found by key, so this holds for a meta record of another version too. */
  #remove(id: string, meta: CiLogMeta): void {
    for (const [chunkKey] of this.#kv.list<string>({ prefix: `${this.#prefix}chunk:${id}:` })) this.#kv.delete(chunkKey);
    this.#kv.delete(this.#metaKey(id));
    this.#kv.delete(this.#ageKey(meta.storedAt, id));
    if (Number.isFinite(meta.bytes)) this.#kv.put(this.#totalKey, Math.max(0, this.#total() - meta.bytes));
  }

  #expired(meta: CiLogMeta, now: number): boolean {
    return now - meta.storedAt >= this.#ttlMs;
  }

  #total(): number {
    return this.#kv.get<number>(this.#totalKey) ?? 0;
  }

  get #totalKey(): string {
    return `${this.#prefix}totalBytes`;
  }

  #metaKey(id: string): string {
    return `${this.#prefix}meta:${id}`;
  }

  #chunkKey(id: string, index: number): string {
    return `${this.#prefix}chunk:${id}:${String(index).padStart(6, "0")}`;
  }

  #ageKey(storedAt: number, id: string): string {
    return `${this.#prefix}age:${String(storedAt).padStart(16, "0")}:${id}`;
  }
}

/** Joins lines into newline-separated chunks under `CHUNK_BYTES`, or `undefined` if one can't fit. */
function chunkLines(lines: readonly string[]): string[] | undefined {
  const chunks: string[] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const cost = 2 * (line.length + 1);
    if (cost > CHUNK_BYTES) return undefined;
    if (current.length > 0 && bytes + cost > CHUNK_BYTES) {
      chunks.push(current.join("\n"));
      current = [];
      bytes = 0;
    }
    current.push(line);
    bytes += cost;
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

function parseLogOptions(options: CiLogOptions | undefined): { fromLine?: number; maxLines: number; search?: string } {
  const { fromLine, maxLines, search } = options ?? {};
  return {
    fromLine: fromLine === undefined ? undefined : requirePositiveInt("fromLine", fromLine),
    maxLines: maxLines === undefined
      ? CI_LOG_DEFAULT_LINES
      : Math.min(requirePositiveInt("maxLines", maxLines), CI_LOG_MAX_LINES),
    search,
  };
}

// CSI, OSC (BEL- or ST-terminated, or cut off), charset designation, other two-byte escapes, or a
// lone ESC.
// eslint-disable-next-line no-control-regex -- Terminal escape sequences start with ESC and BEL.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()*+][0-9A-Za-z]|[@-Z\\-_])?/g;

/**
 * Removes terminal escape sequences: CSI (colours, cursor moves, erases), OSC (BEL- or
 * ST-terminated, or cut off), charset designations, other two-byte escapes, and a lone ESC.
 * @param text Raw text, possibly holding ESC sequences.
 * @returns `text` without them; other characters are kept verbatim.
 */
export function stripAnsi(text: string): string {
  return text.includes("\x1b") ? text.replace(ANSI, "") : text;
}

/**
 * Applies carriage-return overwrites as a terminal shows them: keeps the text after the last `\r`,
 * ignoring trailing ones (a CRLF ending). Progress output (`10%\r50%\r100%`) becomes `100%`.
 * @param text One line, without its `\n`.
 * @returns The text a terminal would show last.
 */
export function applyCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  // A scan, not `/\r+$/`, which backtracks quadratically over a long run of `\r` before other text.
  let end = text.length;
  while (end > 0 && text[end - 1] === "\r") end--;
  return text.slice(text.lastIndexOf("\r", end - 1) + 1, end);
}

/** Index of the last `\r` followed by a character other than `\r`, or -1. */
function overwritePoint(text: string): number {
  let index = text.lastIndexOf("\r");
  while (index !== -1 && (index === text.length - 1 || text[index + 1] === "\r")) {
    index = index === 0 ? -1 : text.lastIndexOf("\r", index - 1);
  }
  return index;
}

/**
 * Splits decoded text into lines across writes, bounding an unterminated line: past
 * `PENDING_LIMIT` it is compacted to the text after its last overwrite point, and failing that only
 * its start is kept until a later overwrite point or the line's end.
 */
class LineSplitter {
  readonly #emit: (line: string, truncated: boolean) => void;
  #pending = "";
  #overflow = false;
  /**
   * While overflowing: whether the text so far ends in `\r`, which a following character would make
   * an overwrite. One flag suffices: only the last `\r` before that character matters.
   */
  #carriageReturn = false;

  constructor(emit: (line: string, truncated: boolean) => void) {
    this.#emit = emit;
  }

  write(text: string): void {
    let start = 0;
    for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", start)) {
      this.#append(text.slice(start, newline));
      this.#flush();
      start = newline + 1;
    }
    if (start < text.length) this.#append(text.slice(start));
  }

  end(): void {
    // Only a newline leaves nothing pending, and it flushes at once.
    if (this.#pending !== "") this.#flush();
  }

  #flush(): void {
    this.#emit(this.#pending, this.#overflow);
    this.#pending = "";
    this.#overflow = false;
    this.#carriageReturn = false;
  }

  #append(text: string): void {
    if (text === "") return;
    if (this.#overflow) {
      const combined = this.#carriageReturn ? `\r${text}` : text;
      const point = overwritePoint(combined);
      if (point === -1) {
        this.#carriageReturn = combined.endsWith("\r");
        return;
      }
      this.#overflow = false;
      this.#carriageReturn = false;
      this.#pending = combined.slice(point + 1);
    } else {
      this.#pending += text;
    }
    if (this.#pending.length <= PENDING_LIMIT) return;
    const point = overwritePoint(this.#pending);
    if (point !== -1) this.#pending = this.#pending.slice(point + 1);
    if (this.#pending.length > PENDING_LIMIT) {
      this.#carriageReturn = this.#pending.endsWith("\r");
      this.#pending = leadingUnits(this.#pending, PENDING_LIMIT);
      this.#overflow = true;
    }
  }
}

/**
 * Counts lines while keeping the newest ones within a byte budget. A dropped line's slot is
 * blanked at once, so its text is released then rather than when the array is next compacted.
 */
class LineTail {
  readonly #retainBytes: number;
  #lines: string[] = [];
  #start = 0;
  #bytes = 0;
  #total = 0;

  constructor(retainBytes: number) {
    this.#retainBytes = retainBytes;
  }

  push(text: string): void {
    this.#total++;
    this.#lines.push(text);
    this.#bytes += lineCost(text);
    while (this.#bytes > this.#retainBytes && this.#start < this.#lines.length) {
      this.#bytes -= lineCost(this.#lines[this.#start]!);
      this.#lines[this.#start] = "";
      this.#start++;
    }
    if (this.#start > 1024 && this.#start * 2 > this.#lines.length) {
      this.#lines = this.#lines.slice(this.#start);
      this.#start = 0;
    }
  }

  result(): CiLog {
    const lines = this.#lines.slice(this.#start);
    return { lines, firstLine: this.#total - lines.length + 1, totalLines: this.#total };
  }
}

/** The first `length` UTF-16 code units of `text`, one fewer where the cut would split a surrogate pair. */
function leadingUnits(text: string, length: number): string {
  const end = Math.min(length, text.length);
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

function lineCost(text: string): number {
  return 2 * text.length + LINE_OVERHEAD_BYTES;
}

/** How long after a commit became a head CI is still expected to report on it. */
export const CI_START_WINDOW_MS = 10 * 60 * 1000;

/**
 * Whether `at` is less than `CI_START_WINDOW_MS` before `now`, so CI may yet report on a commit
 * that became a head then.
 * @param at When the commit became a head, in epoch milliseconds; `undefined` when unknown.
 * @param now The current time, in epoch milliseconds.
 */
export function withinCiStartWindow(at: number | undefined, now: number): boolean {
  return at !== undefined && now - at < CI_START_WINDOW_MS;
}

/** The Durable Object KV surface used by `AppliedPushLog`. */
export type AppliedPushLogKv = KvScannable;

/** Keys, lifetime, and cap for an `AppliedPushLog`. */
export type AppliedPushLogOptions = {
  /** Prefix for every key the log writes, followed by the commit id. Defaults to `ciPushApplied:`. */
  prefix?: string;
  /** How long a record matters, in milliseconds. Defaults to `CI_START_WINDOW_MS`. */
  windowMs?: number;
  /** Most records kept at once; the oldest are dropped past it. Defaults to 100. */
  max?: number;
  /** Clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * When this gatekeeper applied a push that made a commit a branch head: the best "became the head"
 * time for a commit nothing has reported CI on, since a provider's own push records may be missing
 * or late. Only `windowMs` of history matters, so each new record first prunes those older than
 * that (a pruned commit falls back to the caller's other sources), and the family is capped.
 *
 * @example
 * ```ts
 * #pushes = new AppliedPushLog(this.ctx.storage.kv);
 *
 * // After a push is applied:
 * this.#pushes.record(action.newSha);
 * // When a commit has no CI yet:
 * const becameHeadAt = this.#pushes.get(sha) ?? committedAt;
 * ```
 */
export class AppliedPushLog {
  readonly #kv: AppliedPushLogKv;
  readonly #prefix: string;
  readonly #windowMs: number;
  readonly #max: number;
  readonly #now: () => number;

  /**
   * Creates a push log over Durable Object KV.
   * @param kv Durable Object storage.
   * @param options Keys, lifetime, and cap; numeric bounds must be positive safe integers.
   */
  constructor(kv: AppliedPushLogKv, options: AppliedPushLogOptions = {}) {
    this.#kv = kv;
    this.#prefix = options.prefix ?? "ciPushApplied:";
    if (this.#prefix === "") throw new Error("AppliedPushLog prefix must not be empty.");
    this.#windowMs = requirePositiveInt("windowMs", options.windowMs ?? CI_START_WINDOW_MS);
    this.#max = requirePositiveInt("max", options.max ?? 100);
    this.#now = options.now ?? Date.now;
  }

  /**
   * Records that `commitId` became a head now. A retried apply keeps the first record.
   * @param commitId The pushed head.
   */
  record(commitId: string): void {
    const now = this.#now();
    const key = `${this.#prefix}${commitId}`;
    const live: [string, number][] = [];
    for (const [stored, at] of this.#kv.list<number>({ prefix: this.#prefix })) {
      if (now - at >= this.#windowMs) this.#kv.delete(stored);
      else live.push([stored, at]);
    }
    if (live.some(([stored]) => stored === key)) return;
    const excess = Math.max(0, live.length - this.#max + 1);
    for (const [stale] of live.toSorted((a, b) => a[1] - b[1]).slice(0, excess)) this.#kv.delete(stale);
    this.#kv.put(key, now);
  }

  /**
   * When this gatekeeper made `commitId` a head, if that was within the window; an older record
   * says nothing the caller's other sources would not.
   * @param commitId A commit id.
   * @returns Epoch milliseconds, or `undefined`.
   */
  get(commitId: string): number | undefined {
    const at = this.#kv.get<number>(`${this.#prefix}${commitId}`);
    return at !== undefined && this.#now() - at < this.#windowMs ? at : undefined;
  }
}
