import {
  MAX_READ_FILES_PER_CALL, type FileAtCommit, type TreeNode,
} from '@gadgets/workshop-shared/api'

// The per-commit file store behind the code view: the client-side cache of Overseer.listTree(),
// Overseer.readFilesAtCommit() and Overseer.listChangedPaths(). Commits are immutable, so
// everything here is memoized by commit id for the page's lifetime -- across chat switches,
// workpiece switches, and component remounts -- and a base an editor already opened is never
// fetched twice, including by the OT client, whose delegate reads through the same store.
// Failures are evicted so a later attempt retries.
//
// Reads are coalesced: every readFiles() call made in one microtask turn for the same commit
// joins a single RPC (chunked at MAX_READ_FILES_PER_CALL), so a view that asks for a file's
// content, its review-base original, and the statuses of a dozen touched paths in one render
// pays one round trip. Paths the server omitted under its response byte budget are re-requested
// until every requested path has an answer (the server always returns at least one entry per
// non-empty request, so the loop terminates).
//
// A large file arrives as a byte stream rather than text (see FileAtCommit). The store reads it
// whole and decodes it under the server's own rules, so it holds, and callers see, only the
// forms the server sends for small files. There is deliberately no size limit here: the editor
// shows the whole file.

/** The subset of Overseer the store reads through (the stub itself satisfies it). */
export interface CommitFileReader {
  listTree(commitId: string): Promise<TreeNode[]>
  readFilesAtCommit(commitId: string, paths: string[]): Promise<[path: string, FileAtCommit][]>
  listChangedPaths(fromCommit: string, toCommit: string): Promise<string[]>
}

/**
 * A file as the store holds it: a FileAtCommit as the server sends it for a small file. A
 * streamed file has been read and decoded into `text`, or `unreadable` if it is not text.
 */
export type CommitFile = Exclude<FileAtCommit, { kind: 'stream' }>

// A memoized read: settled once `value` is set.
type Memo<T> = { value?: T; promise: Promise<T> }

// One path's slot: settled once `value` is set; until then `waiters` are the reads awaiting it.
type FileSlot = {
  value?: CommitFile
  waiters: { resolve: (value: CommitFile) => void; reject: (err: unknown) => void }[]
}

export class CommitFileStore {
  readonly #trees = new Map<string, Memo<TreeNode[]>>()
  // Keyed by the two commits in sorted order: the list is the same either way round.
  readonly #changedPaths = new Map<string, Memo<readonly string[]>>()
  readonly #files = new Map<string, Map<string, FileSlot>>()
  // Paths requested this microtask turn and not yet sent, per commit (see #flush).
  readonly #batches = new Map<string, { reader: CommitFileReader; paths: Set<string> }>()
  #flushScheduled = false

