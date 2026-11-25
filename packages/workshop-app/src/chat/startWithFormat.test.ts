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

  it('names a template in a sentence, and says where in it its title is', () => {
    const { text, formats } = startWithFormat({ noun: 'Tip Jar', icon: 'appWindow', template: true }, 'in our colours')
    expect(text).toBe('Use the Tip Jar template. in our colours')
    expect(text.slice(formats[0].position, formats[0].position + formats[0].length)).toBe('Tip Jar')
    expect(startWithFormat({ noun: 'Tip Jar', icon: 'appWindow', template: true }, '').text).toBe('Use the Tip Jar template.')
  })
})
