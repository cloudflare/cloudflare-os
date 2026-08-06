// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { MAX_SITE_LOGO_BYTES } from '@gadgets/workshop-shared/api'
import {
  applySiteFavicon,
  cacheBustSiteLogoUrl,
  prepareSiteLogo,
  siteLogoDimensions,
} from './siteLogoUtils'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mockCanvas(output: Blob) {
  const canvas = document.createElement('canvas')
  const drawImage = vi.fn<() => void>()
  vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage } as never)
  vi.spyOn(canvas, 'toBlob').mockImplementation(callback => callback(output))
  const createElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tagName, options) =>
    tagName === 'canvas' ? canvas : createElement(tagName, options))
  return { canvas, drawImage }
}

function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(24)
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  data.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8)
  const view = new DataView(data.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return data
}

function jpegHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(21)
  data.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08])
  const view = new DataView(data.buffer)
  view.setUint16(7, height)
  view.setUint16(9, width)
  return data
}

function webpHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(30)
  data.set(new TextEncoder().encode('RIFF'), 0)
  data.set(new TextEncoder().encode('WEBP'), 8)
  data.set(new TextEncoder().encode('VP8X'), 12)
  let adjustedWidth = width - 1
  let adjustedHeight = height - 1
  data.set([adjustedWidth, adjustedWidth >> 8, adjustedWidth >> 16], 24)
  data.set([adjustedHeight, adjustedHeight >> 8, adjustedHeight >> 16], 27)
  return data
}

describe('site logo dimensions', () => {
  it('fits the image within 256px without cropping or changing its aspect ratio', () => {
    expect(siteLogoDimensions(1000, 500)).toEqual({ width: 256, height: 128 })
    expect(siteLogoDimensions(500, 1000)).toEqual({ width: 128, height: 256 })
    expect(siteLogoDimensions(50, 50)).toEqual({ width: 256, height: 256 })
  })

  it('rejects empty image dimensions', () => {
    expect(() => siteLogoDimensions(0, 100)).toThrow('dimensions')
  })
})

describe('site logo preparation', () => {
  it('rasterizes without cropping and closes the decoded image', async () => {
    const close = vi.fn<() => void>()
    const bitmap = { width: 1000, height: 500, close }
    vi.stubGlobal('createImageBitmap', vi.fn<() => Promise<typeof bitmap>>().mockResolvedValue(bitmap))
    const source = pngHeader(1000, 500)
    const png = new Uint8Array([1])
    const output = {
      size: png.byteLength,
      arrayBuffer: vi.fn<() => Promise<ArrayBuffer>>().mockResolvedValue(png.buffer),
    } as unknown as Blob
    const { canvas, drawImage } = mockCanvas(output)

    const data = await prepareSiteLogo(new File([source], 'logo.png', { type: 'image/png' }))

    expect(canvas.width).toBe(256)
    expect(canvas.height).toBe(128)
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 256, 128)
    expect(data).toEqual(png)
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects oversized source files before decoding', async () => {
    const decode = vi.fn<() => void>()
    vi.stubGlobal('createImageBitmap', decode)
    const file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'logo.png', {
      type: 'image/png',
    })

    await expect(prepareSiteLogo(file)).rejects.toThrow('max 5 MB')
    expect(decode).not.toHaveBeenCalled()
  })

  it('rejects dangerous raster dimensions before decoding', async () => {
    const decode = vi.fn<() => void>()
    vi.stubGlobal('createImageBitmap', decode)

    for (const [name, type, data] of [
      ['PNG', 'image/png', pngHeader(100_000, 1)],
      ['JPEG', 'image/jpeg', jpegHeader(65_000, 1)],
      ['WebP', 'image/webp', webpHeader(100_000, 1)],
    ] as const) {
      await expect(prepareSiteLogo(new File([data], `logo.${name}`, { type })))
        .rejects.toThrow('dimensions')
    }
    expect(decode).not.toHaveBeenCalled()
  })

  it('rejects encoded PNG output over the backend limit', async () => {
    const close = vi.fn<() => void>()
    const bitmap = { width: 100, height: 100, close }
    vi.stubGlobal('createImageBitmap', vi.fn<() => Promise<typeof bitmap>>().mockResolvedValue(bitmap))
    const output = { size: MAX_SITE_LOGO_BYTES + 1 } as Blob
    mockCanvas(output)

    await expect(prepareSiteLogo(new File([pngHeader(100, 100)], 'logo.png', {
      type: 'image/png',
    }))).rejects.toThrow('upload limit')
    expect(close).toHaveBeenCalledOnce()
  })

  it('supports SVG dimensions expressed in physical units through native decoding', async () => {
    const createUrl = vi.fn<() => string>().mockReturnValue('blob:logo')
    const revokeUrl = vi.fn<(url: string) => void>()
    vi.stubGlobal('URL', { createObjectURL: createUrl, revokeObjectURL: revokeUrl })
    class FakeImage extends EventTarget {
      naturalWidth = 10_000
      naturalHeight = 1_000
      set src(_value: string) { queueMicrotask(() => this.dispatchEvent(new Event('load'))) }
    }
    vi.stubGlobal('Image', FakeImage)
    const output = {
      size: 1,
      arrayBuffer: vi.fn<() => Promise<ArrayBuffer>>()
        .mockResolvedValue(new Uint8Array([1]).buffer),
    } as unknown as Blob
    const { canvas } = mockCanvas(output)
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="10mm"/>'

    await prepareSiteLogo(new File([svg], 'logo.svg', { type: 'image/svg+xml' }))

    expect(canvas.width).toBe(256)
    expect(canvas.height).toBe(26)
    expect(revokeUrl).toHaveBeenCalledWith('blob:logo')
  })

  it('rejects SVGs with embedded raster resources before native decoding', async () => {
    const createUrl = vi.fn<() => string>()
    vi.stubGlobal('URL', { createObjectURL: createUrl, revokeObjectURL: vi.fn<() => void>() })
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/2000/svg"><x:image href="d&#97;ta:image/png;base64,AA=="/></svg>'

    await expect(prepareSiteLogo(new File([svg], 'logo.svg', { type: 'image/svg+xml' })))
      .rejects.toThrow('embedded images')
    expect(createUrl).not.toHaveBeenCalled()
  })
})

describe('site favicon', () => {
  it('fetches the custom PNG once before assigning a blob favicon', async () => {
    document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon.svg">'
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' })
    const fetchLogo = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(blob),
    } as Response)
    const createUrl = vi.fn<(blob: Blob) => string>().mockReturnValue('blob:favicon')
    const revokeUrl = vi.fn<(url: string) => void>()
    vi.stubGlobal('fetch', fetchLogo)
    vi.stubGlobal('URL', { createObjectURL: createUrl, revokeObjectURL: revokeUrl })

    const cleanup = applySiteFavicon('/api/site-logo?v=revision')
    const favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')!
    expect(favicon.getAttribute('href')).toBe('/favicon.svg')

    await vi.waitFor(() => expect(favicon.getAttribute('href')).toBe('blob:favicon'))
    expect(favicon.type).toBe('image/png')
    expect(fetchLogo).toHaveBeenCalledOnce()

    cleanup()
    expect(revokeUrl).toHaveBeenCalledWith('blob:favicon')
  })
})

describe('site logo cache busting', () => {
  it('adds a client-only token to canonical URLs', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const first = cacheBustSiteLogoUrl('/api/site-logo')
    const second = cacheBustSiteLogoUrl('/api/site-logo')
    expect(first).toMatch(/^\/api\/site-logo\?v=rs-\d+$/)
    expect(second).not.toBe(first)
  })
})
