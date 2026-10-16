// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileAtCommit, GadgetSummary, Overseer } from '@gadgets/workshop-shared/api'
import type { ChatCodeChanges, ChatLiveChangeRows } from '../../ChatInterface'
import type { ChatChangeRow } from './otClient'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

type BrowserProps = ComponentProps<typeof import('./FileBrowser').default>
const browser = vi.hoisted(() => ({ props: undefined as BrowserProps | undefined }))
const toast = vi.hoisted(() => vi.fn<(options: { title: string, variant: string }) => void>())

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...await importOriginal() as typeof import('@cloudflare/kumo'),
  useKumoToastManager: () => ({ add: toast }),
}))
vi.mock('./CodeEditor', () => ({ default: () => null }))
vi.mock('./CodeDiffEditor', () => ({ default: () => null }))
vi.mock('./FileBrowser', async (importOriginal) => ({
  ...await importOriginal() as typeof import('./FileBrowser'),
  default: (props: BrowserProps) => { browser.props = props; return null },
}))

import WorkpieceCodeInterface from './WorkpieceCodeInterface'

let container: HTMLDivElement
let root: Root
let commitNumber = 0
let head: string
let files: Map<string, FileAtCommit>
let receiveRow: ((row: ChatChangeRow) => void) | undefined
let delayedRead: Promise<FileAtCommit> | undefined

const readFiles = vi.fn<Overseer['readFilesAtCommit']>(async (_commitId, paths) =>
  Promise.all(paths.map(async (path): Promise<[string, FileAtCommit]> => [path,
    path === 'later.txt' && delayedRead ? await delayedRead : files.get(path) ?? { kind: 'absent' },
  ])))
const submit = vi.fn<Overseer['submitCodeChange']>(async () => ({ generation: 0, revision: 1 }))
const overseer = {
  listTree: async () => [...files.keys()].map(name => ({ name, kind: 'file' as const })),
  readFilesAtCommit: readFiles,
  submitCodeChange: submit,
} as unknown as ComponentProps<typeof WorkpieceCodeInterface>['overseer']

beforeEach(() => {
  // Commit content is cached page-wide, so each test gets its own immutable identity.
  head = `rename-head-${++commitNumber}`
  files = new Map([
    ['a.txt', { kind: 'text', text: 'first\n' }],
    ['later.txt', { kind: 'text', text: 'original\n' }],
    ['opaque.bin', { kind: 'unreadable', message: 'not a text file' }],
  ])
  delayedRead = undefined
  receiveRow = undefined
  browser.props = undefined
  toast.mockClear()
  readFiles.mockClear()
  submit.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = async () => {
  const summary: GadgetSummary = { id: 4, type: 'gadget', title: 'Files', commitId: head }
  const chatChanges: ChatCodeChanges = { chatId: 1, rowsThrough: 0, codeBase: {
    pins: [{ gadgetId: 4, baseCommit: head, mergedCommit: head }], generation: 0, revision: 0,
  } }
  const liveRows: ChatLiveChangeRows = { chatId: 1, subscribe(listener) {
    receiveRow = listener
    return () => { receiveRow = undefined }
  } }
  await act(async () => { root.render(<WorkpieceCodeInterface overseer={overseer}
    summary={summary} selectedChatId={1} chatChanges={chatChanges} liveRows={liveRows}
    isAgentActive={false} />) })
  await vi.waitFor(() => {
    expect(browser.props?.editLocked).toBe(false)
    expect(browser.props?.tree.leaves.has('later.txt')).toBe(true)
  })
}

describe('WorkpieceCodeInterface rename', () => {
  it('reports a missing file without treating it as binary', async () => {
    await render()
    await act(async () => { await browser.props!.onFileRename('missing.txt', 'new.txt') })
    expect(toast).toHaveBeenLastCalledWith({ title: 'File not found', variant: 'error' })
    expect(submit).not.toHaveBeenCalled()
  })

  it('still rejects non-text content with a distinct explanation', async () => {
    await render()
    await act(async () => { await browser.props!.onFileRename('opaque.bin', 'new.bin') })
    expect(toast).toHaveBeenLastCalledWith({
      title: 'Only text files can be renamed in this editor', variant: 'error',
    })
    expect(submit).not.toHaveBeenCalled()
  })

  it('reports a file deleted by a collaborator while its rename read was pending', async () => {
    await render()
    let resolveRead!: (file: FileAtCommit) => void
    delayedRead = new Promise(resolve => { resolveRead = resolve })
    await act(async () => {
      browser.props!.onFileRename('later.txt', 'new.txt')
      await vi.waitFor(() => {
        expect(readFiles.mock.calls.some(([, paths]) => paths.includes('later.txt'))).toBe(true)
      })
    })
    await act(async () => {
      receiveRow!({ generation: 0, revision: 1, author: { type: 'user', id: 'other@example.com', name: 'Other' },
        change: { 4: [['later.txt', { remove: true }]] } })
    })
    await act(async () => { resolveRead({ kind: 'text', text: 'original\n' }) })
    await vi.waitFor(() => {
      expect(toast).toHaveBeenLastCalledWith({ title: 'File not found', variant: 'error' })
    })
    expect(submit).not.toHaveBeenCalled()
  })

  it('still renames a text file through the normal change submission', async () => {
    await render()
    await act(async () => { await browser.props!.onFileRename('later.txt', 'new.txt') })
    expect(toast).toHaveBeenLastCalledWith({
      title: 'Renamed file: later.txt → new.txt', variant: 'success',
    })
    await vi.waitFor(() => { expect(submit).toHaveBeenCalledTimes(1) })
    expect(submit.mock.calls[0]).toEqual([1, expect.objectContaining({ change: {
      4: [['later.txt', { remove: true }], ['new.txt', { set: 'original\n' }]],
    } })])
  })
})
