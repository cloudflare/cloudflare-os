import { describe, expect, it } from 'vitest'
import { MAX_READ_FILES_PER_CALL, type FileAtCommit, type TreeNode }
  from '@gadgets/workshop-shared/api'
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
}

const text = (t: string): FileAtCommit => ({ kind: 'text', text: t })

// A streamed file, as the server sends one over MAX_BUFFERED_BLOB_SIZE: its bytes in two pieces,
// or erroring after the first piece. `cancelled` reports whether the consumer cancelled it.
const streamed = (bytes: Uint8Array, options: { fail?: boolean } = {}) => {
  const state = { cancelled: false }
  let sent = 0
  const content = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === 1 && options.fail) {
        controller.error(new Error('stream broke'))
      } else if (sent < 2) {
        const half = Math.ceil(bytes.length / 2)
        controller.enqueue(sent === 0 ? bytes.slice(0, half) : bytes.slice(half))
        sent++
      } else {
        controller.close()
      }
    },
    cancel() { state.cancelled = true },
  })
  return { file: { kind: 'stream', byteLength: bytes.length, content } as FileAtCommit, state }
}
const utf8 = (t: string) => new TextEncoder().encode(t)

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

  it('reads a streamed file whole and holds it as the server would have sent it', async () => {
    const reader = new FakeReader()
    reader.files.set('c1', new Map([
      ['big.txt', streamed(utf8('héllo\nworld\n')).file],
      ['nul.bin', streamed(Uint8Array.of(65, 0, 66)).file],
      ['bad.bin', streamed(Uint8Array.of(65, 0xff, 66)).file],
      ['small.txt', text('S')],
    ]))
    const store = new CommitFileStore()
    const result = await store.readFiles(reader, 'c1', ['big.txt', 'nul.bin', 'bad.bin', 'small.txt'])
    expect(Object.fromEntries(result)).toEqual({
      'big.txt': text('héllo\nworld\n'),
      'nul.bin': { kind: 'unreadable', message: 'nul.bin is not a text file' },
      'bad.bin': { kind: 'unreadable', message: 'bad.bin is not a text file' },
      'small.txt': text('S'),
    })
    expect(store.peekFile('c1', 'big.txt')).toEqual(text('héllo\nworld\n'))
  })

  it('fails and evicts just the path whose stream breaks, so a retry refetches it', async () => {
    const reader = new FakeReader()
    reader.files.set('c1', new Map([
      ['big.txt', streamed(utf8('0123456789'), { fail: true }).file], ['a', text('A')],
    ]))
    const store = new CommitFileStore()
    const big = store.readFiles(reader, 'c1', ['big.txt'])
    const a = store.readFiles(reader, 'c1', ['a'])
    await expect(big).rejects.toThrow('stream broke')
    expect((await a).get('a')).toEqual(text('A'))
    expect(store.peekFile('c1', 'big.txt')).toBeUndefined()

    reader.files.get('c1')!.set('big.txt', streamed(utf8('0123456789')).file)
    expect((await store.readFiles(reader, 'c1', ['big.txt'])).get('big.txt'))
      .toEqual(text('0123456789'))
  })

  it('cancels a streamed answer that no read is waiting for', async () => {
    const unwanted = streamed(utf8('unwanted'))
    const reader = new FakeReader()
    reader.files.set('c1', new Map([['a', text('A')]]))
    const answer = reader.readFilesAtCommit.bind(reader)
    reader.readFilesAtCommit = async (commitId, paths) =>
      [...await answer(commitId, paths), ['other', unwanted.file]]
    const store = new CommitFileStore()
    expect((await store.readFiles(reader, 'c1', ['a'])).get('a')).toEqual(text('A'))
    await Promise.resolve()
    expect(unwanted.state.cancelled).toBe(true)
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
