import type { CollaboratorRole, OutputSummary } from '@gadgets/workshop-shared/api'
import type { AsideItem } from '@/aside/asideItems'
import { titleAfter, type Renamed } from '@/gadgets/gadgetChanges'
import { outputKey } from './libraryList'

/**
 * Whether the viewer may change an output (rename it, delete it, open its settings, share it):
 * whoever builds in its workspace, as its owner does, and not whoever it was shared with to use.
 * Its workspace as the user's list has it says, where it is listed (`listed`, whose role is absent
 * for the user's own); otherwise the role the library has kept for it, which a workspace shared
 * with them must say, as one kept before roles were may well be "use". The server checks again.
 */
export const mayChange = (output: OutputSummary, listed?: { role?: CollaboratorRole }) => {
  if (listed) return listed.role !== 'use'
  return output.owner === undefined || output.role === 'build'
}

/**
 * What the user has done to the library from the Library page, shown at once, before it is read
 * again: the titles they gave outputs, and those they deleted, by `outputKey`.
 */
export type LibraryEdits = { renamed: ReadonlyMap<string, Renamed>; deleted: ReadonlySet<string> }

export const NO_EDITS: LibraryEdits = { renamed: new Map(), deleted: new Set() }

/** `edits`, with `output` given the title `title`, over the one it is read as. */
export const withRename = (edits: LibraryEdits, output: OutputSummary, title: string): LibraryEdits => ({
  ...edits,
  renamed: new Map(edits.renamed).set(outputKey(output), { from: output.title, to: title }),
})

/** `edits`, without the rename of `output`, as when it was refused. */
export const withoutRename = (edits: LibraryEdits, output: OutputSummary): LibraryEdits => {
  const renamed = new Map(edits.renamed)
  renamed.delete(outputKey(output))
  return { ...edits, renamed }
}

/** `edits`, with `output` deleted. */
export const withDeletion = (edits: LibraryEdits, output: OutputSummary): LibraryEdits => ({
  ...edits,
  deleted: new Set(edits.deleted).add(outputKey(output)),
})

/**
 * The library as read, after `edits`: the deleted left out, and each renamed under its new title
 * while it is still read as the old one (`titleAfter`). What is unchanged is the same object, so
 * that what it is kept by does not change.
 */
export const withEdits = (outputs: OutputSummary[], edits: LibraryEdits): OutputSummary[] =>
  outputs.flatMap((output) => {
    const key = outputKey(output)
    if (edits.deleted.has(key)) return []
    const title = titleAfter(output.title, edits.renamed.get(key))
    return title === output.title ? [output] : [{ ...output, title }]
  })

/**
 * What a list of a workspace's items shows, after `edits`, as `withEdits` does for outputs: the
 * deleted outputs left out, and each renamed under its new title while it is still read as the
 * old one, which an untitled one is listed as "Untitled". Files are as they were.
 */
export const withItemEdits = (items: AsideItem[], edits: LibraryEdits): AsideItem[] =>
  items.flatMap((item): AsideItem[] => {
    if (item.kind !== 'output') return [item]
    const key = `${item.output.workspaceId}/${item.output.workpieceId}`
    if (edits.deleted.has(key)) return []
    const renamed = edits.renamed.get(key)
    return renamed && (renamed.from || 'Untitled') === item.title ? [{ ...item, title: renamed.to }] : [item]
  })
