// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_ISSUE_REPORT_IMAGE_BYTES } from '@gadgets/workshop-shared/api'
import { REPORT_IMAGE_ACCEPT, prepareReportImage } from './reportImage'

const imageOf = (bytes: number, type: string) => new Blob([new Uint8Array(bytes)], { type })

/**
 * A browser that decodes any image as 4000 by 2000 and encodes a canvas to as many bytes as
 * `encodedBytes` says for its width. Records each encoding it was asked for.
 */
const fakeEncoder = (encodedBytes: (width: number) => number) => {
  const encodings: { width: number; height: number; type: string }[] = []
  const bitmap = { width: 4000, height: 2000, close: vi.fn<() => void>() }
  vi.stubGlobal('createImageBitmap', async () => bitmap)
  const drawImage = vi.fn<(...args: unknown[]) => void>()
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toBlob(done: (blob: Blob | null) => void, type: string) {
      encodings.push({ width: this.width, height: this.height, type })
      done(imageOf(encodedBytes(this.width), type))
    },
  }
  const createElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => (
    tag === 'canvas' ? canvas : createElement(tag)
  ) as HTMLElement)
  return { encodings, bitmap, drawImage }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('prepareReportImage', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp'])('sends a %s within the bound as it is', async (type) => {
    const image = imageOf(MAX_ISSUE_REPORT_IMAGE_BYTES, type)
    await expect(prepareReportImage(image)).resolves.toBe(image)
  })

  it.each(['image/gif', 'image/svg+xml', 'application/pdf', ''])(
    'refuses a file of type "%s" before anything is uploaded', async (type) => {
      await expect(prepareReportImage(imageOf(10, type)))
        .rejects.toThrow('Only PNG, JPEG and WebP images can be attached.')
    },
  )

  it('re-encodes an image over the bound as WebP at its own size when that fits', async () => {
    const encoder = fakeEncoder(() => 1024)
    const prepared = await prepareReportImage(imageOf(MAX_ISSUE_REPORT_IMAGE_BYTES + 1, 'image/png'))

    expect(prepared.type).toBe('image/webp')
    expect(prepared.size).toBe(1024)
    expect(encoder.encodings).toEqual([{ width: 4000, height: 2000, type: 'image/webp' }])
    expect(encoder.bitmap.close).toHaveBeenCalledOnce()
  })

  it('scales an image down until its encoding fits, and sends the largest that does', async () => {
    // Fits only at half the width or less.
    const encoder = fakeEncoder((width) => width <= 2000 ? 4096 : MAX_ISSUE_REPORT_IMAGE_BYTES + 1)
    const prepared = await prepareReportImage(imageOf(MAX_ISSUE_REPORT_IMAGE_BYTES * 2, 'image/png'))

    expect(prepared.size).toBe(4096)
    expect(encoder.encodings.map(({ width, height }) => [width, height]))
      .toEqual([[4000, 2000], [3000, 1500], [2000, 1000]])
    expect(encoder.drawImage).toHaveBeenLastCalledWith(encoder.bitmap, 0, 0, 2000, 1000)
  })

  it('refuses an image that fits at no size, saying the bound', async () => {
    const encoder = fakeEncoder(() => MAX_ISSUE_REPORT_IMAGE_BYTES + 1)
    await expect(prepareReportImage(imageOf(MAX_ISSUE_REPORT_IMAGE_BYTES + 1, 'image/jpeg')))
      .rejects.toThrow('This image is over 5 MiB and could not be made smaller.')
    expect(encoder.encodings).toHaveLength(5)
    expect(encoder.bitmap.close).toHaveBeenCalledOnce()
  })

  it('refuses an image over the bound that the browser cannot decode', async () => {
    vi.stubGlobal('createImageBitmap', async () => { throw new Error('undecodable') })
    await expect(prepareReportImage(imageOf(MAX_ISSUE_REPORT_IMAGE_BYTES + 1, 'image/webp')))
      .rejects.toThrow('This image is over 5 MiB and could not be made smaller.')
  })
})

describe('REPORT_IMAGE_ACCEPT', () => {
  it('names the three types a report takes and nothing else', () => {
    expect(REPORT_IMAGE_ACCEPT).toBe('image/png,image/jpeg,image/webp')
  })
})
