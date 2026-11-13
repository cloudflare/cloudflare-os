import { describe, expect, it } from 'vitest'
import { isSvgImage, looksLikeSvg, svgDataUrl } from './svgImage'

describe('isSvgImage', () => {
  it('is what says it is an SVG, or is named one and says no other kind of image', () => {
    expect(isSvgImage({ name: 'a', type: 'image/svg+xml' })).toBe(true)
    expect(isSvgImage({ name: 'a', type: 'IMAGE/SVG+XML; charset=utf-8' })).toBe(true)
    expect(isSvgImage({ name: 'logo.SVG', type: '' })).toBe(true)
    expect(isSvgImage({ name: 'logo.svg', type: 'application/octet-stream' })).toBe(true)
    expect(isSvgImage({ name: 'logo.svg', type: 'image/png' })).toBe(false)
    expect(isSvgImage({ name: 'page.html', type: 'text/html' })).toBe(false)
    expect(isSvgImage({ name: 'a', type: '' })).toBe(false)
  })
})

describe('looksLikeSvg', () => {
  it('is text with an svg element in it', () => {
    expect(looksLikeSvg('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe(true)
    expect(looksLikeSvg('<SVG>')).toBe(true)
    expect(looksLikeSvg('<html><body>hi</body></html>')).toBe(false)
    expect(looksLikeSvg('<svgfoo>')).toBe(false)
  })
})

describe('svgDataUrl', () => {
  it('carries the bytes as they are, typed as an SVG', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>héllo</text></svg>'
    const url = svgDataUrl(new TextEncoder().encode(svg))
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true)
    const bytes = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (char) => char.charCodeAt(0))
    expect(new TextDecoder().decode(bytes)).toBe(svg)
  })

  it('carries a file larger than one call can take', () => {
    const bytes = new Uint8Array(200_000).fill(0x41)
    expect(atob(svgDataUrl(bytes).split(',')[1])).toHaveLength(200_000)
  })
})
