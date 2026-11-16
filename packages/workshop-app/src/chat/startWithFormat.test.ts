import { describe, expect, it } from 'vitest'
import { startWithFormat } from './startWithFormat'

const DOCUMENT = { noun: 'Document', icon: 'fileText' as const }

describe('startWithFormat', () => {
  it('names the format ahead of what was written, and says where exactly the name is', () => {
    const { text, formats } = startWithFormat(DOCUMENT, 'about our Q3 results')
    expect(text).toBe('Document about our Q3 results')
    expect(formats).toEqual([{ position: 0, length: 8, noun: 'Document', icon: 'fileText' }])
    // The server keeps only a ref that covers exactly its noun.
    expect(text.slice(formats[0].position, formats[0].position + formats[0].length)).toBe('Document')
  })

  it('is the name alone when nothing was written', () => {
    expect(startWithFormat(DOCUMENT, '').text).toBe('Document')
  })
})
