import {
  MAX_READ_FILES_PER_CALL, type FileAtCommit, type TreeNode,
} from '@gadgets/workshop-shared/api'

// The per-commit file store behind the code view: the client-side cache of Overseer.listTree()
// and Overseer.readFilesAtCommit(). Commits are immutable, so everything here is memoized by
// commit id for the page's lifetime -- across chat switches, workpiece switches, and component
// remounts -- and a base an editor already opened is never fetched twice, including by the OT
// client, whose delegate reads through the same store. Failures are evicted so a later attempt
// retries.
//
// Reads are coalesced: every readFiles() call made in one microtask turn for the same commit
// joins a single RPC (chunked at MAX_READ_FILES_PER_CALL), so a view that asks for a file's
// content, its review-base original, and the statuses of a dozen touched paths in one render
// pays one round trip. Paths the server omitted under its response byte budget are re-requested
// until every requested path has an answer (the server always returns at least one entry per
// non-empty request, so the loop terminates).

/** The subset of Overseer the store reads through (the stub itself satisfies it). */
export interface CommitFileReader {
  listTree(commitId: string): Promise<TreeNode[]>
  readFilesAtCommit(commitId: string, paths: string[]): Promise<[path: string, FileAtCommit][]>
}

// One path's slot: settled once `value` is set; until then `waiters` are the reads awaiting it.
type FileSlot = {
  value?: FileAtCommit
  waiters: { resolve: (value: FileAtCommit) => void; reject: (err: unknown) => void }[]
}

export class CommitFileStore {
  readonly #trees = new Map<string, { value?: TreeNode[]; promise: Promise<TreeNode[]> }>()
  readonly #files = new Map<string, Map<string, FileSlot>>()
  // Paths requested this microtask turn and not yet sent, per commit (see #flush).
  readonly #batches = new Map<string, { reader: CommitFileReader; paths: Set<string> }>()
  #flushScheduled = false

  /** The commit's whole tree, nested (see TreeNode). Memoized; a failure is evicted. */
  listTree(reader: CommitFileReader, commitId: string): Promise<TreeNode[]> {
    let entry = this.#trees.get(commitId)
    if (entry === undefined) {
      const created: { value?: TreeNode[]; promise: Promise<TreeNode[]> } = {
        promise: reader.listTree(commitId),
      }
      entry = created
      this.#trees.set(commitId, created)
      created.promise.then(
        value => { created.value = value },
        () => { if (this.#trees.get(commitId) === created) this.#trees.delete(commitId) })
    }
    return entry.promise
  }

  /** The commit's tree if already loaded, without fetching. */
  peekTree(commitId: string): TreeNode[] | undefined {
    return this.#trees.get(commitId)?.value
  }

  /**
   * The named files' content at the commit: one FileAtCommit per requested path (the server's
   * omissions are re-requested, so the result covers every path). Memoized per (commit, path);
   * requests made in the same microtask turn share one RPC per commit.
   */
  async readFiles(
    reader: CommitFileReader, commitId: string, paths: readonly string[],
  ): Promise<ReadonlyMap<string, FileAtCommit>> {
    const result = new Map<string, FileAtCommit>()
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
  peekFile(commitId: string, path: string): FileAtCommit | undefined {
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
  // settle each path's slot. A thrown RPC fails (and evicts) every path still unanswered.
  async #fetchChunk(reader: CommitFileReader, commitId: string, paths: string[]): Promise<void> {
    let remaining = paths
    try {
      while (remaining.length > 0) {
        const entries = await reader.readFilesAtCommit(commitId, remaining)
        const answered = new Set<string>()
        for (const [path, value] of entries) {
          answered.add(path)
          const slot = this.#files.get(commitId)?.get(path)
          if (slot === undefined || slot.value !== undefined) continue
          slot.value = value
          const waiters = slot.waiters
          slot.waiters = []
          for (const waiter of waiters) waiter.resolve(value)
        }
        const omitted = remaining.filter(path => !answered.has(path))
        if (omitted.length === remaining.length) {
          throw new Error(`readFilesAtCommit answered none of ${remaining.length} paths`)
        }
        remaining = omitted
      }
    } catch (err) {
      const slots = this.#files.get(commitId)
      for (const path of remaining) {
        const slot = slots?.get(path)
        if (slot === undefined || slot.value !== undefined) continue
        slots!.delete(path)
        for (const waiter of slot.waiters) waiter.reject(err)
      }
    }
  }
}

/** The page-wide store (see the module comment). */
export const commitFileStore = new CommitFileStore()

