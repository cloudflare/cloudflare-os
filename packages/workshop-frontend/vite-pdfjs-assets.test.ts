import { describe, expect, it } from 'vitest'
import { pdfjsAssets } from './vite-pdfjs-assets'

describe('pdfjsAssets', () => {
  // A pdfjs-dist upgrade that renames one of these directories would otherwise show only as PDFs
  // drawn with text or images missing.
  it('emits the files pdf.js fetches by name from each directory it is pointed at', () => {
    const emitted: string[] = []
    const plugin = pdfjsAssets()
    const generateBundle = plugin.generateBundle as (this: { emitFile(file: { fileName: string }): void }) => void
    generateBundle.call({ emitFile: (file) => { emitted.push(file.fileName) } })

    const directories = new Set(emitted.map((name) => name.split('/')[1]))
    expect([...directories].toSorted()).toEqual(['cmaps', 'iccs', 'standard_fonts', 'wasm'])
    expect(emitted.every((name) => name.startsWith('pdfjs/'))).toBe(true)
  })
})
