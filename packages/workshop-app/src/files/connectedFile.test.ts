import { describe, expect, it } from 'vitest'
import { connectedFileIdOfUrl, connectedFileKind, connectedKindOfUrl } from './connectedFile'

describe('connectedFile', () => {
  it('tells a Google file by its media type, and nothing else', () => {
    expect(connectedFileKind('application/vnd.google-apps.spreadsheet')).toBe('spreadsheet')
    expect(connectedFileKind('application/pdf')).toBeUndefined()
    expect(connectedFileKind(undefined)).toBeUndefined()
  })

  it('tells one by its editor’s address, and reads its id from it', () => {
    const url = 'https://docs.google.com/presentation/d/1AbC-d_9/edit#slide=id.p'
    expect(connectedKindOfUrl(url)).toBe('presentation')
    expect(connectedFileIdOfUrl(url)).toBe('1AbC-d_9')
    expect(connectedKindOfUrl('https://example.com/document/d/1')).toBeUndefined()
  })
})