  /** The commit's whole tree, nested (see TreeNode). Memoized; a failure is evicted. */
  listTree(reader: CommitFileReader, commitId: string): Promise<TreeNode[]> {
    return memoize(this.#trees, commitId, () => reader.listTree(commitId))
  }

  /** The commit's tree if already loaded, without fetching. */
  peekTree(commitId: string): TreeNode[] | undefined {
    return this.#trees.get(commitId)?.value
  }

  /**
   * The paths whose entry differs between the two commits' trees (see
   * Overseer.listChangedPaths()). Memoized by the pair; a failure is evicted.
   */
  listChangedPaths(
    reader: CommitFileReader, fromCommit: string, toCommit: string,
  ): Promise<readonly string[]> {
    return memoize(this.#changedPaths, pairKey(fromCommit, toCommit),
      () => reader.listChangedPaths(fromCommit, toCommit))
  }

  /** The paths changed between the two commits if already loaded, without fetching. */
  peekChangedPaths(fromCommit: string, toCommit: string): readonly string[] | undefined {
    return this.#changedPaths.get(pairKey(fromCommit, toCommit))?.value
  }

  /**
   * The named files' content at the commit: one CommitFile per requested path (the server's
   * omissions are re-requested, so the result covers every path). Memoized per (commit, path);
   * requests made in the same microtask turn share one RPC per commit.
   */
  async readFiles(
    reader: CommitFileReader, commitId: string, paths: readonly string[],
  ): Promise<ReadonlyMap<string, CommitFile>> {
    const result = new Map<string, CommitFile>()
    const waiting: Promise<void>[] = []
    let slots = this.#files.get(commitId)
    for (const path of paths) {
      let slot = slots?.get(path)
      if (slot?.value !== undefined) {
        result.set(path, slot.value)
        continue
      }
      if (slot === undefined) {
        if (slots === undefined) {
          slots = new Map()
          this.#files.set(commitId, slots)
        }
        slot = { waiters: [] }
        slots.set(path, slot)
        let batch = this.#batches.get(commitId)
        if (batch === undefined) {
          batch = { reader, paths: new Set() }
          this.#batches.set(commitId, batch)
        }
        batch.paths.add(path)
      }
      const pending = slot
      waiting.push(new Promise<void>((resolve, reject) => {
        pending.waiters.push({ resolve: value => { result.set(path, value); resolve() }, reject })
      }))
    }
    if (this.#batches.size > 0 && !this.#flushScheduled) {
      this.#flushScheduled = true
      queueMicrotask(() => this.#flush())
    }
    await Promise.all(waiting)
    return result
  }

  /** One file at the commit if already loaded, without fetching. */
  peekFile(commitId: string, path: string): CommitFile | undefined {
    return this.#files.get(commitId)?.get(path)?.value
  }

  #flush(): void {
    this.#flushScheduled = false
    const batches = [...this.#batches]
    this.#batches.clear()
    for (const [commitId, { reader, paths }] of batches) {
      const all = [...paths]
      for (let i = 0; i < all.length; i += MAX_READ_FILES_PER_CALL) {
        void this.#fetchChunk(reader, commitId, all.slice(i, i + MAX_READ_FILES_PER_CALL))
      }
    }
  }

  // Fetch one chunk, re-requesting whatever the server omitted under its byte budget, and
  // settle each path's slot. A thrown RPC fails (and evicts) every path still unanswered; a
  // streamed file that fails to read fails (and evicts) just its own path.
  async #fetchChunk(reader: CommitFileReader, commitId: string, paths: string[]): Promise<void> {
    let remaining = paths
    try {
      while (remaining.length > 0) {
        const entries = await reader.readFilesAtCommit(commitId, remaining)
        const answered = new Set<string>()
        for (const [path, value] of entries) {
          answered.add(path)
          const slot = this.#files.get(commitId)?.get(path)
          if (slot === undefined || slot.value !== undefined) {
            if (value.kind === 'stream') void value.content.cancel().catch(() => {})
            continue
          }
          if (value.kind === 'stream') {
            readStreamedFile(path, value).then(
              file => settle(slot, file),
              err => this.#evict(commitId, [path], err))
          } else {
            settle(slot, value)
          }
        }
        const omitted = remaining.filter(path => !answered.has(path))
        if (omitted.length === remaining.length) {
          throw new Error(`readFilesAtCommit answered none of ${remaining.length} paths`)
        }
        remaining = omitted
      }
    } catch (err) {
      this.#evict(commitId, remaining, err)
    }
  }

  // Fails the unsettled slots of `paths`, dropping them so a later read retries.
  #evict(commitId: string, paths: string[], err: unknown): void {
    const slots = this.#files.get(commitId)
    for (const path of paths) {
      const slot = slots?.get(path)
      if (slot === undefined || slot.value !== undefined) continue
      slots!.delete(path)
      for (const waiter of slot.waiters) waiter.reject(err)
    }
  }
}

function settle(slot: FileSlot, value: CommitFile): void {
  slot.value = value
  const waiters = slot.waiters
  slot.waiters = []
  for (const waiter of waiters) waiter.resolve(value)
}

const TEXT_DECODER_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// Reads a streamed file whole, and decodes it as the server decodes a small file: text with no
// NUL byte and valid UTF-8, else the same `unreadable` entry the server would have sent.
async function readStreamedFile(
  path: string, { byteLength, content }: { byteLength: number; content: ReadableStream<Uint8Array> },
): Promise<CommitFile> {
  const bytes = new Uint8Array(byteLength)
  let filled = 0
  const reader = content.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength > byteLength - filled) throw new Error(`${path}: more bytes than expected`)
      bytes.set(value, filled)
      filled += value.byteLength
    }
  } catch (err) {
    await reader.cancel(err).catch(() => {})
    throw err
  }
  if (filled !== byteLength) throw new Error(`${path}: fewer bytes than expected`)
  const unreadable: CommitFile = { kind: 'unreadable', message: `${path} is not a text file` }
  if (bytes.includes(0)) return unreadable
  try {
    return { kind: 'text', text: TEXT_DECODER_STRICT.decode(bytes) }
  } catch {
    return unreadable
  }
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

function memoize<T>(memos: Map<string, Memo<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let entry = memos.get(key)
  if (entry === undefined) {
    const created: Memo<T> = { promise: read() }
    entry = created
    memos.set(key, created)
    created.promise.then(
      value => { created.value = value },
      () => { if (memos.get(key) === created) memos.delete(key) })
  }
  return entry.promise
}

/** The page-wide store (see the module comment). */
export const commitFileStore = new CommitFileStore()

