// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { IssueReportImage } from '@gadgets/workshop-shared/api'
import { IssueImages } from './IssueImages'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

type Read = (imageId: string) => Promise<ReadableStream<Uint8Array>>

const PNG: IssueReportImage = { id: 'image-1', type: 'image/png', byteLength: 5 }
const WEBP: IssueReportImage = { id: 'image-2', type: 'image/webp', byteLength: 3 }

// A stream of `chunks` that then ends.
const streamOf = (...chunks: number[][]) => new ReadableStream<Uint8Array>({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk))
    controller.close()
  },
})

// A stream that gives one chunk and never ends, with the spy its cancellation calls.
const endlessStream = () => {
  const cancel = vi.fn<() => void>()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])) },
    cancel,
  })
  return { stream, cancel }
}

// The Blobs object URLs were made of, in order: jsdom makes no object URLs of its own.
const realUrls = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL }
let blobs: Blob[]
const createObjectURL = vi.fn<(blob: Blob) => string>()
const revokeObjectURL = vi.fn<(url: string) => void>()
let container: HTMLDivElement | undefined
let root: Root | undefined

beforeEach(() => {
  blobs = []
  createObjectURL.mockReset().mockImplementation((blob) => `blob:test/${blobs.push(blob)}`)
  revokeObjectURL.mockReset()
  URL.createObjectURL = createObjectURL
  URL.revokeObjectURL = revokeObjectURL
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const unmount = async () => {
  await act(async () => root?.unmount())
  root = undefined
}

afterEach(async () => {
  await unmount()
  container?.remove()
  vi.restoreAllMocks()
  Object.assign(URL, realUrls)
})

const render = async (images: IssueReportImage[], read: Read) => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => { root!.render(<IssueImages images={images} read={read} />) })
}

const shownImages = () => [...container!.querySelectorAll('img')]

it('shows each image through an object URL of a Blob typed as the server recognised it', async () => {
  const read = vi.fn<Read>()
    .mockResolvedValueOnce(streamOf([1, 2, 3], [4, 5]))
    .mockResolvedValueOnce(streamOf([6, 7, 8]))
  await render([PNG, WEBP], read)

  expect(read.mock.calls).toEqual([['image-1'], ['image-2']])
  expect(blobs.map((blob) => [blob.type, blob.size])).toEqual([['image/png', 5], ['image/webp', 3]])
  expect(shownImages().map((image) => image.getAttribute('src'))).toEqual(['blob:test/1', 'blob:test/2'])
  expect(shownImages().map((image) => image.alt)).toEqual([
    'Image 1 of 2 sent with this report',
    'Image 2 of 2 sent with this report',
  ])
})

it('renders the bytes in an <img> and nowhere a browser could read them as anything else', async () => {
  await render([PNG], async () => streamOf([1]))

  expect(shownImages()).toHaveLength(1)
  expect(container!.querySelector('a, object, embed, iframe, [download]')).toBeNull()
})

it('reads one image at a time', async () => {
  const first = Promise.withResolvers<ReadableStream<Uint8Array>>()
  const read = vi.fn<Read>().mockReturnValueOnce(first.promise).mockResolvedValueOnce(streamOf([9]))
  await render([PNG, WEBP], read)
  expect(read).toHaveBeenCalledOnce()

  await act(async () => { first.resolve(streamOf([1])) })
  expect(read).toHaveBeenCalledTimes(2)
  expect(shownImages()).toHaveLength(2)
})

it('reads and renders nothing for a report with no image', async () => {
  const read = vi.fn<Read>()
  await render([], read)

  expect(read).not.toHaveBeenCalled()
  expect(container!.innerHTML).toBe('')
})

it('says which image could not be read, and still shows the others', async () => {
  const read = vi.fn<Read>()
    .mockRejectedValueOnce(new Error('No such issue report.'))
    .mockResolvedValueOnce(streamOf([6]))
  await render([PNG, WEBP], read)

  expect(container!.querySelector('[role="alert"]')?.textContent).toBe('Couldn’t load image 1 of 2.')
  expect(shownImages().map((image) => image.getAttribute('src'))).toEqual(['blob:test/1'])
  expect(blobs[0].type).toBe('image/webp')
})

it('revokes every URL it made when it unmounts', async () => {
  await render([PNG, WEBP], async () => streamOf([1]))
  expect(revokeObjectURL).not.toHaveBeenCalled()

  await unmount()

  expect(revokeObjectURL.mock.calls).toEqual([['blob:test/1'], ['blob:test/2']])
})

it('cancels the read in flight when it unmounts, makes no URL of it and reads no further image', async () => {
  const { stream, cancel } = endlessStream()
  const read = vi.fn<Read>().mockResolvedValueOnce(stream)
  await render([PNG, WEBP], read)
  expect(cancel).not.toHaveBeenCalled()

  await unmount()
  // Whatever the cancelled read still had to settle.
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(cancel).toHaveBeenCalledOnce()
  expect(createObjectURL).not.toHaveBeenCalled()
  expect(read).toHaveBeenCalledOnce()
})

it('cancels a stream that arrives after it unmounted', async () => {
  const late = Promise.withResolvers<ReadableStream<Uint8Array>>()
  const { stream, cancel } = endlessStream()
  await render([PNG], () => late.promise)

  await unmount()
  late.resolve(stream)
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(cancel).toHaveBeenCalledOnce()
  expect(createObjectURL).not.toHaveBeenCalled()
})

it('does not read an image again when the report is read again', async () => {
  const read = vi.fn<Read>(async () => streamOf([1]))
  await render([PNG], read)

  // The same image in a new array, as a second read of the report returns it.
  await act(async () => { root!.render(<IssueImages images={[{ ...PNG }]} read={read} />) })

  expect(read).toHaveBeenCalledOnce()
  expect(shownImages()).toHaveLength(1)
})
