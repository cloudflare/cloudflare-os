import { describe, expect, it } from 'vitest'
import { parseBlueprintReference } from './blueprintReference'

const ID = '0123456789abcdef0123456789abcdef'

describe('parseBlueprintReference', () => {
  it('reads the id out of a copied blueprint link', () => {
    expect(parseBlueprintReference(`https://gadgets.example/blueprint/${ID}`)).toBe(ID)
  })

  it('tolerates what a pasted link picks up around the id', () => {
    expect(parseBlueprintReference(`  https://gadgets.example/blueprint/${ID}/?ref=chat#top \n`)).toBe(ID)
  })

  it('takes a bare id as it is', () => {
    expect(parseBlueprintReference(` ${ID}\n`)).toBe(ID)
  })

  // A bundled blueprint's id is a name rather than random hex.
  it('reads an id that is not hex', () => {
    expect(parseBlueprintReference('http://localhost:8787/blueprint/format.document'))
      .toBe('format.document')
    expect(parseBlueprintReference('format.document')).toBe('format.document')
  })

  it('rejects a link to something other than a blueprint', () => {
    expect(parseBlueprintReference(`https://gadgets.example/workspace/${ID}`)).toBeNull()
    expect(parseBlueprintReference(`https://gadgets.example/blueprint/${ID}/edit`)).toBeNull()
    expect(parseBlueprintReference('https://gadgets.example/blueprint/')).toBeNull()
    expect(parseBlueprintReference(`javascript:/blueprint/${ID}`)).toBeNull()
  })

  it('rejects text that is neither an id nor a link', () => {
    expect(parseBlueprintReference('')).toBeNull()
    expect(parseBlueprintReference('my blueprint')).toBeNull()
    expect(parseBlueprintReference(`blueprint/${ID}`)).toBeNull()
  })

  // They name the blueprint namespace's reserved keys, never a blueprint.
  it('rejects an id with a leading dot', () => {
    expect(parseBlueprintReference('.featured')).toBeNull()
  })

  it('rejects an id that is not validly encoded', () => {
    expect(parseBlueprintReference('https://gadgets.example/blueprint/%E0%A4%A')).toBeNull()
  })
})
