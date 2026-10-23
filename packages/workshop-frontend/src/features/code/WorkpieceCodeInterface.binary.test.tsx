// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileAtCommit, GadgetSummary, Overseer } from '@gadgets/workshop-shared/api'
import type { ChatCodeChanges, ChatLiveChangeRows } from '../../ChatInterface'
import type * as KumoModule from '@cloudflare/kumo'
import type * as FileBrowserModule from './FileBrowser'
import type * as FileTransfersModule from '../../fileTransfers'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

type BrowserProps = ComponentProps<typeof FileBrowserModule.default>
const browser = vi.hoisted(() => ({ props: undefined as BrowserProps | undefined }))
const saveBlobToFile = vi.hoisted(() => vi.fn<(blob: Blob, filename: string) => void>())
const toast = vi.hoisted(() => vi.fn<(options: { title: string, variant: string }) => void>())

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...await importOriginal<typeof KumoModule>(),
  useKumoToastManager: () => ({ add: toast }),
}))
vi.mock('./CodeEditor', () => ({ default: () => null }))
vi.mock('./CodeDiffEditor', () => ({ default: () => null }))
vi.mock('./FileBrowser', async (importOriginal) => ({
  ...await importOriginal<typeof FileBrowserModule>(),
  default: (props: BrowserProps) => { browser.props = props; return null },
}))
vi.mock('../../fileTransfers', async (importOriginal) => ({
  ...await importOriginal<typeof FileTransfersModule>(),
  saveBlobToFile,
}))

import WorkpieceCodeInterface from './WorkpieceCodeInterface'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])
const PNG_REF = { oid: '1'.repeat(40), byteLength: PNG.byteLength }

let container: HTMLDivElement
let root: Root
let commitNumber = 0
let head: string
let files: Map<string, FileAtCommit>
let objectUrls: Map<string, Blob>

const readBlob = vi.fn<Overseer['readBlob']>(async () => new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(PNG)
    controller.close()
  },
}))
const overseer = {
  listTree: async () => [...files.keys()].map(name => ({ name, kind: 'file' as const })),
  readFilesAtCommit: async (_commitId: string, paths: string[]) =>
    paths.map((path): [string, FileAtCommit] => [path, files.get(path) ?? { kind: 'absent' }]),
  readBlob,
} as unknown as ComponentProps<typeof WorkpieceCodeInterface>['overseer']

