import type { ActionLogEntry, AiChatMessage, WorkpieceId } from '@gadgets/workshop-shared/api'

/** An action the agent made that waits, as a draft, for someone to apply or discard it. */
export type Draft = Extract<ActionLogEntry, { type: 'action' }>

/** What a file icon is drawn as. */
export type DraftKind = 'document' | 'spreadsheet' | 'presentation' | 'email' | 'other'

/** Every draft waiting on one thing: a Google file, a mailbox, a repository. */
export type DraftGroup = {
  key: string
  gatekeeperId: WorkpieceId
  /** The item within the connection, for a connection that holds several (see ResourceSubject). */
  subjectId?: string
  title: string
  url?: string
  kind: DraftKind
  /** Oldest first, the order they apply in. */
  drafts: Draft[]
  /** Some draft holds the agent until it is decided (see ActionDescription.awaitDecision). */
  holdsAgent: boolean
}

const MEDIA_KINDS: Record<string, DraftKind> = {
  'application/vnd.google-apps.document': 'document',
  'application/vnd.google-apps.spreadsheet': 'spreadsheet',
  'application/vnd.google-apps.presentation': 'presentation',
}

/** What a file of provider media type `mediaType` is, if one drawn as itself. */
export const mediaKind = (mediaType: string): DraftKind | undefined => MEDIA_KINDS[mediaType]

/** What an item is, from its address or the pattern of addresses of its type. */
export const kindOfUrl = (url: string): DraftKind => {
  if (/docs\.google\.com\/document\//.test(url)) return 'document'
  if (/docs\.google\.com\/spreadsheets\//.test(url)) return 'spreadsheet'
  if (/docs\.google\.com\/presentation\//.test(url)) return 'presentation'
  if (/mail\.google\.com|outlook\.|^mailto:/.test(url)) return 'email'
  return 'other'
}

/** What a draft's item is, from its subject's media type, or its connection's address. */
export const draftKind = (draft: Draft): DraftKind => {
  const mediaType = draft.description.subject?.mediaType
  if (mediaType && MEDIA_KINDS[mediaType]) return MEDIA_KINDS[mediaType]
  return kindOfUrl(draft.resourceUrl ?? '')
}

/** Whether a kind is drawn as the file it is, rather than listed (see Overseer.previewResource). */
export const drawsPreview = (kind: DraftKind) =>
  kind === 'document' || kind === 'spreadsheet' || kind === 'presentation'

const isPendingDraft = (log: ActionLogEntry | undefined): log is Draft =>
  log?.type === 'action' && log.state === 'pending' && log.gatekeeperId !== undefined

/**
 * Waiting drafts grouped by the item they change, the group changed first leading. `source`
 * keeps one place's groups apart from another's (a chat's from a gadget's) where both change
 * the same item.
 */
export const groupDrafts = (entries: Iterable<ActionLogEntry | undefined>, source: string): DraftGroup[] => {
  const groups = new Map<string, DraftGroup>()
  for (const draft of entries) {
    if (!isPendingDraft(draft)) continue
    const subject = draft.description.subject
    const key = `${source}:${draft.gatekeeperId}:${subject?.id ?? ''}`
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        gatekeeperId: draft.gatekeeperId!,
        ...(subject ? { subjectId: subject.id } : {}),
        title: subject?.title ?? draft.resourceTitle,
        url: subject?.url ?? draft.resourceUrl,
        kind: draftKind(draft),
        drafts: [],
        holdsAgent: false,
      }
      groups.set(key, group)
    }
    if (!group.drafts.some(existing => existing.id === draft.id)) group.drafts.push(draft)
    group.holdsAgent ||= draft.description.awaitDecision === true
  }
  for (const group of groups.values()) group.drafts = group.drafts.toSorted((a, b) => a.id - b.id)
  return [...groups.values()].toSorted((a, b) => a.drafts[0].id - b.drafts[0].id)
}

/** A chat's waiting drafts, by the item they change (see groupDrafts). */
export const draftGroups = (messages: readonly AiChatMessage[]): DraftGroup[] =>
  groupDrafts(messages.map(message => message.type === 'action' ? message.actionLog : undefined), 'chat')

/** The drafts gadget `gadgetId`'s own code made, by the item they change (see groupDrafts). */
export const gadgetDraftGroups = (pending: readonly ActionLogEntry[], gadgetId: WorkpieceId): DraftGroup[] =>
  groupDrafts(pending.filter(entry => entry.type === 'action' && entry.gadgetId === gadgetId), `gadget${gadgetId}`)

/** How long a draft that Auto applies stays out of view while it applies, before it shows as waiting. */
export const AUTO_APPLY_GRACE_MS = 8_000

/**
 * The drafts of `groups` that a chat on Auto is applying as of `now`, which need no one: those
 * its connection marks auto-approvable, made in the last few seconds, up to the first draft of
 * their file that needs a person, since the connection's drafts apply in order and stop there.
 * One that has not applied by then is shown after all.
 */
export const autoApplying = (groups: readonly DraftGroup[], now: number): Set<number> => {
  const ids = new Set<number>()
  for (const group of groups) {
    for (const draft of group.drafts) {
      if (draft.description.autoApprovable !== true || draft.creation) break
      if (now - draft.createdAt.getTime() < AUTO_APPLY_GRACE_MS) ids.add(draft.id)
    }
  }
  return ids
}

/** The link that opens a kind of item with its provider. */
export const OPEN_LABEL: Record<DraftKind, string> = {
  document: 'Open in Docs', spreadsheet: 'Open in Sheets', presentation: 'Open in Slides',
  email: 'Open', other: 'Open',
}

/** "1 change", "7 changes". */
export const changeCount = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`

/** The drafts of `groups`, in the order they apply. */
export const allDrafts = (groups: readonly DraftGroup[]): Draft[] =>
  groups.flatMap(group => group.drafts).toSorted((a, b) => a.id - b.id)
