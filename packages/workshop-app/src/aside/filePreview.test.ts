import { describe, expect, it } from 'vitest'
import { decodeText, previewOf } from './filePreview'

const text = (value: string) => new TextEncoder().encode(value)
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PDF = text('%PDF-1.7\n')

describe('previewOf', () => {
  it('shows images, PDFs, audio and video as the browser does', () => {
    expect(previewOf({ name: 'a.png', mimeType: 'image/png' }, PNG)).toEqual({ kind: 'image', type: 'image/png' })
    expect(previewOf({ name: 'a.pdf', mimeType: 'application/pdf' }, PDF)).toEqual({ kind: 'pdf', type: 'application/pdf' })
    expect(previewOf({ name: 'a.wav', mimeType: 'audio/wav' }, new Uint8Array(4))).toEqual({ kind: 'audio', type: 'audio/wav' })
    expect(previewOf({ name: 'a.mp4', mimeType: 'video/mp4' }, new Uint8Array(4))).toEqual({ kind: 'video', type: 'video/mp4' })
  })

  it('shows text, code, CSV and Markdown as text', () => {
    expect(previewOf({ name: 'notes.txt', mimeType: 'text/plain' }, text('hi'))).toEqual({ kind: 'text', text: 'hi' })
    expect(previewOf({ name: 'a.ts', mimeType: '' }, text('let a'))).toEqual({ kind: 'text', text: 'let a' })
    expect(previewOf({ name: 'a.csv', mimeType: 'text/csv' }, text('a,b'))).toEqual({ kind: 'text', text: 'a,b' })
    expect(previewOf({ name: 'README.md', mimeType: 'text/plain' }, text('# Hi'))).toEqual({ kind: 'markdown', text: '# Hi' })
  })

  it('shows a page as its text, never running it', () => {
    expect(previewOf({ name: 'a.html', mimeType: 'text/html' }, text('<script>1</script>'))).toEqual({ kind: 'text', text: '<script>1</script>' })
  })

  it('shows an SVG as what it is written in, never as an image, which could run its script', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>'
    expect(previewOf({ name: 'logo.svg', mimeType: 'image/svg+xml' }, text(svg))).toEqual({ kind: 'text', text: svg })
    expect(previewOf({ name: 'logo.svg', mimeType: '' }, text(svg))).toEqual({ kind: 'text', text: svg })
    expect(previewOf({ name: 'logo.svg', mimeType: 'IMAGE/SVG+XML' }, text(svg))).toEqual({ kind: 'text', text: svg })
  })

  it('shows only raster images as images, going by the bytes for any other kind of image', () => {
    const AVIF = Uint8Array.from([0, 0, 0, 0x1c, ...text('ftypavif')])
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']) {
      expect(previewOf({ name: 'a', mimeType: type }, PNG)).toEqual({ kind: 'image', type })
    }
    expect(previewOf({ name: 'a.heic', mimeType: 'image/heic' }, PNG)).toEqual({ kind: 'image', type: 'image/png' })
    expect(previewOf({ name: 'a.avif', mimeType: 'image/x-avif' }, AVIF)).toEqual({ kind: 'image', type: 'image/avif' })
    expect(previewOf({ name: 'a.bmp', mimeType: 'image/bmp' }, new Uint8Array([0x42, 0x4d, 0, 0xff]))).toEqual({ kind: 'none' })
  })

  it('goes by the bytes for a file that does not say what it is', () => {
    expect(previewOf({ name: 'File', mimeType: '' }, PNG)).toEqual({ kind: 'image', type: 'image/png' })
    expect(previewOf({ name: 'File', mimeType: 'application/octet-stream' }, PDF)).toEqual({ kind: 'pdf', type: 'application/pdf' })
    expect(previewOf({ name: 'File', mimeType: '' }, text('plain'))).toEqual({ kind: 'text', text: 'plain' })
    expect(previewOf({ name: 'File', mimeType: '' }, new Uint8Array([0, 1, 2]))).toEqual({ kind: 'none' })
  })

  it('does not show what it cannot, or what is not what it says', () => {
    expect(previewOf({ name: 'a.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, new Uint8Array(4))).toEqual({ kind: 'none' })
    expect(previewOf({ name: 'a.pdf', mimeType: 'application/pdf' }, text('<html>'))).toEqual({ kind: 'none' })
  })
})

describe('decodeText', () => {
  it('reads UTF-8, and nothing that is binary', () => {
    expect(decodeText(text('héllo'))).toBe('héllo')
    expect(decodeText(new Uint8Array([0xff, 0xfe]))).toBeUndefined()
    expect(decodeText(new Uint8Array([0x61, 0x00]))).toBeUndefined()
  })
})
