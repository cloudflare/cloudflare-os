import type { BlueprintPublicInfo } from '@gadgets/workshop-shared/api'

/** One blueprint that a gadget can be updated from. */
export type BlueprintChoice = {
  id: string
  title: string
  description: string
  /** The blueprint's version counter (`BlueprintMetadata.version`). */
  version: number
}

/** What to call a blueprint, which may have been published with no title. */
export const titleOf = (title: string) => title || 'Untitled blueprint'

export const toBlueprintChoice = ({ id, metadata }: BlueprintPublicInfo): BlueprintChoice => ({
  id,
  title: titleOf(metadata.title),
  description: metadata.description,
  version: metadata.version,
})
