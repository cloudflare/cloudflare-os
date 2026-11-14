import type { BlueprintLibrarySummary, BlueprintMetadata, BlueprintOutput, BlueprintPublicInfo, BlueprintSource, BlueprintUserSummary } from '@gadgets/workshop-shared/api'
import { blueprintScreenshotUrl } from '@gadgets/workshop-shared/api'

/** A blueprint as the Library lists it, from wherever the user has it. */
export type BlueprintEntry = {
  id: string
  title: string
  description: string
  /** Who published it. */
  author: string
  /** Its picture, when it was published with one. */
  picture?: string
  /** What a gadget made from it is, such as a Document; absent for an app. */
  output?: BlueprintOutput
  /** How many things it needs set up to be used. */
  needs: number
  lastUpdated: Date
  /** The deployment features it. */
  featured: boolean
  /** The user published it, from the workspace given where that is still there. */
  published?: Exclude<BlueprintSource, { type: 'imported' }>
  /** The user saved it to their Library (`addBlueprintToLibrary`), or uploaded it there (`uploaded`). */
  saved?: { uploaded: boolean }
}

/** One of the Blueprints tab's groups. */
export type BlueprintGroup = { key: 'featured' | 'yours'; label: string; entries: BlueprintEntry[] }

/** What the Blueprints tab lists, read from the account. */
export type BlueprintSources = {
  featured: readonly BlueprintPublicInfo[]
  library: readonly BlueprintLibrarySummary[]
  /** What the user published, each with its public record where it could be read, for its picture. */
  own: readonly { summary: BlueprintUserSummary; info?: BlueprintPublicInfo | null }[]
}

const fromMetadata = (id: string, metadata: BlueprintMetadata, picture: string | undefined) => ({
  id,
  title: metadata.title || 'Untitled blueprint',
  description: metadata.description,
  author: metadata.author.name,
  picture,
  output: metadata.output,
  needs: Object.keys(metadata.bindings).length,
  lastUpdated: metadata.lastUpdated,
})

/**
 * Every blueprint the user can find in their Library, once each however many ways they have it:
 * those the deployment features, those they saved or uploaded, and those they published.
 */
export const blueprintEntries = ({ featured, library, own }: BlueprintSources): BlueprintEntry[] => {
  const byId = new Map<string, BlueprintEntry>()
  const put = (id: string, make: () => Omit<BlueprintEntry, 'featured'>, extra: Partial<BlueprintEntry>) => {
    const found = byId.get(id)
    byId.set(id, { ...(found ?? { ...make(), featured: false }), ...extra })
  }
  for (const { id, metadata, screenshotUrl } of featured) put(id, () => fromMetadata(id, metadata, screenshotUrl), { featured: true })
  for (const { id, metadata, uploaded } of library) {
    put(id, () => fromMetadata(id, metadata, blueprintScreenshotUrl(id, metadata)), { saved: { uploaded } })
  }
  // One the user added rather than published is in their library, and listed from there.
  for (const { summary, info } of own.filter(({ summary: { source } }) => source.type !== 'imported')) {
    put(
      summary.id,
      () => info
        ? fromMetadata(summary.id, info.metadata, info.screenshotUrl)
        : { id: summary.id, title: summary.title || 'Untitled blueprint', description: summary.description, author: 'You', needs: 0, lastUpdated: summary.lastUpdated },
      { published: summary.source as Exclude<BlueprintSource, { type: 'imported' }> },
    )
  }
  return [...byId.values()]
}

const matches = (entry: BlueprintEntry, words: string[]) => {
  const text = `${entry.title} ${entry.description} ${entry.author}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

/**
 * The Blueprints tab's groups: those the deployment features, then the user's own, published or
 * saved, not already among them; in the Library's order and found by the words typed. A group with
 * nothing in it is left out.
 */
export const blueprintGroups = (entries: readonly BlueprintEntry[], { sort, query }: { sort: 'recent' | 'name'; query: string }): BlueprintGroup[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const order = (a: BlueprintEntry, b: BlueprintEntry) =>
    sort === 'name' ? a.title.localeCompare(b.title) : b.lastUpdated.getTime() - a.lastUpdated.getTime() || a.title.localeCompare(b.title)
  const found = entries.filter((entry) => matches(entry, words)).toSorted(order)
  const groups: BlueprintGroup[] = [
    { key: 'featured', label: 'Featured', entries: found.filter(({ featured }) => featured) },
    { key: 'yours', label: 'Yours', entries: found.filter(({ featured, published, saved }) => !featured && (published || saved)) },
  ]
  return groups.filter(({ entries: listed }) => listed.length > 0)
}

/** What a blueprint's tile and page say of it under its name: who made it, and what it needs. */
export const blueprintDetail = ({ author, published, needs }: Pick<BlueprintEntry, 'author' | 'published' | 'needs'>) =>
  [published ? 'By you' : `By ${author}`, needs === 0 ? 'Ready to use' : needs === 1 ? 'Needs 1 thing' : `Needs ${needs} things`].join(' · ')
