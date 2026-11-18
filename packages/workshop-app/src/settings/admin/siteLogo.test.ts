import { describe, expect, it } from 'vitest'
import { cacheBustSiteLogoUrl, hasExternalSvgResource, imageDimensions, siteLogoDimensions } from './siteLogo'

const pngHeader = (width: number, height: number) => {
  const data = new Uint8Array(24)
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  data.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8)
  const view = new DataView(data.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return data
}

const jpegHeader = (width: number, height: number) => {
  const data = new Uint8Array(21)
  data.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08])
  const view = new DataView(data.buffer)
  view.setUint16(7, height)
  view.setUint16(9, width)
  return data
}

const webpHeader = (width: number, height: number) => {
  const data = new Uint8Array(30)
  data.set(new TextEncoder().encode('RIFF'), 0)
  data.set(new TextEncoder().encode('WEBP'), 8)
  data.set(new TextEncoder().encode('VP8X'), 12)
  data.set([width - 1, (width - 1) >> 8, (width - 1) >> 16], 24)
  data.set([height - 1, (height - 1) >> 8, (height - 1) >> 16], 27)
  return data
}

describe('siteLogoDimensions', () => {
  it('fits the image within 256px without cropping or changing its aspect ratio', () => {
    expect(siteLogoDimensions(1024, 512)).toEqual({ width: 256, height: 128 })
    expect(siteLogoDimensions(300, 1200)).toEqual({ width: 64, height: 256 })
    expect(siteLogoDimensions(64, 64)).toEqual({ width: 256, height: 256 })
  })

  it('refuses an image with no size', () => {
    expect(() => siteLogoDimensions(0, 10)).toThrow('Invalid image dimensions.')
  })
})

describe('imageDimensions', () => {
  it('reads the size from a PNG’s, a JPEG’s and a WebP’s header', () => {
    expect(imageDimensions(pngHeader(800, 600))).toEqual({ width: 800, height: 600 })
    expect(imageDimensions(jpegHeader(640, 480))).toEqual({ width: 640, height: 480 })
    expect(imageDimensions(webpHeader(1000, 250))).toEqual({ width: 1000, height: 250 })
  })

  it('knows nothing of anything else', () => {
    expect(imageDimensions(new TextEncoder().encode('GIF89a and the rest'))).toBeNull()
  })
})

describe('hasExternalSvgResource', () => {
  it('finds what reaches outside the file, but not a reference within it', () => {
    expect(hasExternalSvgResource('fill: url(https://example.com/a.svg#p)')).toBe(true)
    expect(hasExternalSvgResource('@import "theme.css";')).toBe(true)
    expect(hasExternalSvgResource('fill: url(#gradient)')).toBe(false)
    expect(hasExternalSvgResource('fill: url("#gradient")')).toBe(false)
  })
})

describe('cacheBustSiteLogoUrl', () => {
  it('adds a token of its own to the address, which differs each time', () => {
    const first = cacheBustSiteLogoUrl('/api/site-logo')
    expect(first).toMatch(/^\/api\/site-logo\?v=/)
    expect(cacheBustSiteLogoUrl('/api/site-logo?id=1')).toMatch(/^\/api\/site-logo\?id=1&v=/)
    expect(cacheBustSiteLogoUrl('/api/site-logo')).not.toBe(first)
  })
})