beforeEach(() => {
  // Commit content is cached page-wide, so each test gets its own immutable identity.
  head = `binary-head-${++commitNumber}`
  files = new Map([
    ['logo.PNG', { kind: 'blob', blob: PNG_REF }],
    ['data.bin', { kind: 'blob', blob: { oid: '2'.repeat(40), byteLength: 2048 } }],
  ])
  // jsdom has no object URLs.
  objectUrls = new Map()
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:test/${objectUrls.size}`
    objectUrls.set(url, blob)
    return url
  }
  URL.revokeObjectURL = (url: string) => { objectUrls.delete(url) }
  browser.props = undefined
  readBlob.mockClear()
  saveBlobToFile.mockClear()
  toast.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const browserProps = (): BrowserProps => {
  if (browser.props === undefined) throw new Error('The file browser has not rendered')
  return browser.props
}

const render = async (props: Partial<ComponentProps<typeof WorkpieceCodeInterface>> = {}) => {
  const summary: GadgetSummary = { id: 4, type: 'gadget', title: 'Files', commitId: head }
  await act(async () => { root.render(<WorkpieceCodeInterface overseer={overseer}
    summary={summary} isAgentActive={false} {...props} />) })
  await vi.waitFor(() => { expect(browserProps().tree.leaves.has('logo.PNG')).toBe(true) })
}

const select = async (filename: string) => {
  await act(async () => { browserProps().onFileSelect(filename) })
}

// The shown image and the blob behind its object URL.
const shownImage = async () => vi.waitFor(() => {
  const img = container.querySelector('img')
  const blob = img === null ? undefined : objectUrls.get(img.src)
  if (img === null || blob === undefined) throw new Error('No image is shown')
  return { img, blob }
})

// jsdom's Blob has no arrayBuffer().
const bytesOf = (blob: Blob) => {
  const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>()
  const reader = new FileReader()
  reader.addEventListener('load', () => {
    if (reader.result === null || typeof reader.result === 'string') reject(new Error('No bytes'))
    else resolve(new Uint8Array(reader.result))
  })
  reader.addEventListener('error', () => reject(reader.error))
  reader.readAsArrayBuffer(blob)
  return promise
}

describe('WorkpieceCodeInterface binary files', () => {
  it('shows a committed image and downloads its bytes', async () => {
    await render()
    await select('logo.PNG')
    const { img, blob } = await shownImage()
    expect(img.alt).toBe('logo.PNG')
    expect(readBlob).toHaveBeenCalledWith(PNG_REF.oid)
    expect(blob.type).toBe('image/png')
    expect(await bytesOf(blob)).toStrictEqual(PNG)

    const download = container.querySelector<HTMLButtonElement>('[aria-label="Download logo.PNG"]')
    expect(download?.disabled).toBe(false)
    await act(async () => { download?.click() })
    await vi.waitFor(() => { expect(saveBlobToFile).toHaveBeenCalledTimes(1) })
    expect(toast).not.toHaveBeenCalled()
    const [saved, filename] = saveBlobToFile.mock.calls[0]
    expect(filename).toBe('logo.PNG')
    expect(await bytesOf(saved)).toStrictEqual(PNG)
  })

  it('describes a binary file that is not an image instead of reading it', async () => {
    await render()
    await select('data.bin')
    await vi.waitFor(() => {
      expect(container.textContent).toContain('2.0 KB')
    })
    expect(readBlob).not.toHaveBeenCalled()
  })

  it('keeps showing an image after a visit to another binary file', async () => {
    await render()
    await select('logo.PNG')
    await shownImage()
    await select('data.bin')
    // The image's next read never lands, so only the earlier one can be shown.
    readBlob.mockImplementationOnce(() => Promise.withResolvers<ReadableStream<Uint8Array>>().promise)
    await select('logo.PNG')
    const img = container.querySelector('img')
    expect(img !== null && objectUrls.has(img.src)).toBe(true)
  })

  it('reads an image again when the user retries a failed read', async () => {
    readBlob.mockRejectedValueOnce(new Error('Connection lost'))
    await render()
    await select('logo.PNG')
    const retry = await vi.waitFor(() => {
      const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Try again')
      if (button === undefined) throw new Error('No retry is offered')
      return button
    })
    await act(async () => { retry.click() })
    await shownImage()
    expect(readBlob).toHaveBeenCalledTimes(2)
  })

  it('shows an image a chat added but has not committed', async () => {
    const chatChanges: ChatCodeChanges = { chatId: 1, rowsThrough: 0, codeBase: {
      pins: [{ gadgetId: 4, baseCommit: head, mergedCommit: head }], generation: 0, revision: 0,
    } }
    const rowListeners: Parameters<ChatLiveChangeRows['subscribe']>[0][] = []
    const liveRows: ChatLiveChangeRows = { chatId: 1, subscribe(listener) {
      rowListeners.push(listener)
      return () => { rowListeners.splice(rowListeners.indexOf(listener), 1) }
    } }
    await render({ selectedChatId: 1, chatChanges, liveRows })
    const photo = { oid: '3'.repeat(40), byteLength: PNG.byteLength }
    await act(async () => {
      for (const listener of rowListeners) {
        listener({ generation: 0, revision: 1, author: { type: 'user', id: 'a@example.com', name: 'A' },
          change: { 4: [['photo.webp', { setBytes: photo }]] } })
      }
    })
    await vi.waitFor(() => { expect(browserProps().tree.leaves.has('photo.webp')).toBe(true) })
    await select('photo.webp')
    const { blob } = await shownImage()
    expect(readBlob).toHaveBeenCalledWith(photo.oid)
    expect(blob.type).toBe('image/webp')
  })
})
