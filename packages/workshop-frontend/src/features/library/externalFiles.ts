import type { ActionLogEntry, WorkpieceId } from '@gadgets/workshop-shared/api'
import { kindOfUrl, mediaKind, type DraftKind } from '../drafts/drafts'

/** A file in a connected service, such as a Google Doc, as the Library lists it. */
export type ExternalFileSource = {
  workspaceId: string
  workspaceTitle?: string
  /** The connection it is reached through, which draws it. */
  gatekeeperId: WorkpieceId
  /** The provider's ID for it (see ResourceSubject.id). */
  subjectId: string
  title: string
  url: string
  kind: DraftKind
  mediaType: string
  /** When an entry last touched it. */
  date: Date
}

const MEDIA_TYPES: Partial<Record<DraftKind, string>> = {
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
}

// A Google editor link's file ID: /document/d/<id>/edit and the like.
const fileIdOf = (url: string) => /\/d\/([^/?#]+)/.exec(url)?.[1]

/**
 * The files `entries` read, changed or created, newest first, each once: those an entry names as
 * a file of a type (see ResourceSubject.mediaType), which a service names only for what is a file
 * -- a document, not an issue -- and those a creation made, once they exist.
 */
export function externalFiles(
  entries: readonly ActionLogEntry[], workspace: { id: string; title?: string },
): ExternalFileSource[] {
  const files = new Map<string, ExternalFileSource>()
  const add = (file: Omit<ExternalFileSource, 'workspaceId' | 'workspaceTitle'>) => {
    const known = files.get(file.subjectId)
    if (known && known.date >= file.date) return
    files.set(file.subjectId, {
      ...file, workspaceId: workspace.id, ...(workspace.title ? { workspaceTitle: workspace.title } : {}),
    })
  }
  for (const entry of entries) {
    if (entry.type === 'bindHook' || entry.gatekeeperId === undefined) continue
    const date = new Date(entry.appliedAt ?? entry.createdAt)
    // A file not made yet, or never made, isn't anywhere to list.
    if (entry.type === 'action' && entry.creation && entry.state !== 'approved') continue
    const subject = entry.description.subject
    const subjectKind = subject?.mediaType && mediaKind(subject.mediaType)
    if (subject?.mediaType && subjectKind) {
      add({ gatekeeperId: entry.gatekeeperId, subjectId: subject.id, title: subject.title, url: subject.url,
        kind: subjectKind, mediaType: subject.mediaType, date })
      continue
    }
    if (entry.type !== 'action' || !entry.creation || !entry.resourceUrl) continue
    const kind = kindOfUrl(entry.resourceUrl)
    const id = fileIdOf(entry.resourceUrl)
    const mediaType = MEDIA_TYPES[kind]
    if (id && mediaType) {
      add({ gatekeeperId: entry.gatekeeperId, subjectId: id, title: entry.resourceTitle, url: entry.resourceUrl,
        kind, mediaType, date })
    }
  }
  return [...files.values()].toSorted((a, b) => b.date.getTime() - a.date.getTime())
}
