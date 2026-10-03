import type {
  BlueprintLibrarySummary,
  BlueprintMetadata,
  BlueprintPublicInfo,
  BlueprintUserSummary,
} from '@gadgets/workshop-shared/api'

/** One blueprint that a gadget can be updated from. */
export type BlueprintChoice = {
  id: string
  title: string
  description: string
  /** The blueprint's version counter (`BlueprintMetadata.version`). */
  version: number
}

/** Where the picker knows a blueprint from, which is what it groups its choices by. */
export type BlueprintChoiceSource = 'followed' | 'linked' | 'yours' | 'featured'

export type BlueprintChoiceGroup = {
  source: BlueprintChoiceSource
  choices: BlueprintChoice[]
}

/** Everything the picker offers, as loaded. */
export type BlueprintChoiceSources = {
  /** The blueprint the gadget follows, or null if it follows none or the blueprint is gone. */
  followed: BlueprintPublicInfo | null
  /** The blueprint named by a link the user pasted, if there is one. */
  linked: BlueprintPublicInfo | null
  own: BlueprintUserSummary[]
  library: BlueprintLibrarySummary[]
  featured: BlueprintPublicInfo[]
}

const titleOf = (title: string) => title || 'Untitled blueprint'

const fromMetadata = ({ id, metadata }: { id: string; metadata: BlueprintMetadata }): BlueprintChoice => ({
  id,
  title: titleOf(metadata.title),
  description: metadata.description,
  version: metadata.version,
})

/**
 * Arranges the blueprints a gadget can be updated from into the picker's groups, in the order it
 * shows them. A blueprint known from several sources is listed once, under the first of them: a
 * pasted link to the blueprint the gadget already follows adds no second row. Groups with nothing
 * left are dropped.
 */
export const groupBlueprintChoices = (sources: BlueprintChoiceSources): BlueprintChoiceGroup[] => {
  const yours = [
    ...sources.own.map(({ id, title, description, version }) => (
      { id, title: titleOf(title), description, version }
    )),
    ...sources.library.map(fromMetadata),
  ].toSorted((a, b) => a.title.localeCompare(b.title))

  const bySource: [BlueprintChoiceSource, BlueprintChoice[]][] = [
    ['followed', sources.followed ? [fromMetadata(sources.followed)] : []],
    ['linked', sources.linked ? [fromMetadata(sources.linked)] : []],
    ['yours', yours],
    ['featured', sources.featured.map(fromMetadata)],
  ]

  const listed = new Set<string>()
  return bySource
    .map(([source, choices]) => ({
      source,
      choices: choices.filter(choice => {
        if (listed.has(choice.id)) return false
        listed.add(choice.id)
        return true
      }),
    }))
    .filter(group => group.choices.length > 0)
}
