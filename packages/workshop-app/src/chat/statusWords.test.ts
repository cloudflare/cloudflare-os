import { describe, expect, it } from 'vitest'
import { toolStatus } from './statusWords'

describe('toolStatus', () => {
  it('names what is being made when a gadget is created', () => {
    expect(toolStatus('createGadget', 'Document')).toBe('Creating your document')
    expect(toolStatus('createGadget')).toBe('Creating your app')
  })

  it('says nothing technical for a call it has no words for', () => {
    expect(toolStatus(undefined)).toBe('Working on it')
    expect(toolStatus('aToolNewerThanThisBuild' as never)).toBe('Working on it')
  })

  it('never shows a file, as the work log does', () => {
    for (const name of ['readFile', 'writeFile', 'editFile', 'grep'] as const) expect(toolStatus(name)).not.toMatch(/file|\.\w+$/i)
  })
})
