import { describe, expect, it } from 'vitest'
import { parseBlueprintLink } from './blueprintLink'

const ID = '0123456789abcdef0123456789abcdef'

describe('parseBlueprintLink', () => {
  it('reads the id out of a copied blueprint link', () => {
    expect(parseBlueprintLink(`https://gadgets.example/blueprint/${ID}`)).toBe(ID)
  })

  it('tolerates what a pasted link picks up around the id', () => {
    expect(parseBlueprintLink(`  https://gadgets.example/blueprint/${ID}/?ref=chat#top \n`)).toBe(ID)
  })

  // A bundled blueprint's id is a name rather than random hex.
  it('reads an id that is not hex', () => {
    expect(parseBlueprintLink('http://localhost:8787/blueprint/format.document'))
      .toBe('format.document')
  })

  it('rejects a link to something other than a blueprint', () => {
    expect(parseBlueprintLink(`https://gadgets.example/workspace/${ID}`)).toBeNull()
    expect(parseBlueprintLink(`https://gadgets.example/blueprint/${ID}/edit`)).toBeNull()
    expect(parseBlueprintLink('https://gadgets.example/blueprint/')).toBeNull()
  })

  it('rejects text that is not a link', () => {
    expect(parseBlueprintLink('')).toBeNull()
    expect(parseBlueprintLink(ID)).toBeNull()
    expect(parseBlueprintLink('my blueprint')).toBeNull()
  })

  it('rejects an id that is not validly encoded', () => {
    expect(parseBlueprintLink('https://gadgets.example/blueprint/%E0%A4%A')).toBeNull()
  })
})
