import { describe, expect, it } from 'vitest'
import { MAX_READ_FILES_PER_CALL, type FileAtCommit, type TreeNode }
  from '@gadgets/workshop-shared/api'
import { MAX_BUFFERED_BLOB_SIZE } from '@gadgets/workshop-shared/gatekeeper'
import { CommitFileStore, type CommitFileReader } from './commitFileStore'

// A fake Overseer that records every call. `budget` caps how many entries one readFilesAtCommit
// call answers, standing in for the server's response byte budget (which omits the rest).
class FakeReader implements CommitFileReader {
  treeCalls: string[] = []
  readCalls: { commitId: string; paths: string[] }[] = []
  trees = new Map<string, TreeNode[]>()
  files = new Map<string, Map<string, FileAtCommit>>()
  changedCalls: [string, string][] = []
  changed = new Map<string, string[]>()
  budget = Infinity
  failReads = false
  blobCalls: string[] = []
  blobs = new Map<string, () => ReadableStream<Uint8Array>>()

  async listTree(commitId: string): Promise<TreeNode[]> {
    this.treeCalls.push(commitId)
    const tree = this.trees.get(commitId)
    if (tree === undefined) throw new Error(`no such commit: ${commitId}`)
    return tree
  }

  async readFilesAtCommit(commitId: string, paths: string[]) {
    this.readCalls.push({ commitId, paths: [...paths] })
    if (this.failReads) throw new Error('pull failed')
    const files = this.files.get(commitId) ?? new Map<string, FileAtCommit>()
    return paths.slice(0, this.budget)
      .map((path): [string, FileAtCommit] => [path, files.get(path) ?? { kind: 'absent' }])
  }

  async listChangedPaths(fromCommit: string, toCommit: string): Promise<string[]> {
    this.changedCalls.push([fromCommit, toCommit])
    const paths = this.changed.get(`${fromCommit}..${toCommit}`) ??
      this.changed.get(`${toCommit}..${fromCommit}`)
    if (paths === undefined) throw new Error(`no such commits: ${fromCommit}, ${toCommit}`)
    return paths
  }

  async readBlob(oid: string): Promise<ReadableStream<Uint8Array>> {
    this.blobCalls.push(oid)
    const open = this.blobs.get(oid)
    if (open === undefined) throw new Error(`no such blob: ${oid}`)
    return open()
  }
}

const text = (t: string): FileAtCommit => ({ kind: 'text', text: t })

const oid = (digit: string) => digit.repeat(40)
const utf8 = (t: string) => new TextEncoder().encode(t)

// A file over MAX_BUFFERED_BLOB_SIZE, as the server names one: its `blob` entry, with the fake's
// readBlob() serving the bytes on demand in two pieces, cut at `split`, or erroring after the
// first piece. `pulls` counts the pieces read; `cancelled` reports whether the reader cancelled.
const large = (
  reader: FakeReader, blobOid: string, bytes: Uint8Array,
  options: { split?: number; fail?: boolean } = {},
) => {
  const state = { pulls: 0, cancelled: false }
  const split = options.split ?? Math.ceil(bytes.length / 2)
  reader.blobs.set(blobOid, () => {
    let sent = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 1 && options.fail) {
          controller.error(new Error('stream broke'))
        } else if (sent < 2) {
          controller.enqueue(sent === 0 ? bytes.slice(0, split) : bytes.slice(split))
          sent++
          state.pulls++
        } else {
          controller.close()
        }
      },
      cancel() { state.cancelled = true },
    }, { highWaterMark: 0 })
  })
  const file: FileAtCommit = { kind: 'blob', blob: { oid: blobOid, byteLength: bytes.length } }
  return { file, state }
}

