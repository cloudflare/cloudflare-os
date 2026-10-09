// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileAtCommit, GadgetSummary, TreeNode } from '@gadgets/workshop-shared/api'
import type { ChatCodeChanges } from '../../ChatInterface'
import type { ChangedFile } from './workpieceTree'

// Covers the Changes list of a chat pinned at a merge commit (see ChatGadgetPinState): a file
// that the merge changed and the chat's content never touched is still a change the chat
// proposes. The editors are stubbed out, and the file browser only records what it was given.

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const listed = vi.hoisted(() => ({ changes: [] as readonly ChangedFile[] }))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...await importOriginal() as typeof import('@cloudflare/kumo'),
  useKumoToastManager: () => ({ add: () => {} }),
}))
vi.mock('./CodeEditor', () => ({ default: () => null }))
vi.mock('./CodeDiffEditor', () => ({ default: () => null }))
vi.mock('./FileBrowser', async (importOriginal) => ({
  ...await importOriginal() as typeof import('./FileBrowser'),
  default: ({ changes }: { changes: readonly ChangedFile[] }) => {
    listed.changes = changes
    return null
  },
}))

import WorkpieceCodeInterface from './WorkpieceCodeInterface'

const CHAT_ID = 1
// Commit ids unique to this file: the store behind the view is page-wide.
const HEAD = 'merged-changes-head'
const MERGE = 'merged-changes-merge'
const GADGET: GadgetSummary = { id: 4, type: 'gadget', title: 'Planner', commitId: HEAD }

// A second copy of the same two commits, for a test that needs the store not to hold them yet.
const RETRY_HEAD = 'merged-changes-retry-head'
const RETRY_MERGE = 'merged-changes-retry-merge'
const asOriginal = (commitId: string) =>
  commitId === RETRY_HEAD ? HEAD : commitId === RETRY_MERGE ? MERGE : commitId

const TREES: Record<string, TreeNode[]> = {
  [HEAD]: [{ name: 'client.js', kind: 'file' }, { name: 'old.js', kind: 'file' }],
  [MERGE]: [{ name: 'client.js', kind: 'file' }, { name: 'server.js', kind: 'file' }],
}
const FILES: Record<string, Record<string, string>> = {
  [HEAD]: { 'client.js': 'const days = 3\n', 'old.js': 'old\n' },
  [MERGE]: { 'client.js': 'const days = 7\n', 'server.js': 'serve()\n' },
}

const listChangedPaths = vi.fn<(fromCommit: string, toCommit: string) => Promise<string[]>>(
  async (fromCommit, toCommit) =>
    [fromCommit, toCommit].map(asOriginal).toSorted().join() === [HEAD, MERGE].toSorted().join()
      ? ['client.js', 'old.js', 'server.js'] : [])

const overseer = {
  listTree: async (commitId: string) => TREES[asOriginal(commitId)] ?? [],
  readFilesAtCommit: async (commitId: string, paths: string[]) =>
    paths.map((path): [string, FileAtCommit] => {
      const text = FILES[asOriginal(commitId)]?.[path]
      return [path, text === undefined ? { kind: 'absent' } : { kind: 'text', text }]
    }),
  listChangedPaths,
} as unknown as ComponentProps<typeof WorkpieceCodeInterface>['overseer']

// The chat as an update from mainline leaves it: re-rooted at the merge commit, whose first
// parent is the head, with nothing edited since but `client.js`, which the user put back.
const chatChanges: ChatCodeChanges = {
  chatId: CHAT_ID,
  codeBase: {
    pins: [{ gadgetId: GADGET.id, baseCommit: MERGE, mergedCommit: HEAD }],
    generation: 1,
    revision: 1,
  },
  epochChange: { [GADGET.id]: [['client.js', { set: 'const days = 3\n' }]] },
  rowsThrough: 1,
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  listed.changes = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  listChangedPaths.mockClear()
})

const render = (changes: ChatCodeChanges) => act(async () => {
  root.render(
    <WorkpieceCodeInterface
      overseer={overseer}
      summary={GADGET}
      isAgentActive={false}
      selectedChatId={CHAT_ID}
      chatChanges={changes}
    />,
  )
})

describe('WorkpieceCodeInterface changes of a merge', () => {
  it('lists the files that only the merge changed', async () => {
    await render(chatChanges)

    await vi.waitFor(() => {
      expect(listed.changes).toEqual([
        { path: 'old.js', status: 'deleted' },
        { path: 'server.js', status: 'added' },
      ])
    })
    // client.js differs between the two commits, but the chat's own content for it is what
    // counts, and that matches the head.
    expect(listChangedPaths).toHaveBeenCalledWith(HEAD, MERGE)
  })

  it('asks nothing of a pin that is not rooted at a merge', async () => {
    await render({
      ...chatChanges,
      codeBase: {
        ...chatChanges.codeBase!,
        pins: [{ gadgetId: GADGET.id, baseCommit: HEAD, mergedCommit: HEAD }],
      },
      epochChange: { [GADGET.id]: [['client.js', { set: 'const days = 7\n' }]] },
    })

    await vi.waitFor(() => {
      expect(listed.changes).toEqual([{ path: 'client.js', status: 'modified' }])
    })
    expect(listChangedPaths).not.toHaveBeenCalled()
  })

  // A file the merge deleted is in no other listing, so a failed read must not hide it.
  it('shows a failed read of the merge’s files, and lists them once a retry succeeds', async () => {
    const failing = vi.spyOn(console, 'error').mockImplementation(() => {})
    listChangedPaths.mockRejectedValueOnce(new Error('connection lost'))
    await render({
      ...chatChanges,
      codeBase: {
        ...chatChanges.codeBase!,
        pins: [{ gadgetId: GADGET.id, baseCommit: RETRY_MERGE, mergedCommit: RETRY_HEAD }],
      },
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Some of this draft\'s changes could not be loaded')
    })
    expect(listed.changes).toEqual([])

    const retry = [...container.querySelectorAll('button')]
      .find(button => button.textContent === 'Try again')
    await act(async () => { retry!.click() })

    await vi.waitFor(() => {
      expect(listed.changes).toEqual([
        { path: 'old.js', status: 'deleted' },
        { path: 'server.js', status: 'added' },
      ])
    })
    expect(container.textContent).not.toContain('could not be loaded')
    failing.mockRestore()
  })
})
