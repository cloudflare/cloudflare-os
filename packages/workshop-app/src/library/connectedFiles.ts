import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { connectedFileIdOfUrl, connectedFileKind, connectedKindOfUrl, type ConnectedFileKind } from '@/files/connectedFile'

/** A file of a connected service that a workspace worked on, such as a Google Doc, as the Library lists it. */
export type ConnectedFile = {
  workspaceId: string
  /** The connection it is reached through, which draws it. */
  gatekeeperId: number
  /** The service's id for it (`ResourceSubject.id`). */
  subjectId: string
  title: string
  url: string
  kind: ConnectedFileKind
  /** When it was last read, changed or made. */
  at: Date
  /** The chat it was last worked on in, when it was one. */
  chatId?: number
}

/**
 * The files a workspace's action log says it read, changed or made, latest first, each once: those
 * an entry names as a file of a type a service says it is (`ResourceSubject.mediaType`), which a
 * service says only of what is a file (a document, not an issue), and those a creation made once
 * they were made. A creation never approved made nothing, so is not one.
 */
export const connectedFiles = (entries: readonly ActionLogEntry[], workspaceId: string): ConnectedFile[] => {
  const files = new Map<string, ConnectedFile>()
  const add = (file: Omit<ConnectedFile, 'workspaceId'>) => {
    const known = files.get(file.subjectId)
    if (!known || known.at < file.at) files.set(file.subjectId, { ...file, workspaceId })
  }
  for (const entry of entries) {
    if (entry.type === 'bindHook' || entry.gatekeeperId === undefined) continue
    if (entry.type === 'action' && entry.creation && entry.state !== 'approved') continue
    const at = new Date(entry.appliedAt ?? entry.createdAt)
    const chatId = entry.type === 'action' ? entry.chatId : undefined
    const { subject } = entry.description
    const kind = connectedFileKind(subject?.mediaType)
    if (subject && kind) {
      add({ gatekeeperId: entry.gatekeeperId, subjectId: subject.id, title: subject.title, url: subject.url, kind, at, chatId })
      continue
    }
    if (entry.type !== 'action' || !entry.creation || !entry.resourceUrl) continue
    const made = connectedKindOfUrl(entry.resourceUrl)
    const id = connectedFileIdOfUrl(entry.resourceUrl)
    if (made && id) {
      add({ gatekeeperId: entry.gatekeeperId, subjectId: id, title: entry.resourceTitle, url: entry.resourceUrl, kind: made, at, chatId })
    }
  }
  return [...files.values()].toSorted((a, b) => b.at.getTime() - a.at.getTime())
}