describe('CommitFileStore', () => {
  it('memoizes a tree by commit and exposes it synchronously once loaded', async () => {
    const reader = new FakeReader()
    const tree: TreeNode[] = [{ name: 'a.txt', kind: 'file' }]
    reader.trees.set('c1', tree)
    const store = new CommitFileStore()

    expect(store.peekTree('c1')).toBeUndefined()
    const [first, second] = await Promise.all([
      store.listTree(reader, 'c1'), store.listTree(reader, 'c1'),
    ])
    expect(first).toBe(tree)
    expect(second).toBe(tree)
    expect(reader.treeCalls).toEqual(['c1'])
    expect(store.peekTree('c1')).toBe(tree)
    await store.listTree(reader, 'c1')
    expect(reader.treeCalls).toEqual(['c1'])
  })

  it('evicts a failed tree fetch so a later attempt retries', async () => {
    const reader = new FakeReader()
    const store = new CommitFileStore()
    await expect(store.listTree(reader, 'missing')).rejects.toThrow('no such commit')
    reader.trees.set('missing', [])
    expect(await store.listTree(reader, 'missing')).toEqual([])
    expect(reader.treeCalls).toEqual(['missing', 'missing'])
  })

  it('coalesces same-turn reads of one commit into one RPC and caches per path', async () => {
    const reader = new FakeReader()
    reader.files.set('c1', new Map([['a', text('A')], ['b', text('B')]]))
    const store = new CommitFileStore()

    const [ab, bc] = await Promise.all([
      store.readFiles(reader, 'c1', ['a', 'b']),
      store.readFiles(reader, 'c1', ['b', 'c']),
    ])
    expect(reader.readCalls).toEqual([{ commitId: 'c1', paths: ['a', 'b', 'c'] }])
    expect([...ab]).toEqual([['a', text('A')], ['b', text('B')]])
    expect([...bc]).toEqual([['b', text('B')], ['c', { kind: 'absent' }]])
    expect(store.peekFile('c1', 'a')).toEqual(text('A'))
    expect(store.peekFile('c1', 'c')).toEqual({ kind: 'absent' })

    // Everything cached: no further RPC, even for the explicit absent answer.
    expect([...await store.readFiles(reader, 'c1', ['a', 'c'])])
      .toEqual([['a', text('A')], ['c', { kind: 'absent' }]])
    expect(reader.readCalls).toHaveLength(1)
  })

  it('issues separate RPCs per commit', async () => {
    const reader = new FakeReader()
    reader.files.set('c1', new Map([['a', text('A1')]]))
    reader.files.set('c2', new Map([['a', text('A2')]]))
    const store = new CommitFileStore()
    const [one, two] = await Promise.all([
      store.readFiles(reader, 'c1', ['a']), store.readFiles(reader, 'c2', ['a']),
    ])
    expect(one.get('a')).toEqual(text('A1'))
    expect(two.get('a')).toEqual(text('A2'))
    expect(reader.readCalls.map(call => call.commitId).toSorted()).toEqual(['c1', 'c2'])
  })

  it('chunks a large request at MAX_READ_FILES_PER_CALL', async () => {
    const reader = new FakeReader()
    const paths = Array.from({ length: MAX_READ_FILES_PER_CALL + 5 }, (_, i) => `f${i}`)
    reader.files.set('c1', new Map(paths.map(path => [path, text(path)])))
    const store = new CommitFileStore()
    const result = await store.readFiles(reader, 'c1', paths)
    expect(result.size).toBe(paths.length)
    expect(reader.readCalls.map(call => call.paths.length)).toEqual([MAX_READ_FILES_PER_CALL, 5])
  })

  it('re-requests paths the server omitted under its byte budget', async () => {
    const reader = new FakeReader()
    reader.budget = 2
    reader.files.set('c1', new Map([['a', text('A')], ['b', text('B')], ['c', text('C')],
                                    ['d', text('D')], ['e', text('E')]]))
    const store = new CommitFileStore()
    const result = await store.readFiles(reader, 'c1', ['a', 'b', 'c', 'd', 'e'])
    expect([...result.keys()].toSorted()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(reader.readCalls.map(call => call.paths)).toEqual([
      ['a', 'b', 'c', 'd', 'e'], ['c', 'd', 'e'], ['e'],
    ])
  })

  it('fails every waiting read on an RPC error and evicts so a retry refetches', async () => {
    const reader = new FakeReader()
    reader.failReads = true
    reader.files.set('c1', new Map([['a', text('A')]]))
    const store = new CommitFileStore()
    const first = store.readFiles(reader, 'c1', ['a'])
    const second = store.readFiles(reader, 'c1', ['a', 'b'])
    await expect(first).rejects.toThrow('pull failed')
    await expect(second).rejects.toThrow('pull failed')
    expect(store.peekFile('c1', 'a')).toBeUndefined()

    reader.failReads = false
    expect((await store.readFiles(reader, 'c1', ['a'])).get('a')).toEqual(text('A'))
    expect(reader.readCalls).toHaveLength(2)
  })

  it('answers an in-flight path from the pending request rather than a second RPC', async () => {
    const reader = new FakeReader()
    reader.files.set('c1', new Map([['a', text('A')]]))
    const store = new CommitFileStore()
    const first = store.readFiles(reader, 'c1', ['a'])
    // Past the microtask that flushed the first batch: the RPC is out but unanswered.
    await Promise.resolve()
    await Promise.resolve()
    const second = store.readFiles(reader, 'c1', ['a'])
    expect((await first).get('a')).toEqual(text('A'))
    expect((await second).get('a')).toEqual(text('A'))
    expect(reader.readCalls).toHaveLength(1)
  })

  it('reads a large text file with readBlob and holds it as text', async () => {
    const reader = new FakeReader()
    // Each is cut inside a character, and they are read at the same time.
    const accented = '\uFEFF' + 'é'.repeat(MAX_BUFFERED_BLOB_SIZE / 2)
    const kanji = '日'.repeat(MAX_BUFFERED_BLOB_SIZE / 2)
    reader.files.set('c1', new Map([
      ['accented.txt', large(reader, oid('1'), utf8(accented), { split: 4 }).file],
      ['kanji.txt', large(reader, oid('2'), utf8(kanji), { split: 1 }).file],
      ['small.txt', text('S')],
    ]))
    const store = new CommitFileStore()
    const paths = ['accented.txt', 'kanji.txt', 'small.txt']
    const [result, again] = await Promise.all(
      [store.readFiles(reader, 'c1', paths), store.readFiles(reader, 'c1', paths)])
    expect(result.get('accented.txt')).toEqual(text(accented))
    expect(result.get('kanji.txt')).toEqual(text(kanji))
    expect(result.get('small.txt')).toEqual(text('S'))
    expect(again).toEqual(result)
    expect(store.peekFile('c1', 'kanji.txt')).toEqual(text(kanji))
    expect(reader.blobCalls.toSorted()).toEqual([oid('1'), oid('2')])
  })

  it('holds a large file that is not text as its blob, reading no more than shows it', async () => {
    const reader = new FakeReader()
    const filled = (change: (bytes: Uint8Array) => void) => {
      const bytes = new Uint8Array(MAX_BUFFERED_BLOB_SIZE + 1).fill(65)
      change(bytes)
      return bytes
    }
    const nul = large(reader, oid('1'), filled(bytes => { bytes[1] = 0 }))
    const invalid = large(reader, oid('2'), filled(bytes => { bytes[1] = 0xff }))
    // Valid until its last byte, which starts a character that never ends.
    const cut = large(reader, oid('3'), filled(bytes => { bytes[bytes.length - 1] = 0xc3 }))
    // At the limit, so the server has checked it: the store does not read it.
    const checked: FileAtCommit =
      { kind: 'blob', blob: { oid: oid('4'), byteLength: MAX_BUFFERED_BLOB_SIZE } }
    reader.files.set('c1', new Map([
      ['nul.bin', nul.file], ['invalid.bin', invalid.file], ['cut.bin', cut.file],
      ['checked.bin', checked],
    ]))
    const store = new CommitFileStore()
    const result = await store.readFiles(
      reader, 'c1', ['nul.bin', 'invalid.bin', 'cut.bin', 'checked.bin'])
    expect(Object.fromEntries(result)).toEqual({
      'nul.bin': nul.file, 'invalid.bin': invalid.file, 'cut.bin': cut.file,
      'checked.bin': checked,
    })
    expect(nul.state).toEqual({ pulls: 1, cancelled: true })
    expect(invalid.state).toEqual({ pulls: 1, cancelled: true })
    expect(reader.blobCalls.toSorted()).toEqual([oid('1'), oid('2'), oid('3')])
  })

  it('fails and evicts just the path whose large read breaks, so a retry refetches it', async () => {
    const reader = new FakeReader()
    const content = 'x'.repeat(MAX_BUFFERED_BLOB_SIZE + 1)
    reader.files.set('c1', new Map([
      ['big.txt', large(reader, oid('1'), utf8(content), { fail: true }).file], ['a', text('A')],
    ]))
    const store = new CommitFileStore()
    const big = store.readFiles(reader, 'c1', ['big.txt'])
    const a = store.readFiles(reader, 'c1', ['a'])
    await expect(big).rejects.toThrow('stream broke')
    expect((await a).get('a')).toEqual(text('A'))
    expect(store.peekFile('c1', 'big.txt')).toBeUndefined()

    large(reader, oid('1'), utf8(content))
    expect((await store.readFiles(reader, 'c1', ['big.txt'])).get('big.txt'))
      .toEqual(text(content))
  })

  // The list is the same either way round (see Overseer.listChangedPaths()), so one fetch
  // answers both orders.
  it('memoizes the paths changed between two commits by the pair', async () => {
    const reader = new FakeReader()
    reader.changed.set('head..merge', ['a.txt', 'lib/b.txt'])
    const store = new CommitFileStore()

    expect(store.peekChangedPaths('head', 'merge')).toBeUndefined()
    expect(await store.listChangedPaths(reader, 'head', 'merge')).toEqual(['a.txt', 'lib/b.txt'])
    expect(store.peekChangedPaths('merge', 'head')).toEqual(['a.txt', 'lib/b.txt'])
    await store.listChangedPaths(reader, 'merge', 'head')
    expect(reader.changedCalls).toEqual([['head', 'merge']])
  })

  it('evicts a failed changed-paths fetch so a later attempt retries', async () => {
    const reader = new FakeReader()
    const store = new CommitFileStore()
    await expect(store.listChangedPaths(reader, 'head', 'merge')).rejects.toThrow('no such commits')
    reader.changed.set('head..merge', [])
    expect(await store.listChangedPaths(reader, 'head', 'merge')).toEqual([])
    expect(reader.changedCalls).toHaveLength(2)
  })
})
