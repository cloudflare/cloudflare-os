import { MAX_FILE_PATH_LENGTH, type CodeChange as SharedCodeChange } from '@gadgets/workshop-shared/code-change'
import { codeFileAt, orderCodeFiles, type CodeFile } from './gadgetCode'

/** What a file of a draft was before it was touched: its text, nothing there, or there with no text to edit. */
export type DraftBefore = { kind: 'text'; text: string } | { kind: 'absent' } | { kind: 'other' }

/** One file a draft touches: what it was, and its text now, or null where it is deleted. */
export type DraftFile = { before: DraftBefore; after: string | null }

/**
 * Edits to a gadget's code on this device, not saved yet: the commit they were started from (its
 * base), and each file they touch. A draft always changes something: one with nothing left in it is
 * no draft (`undefined`).
 */
export type CodeDraft = {
  /** Tells one draft from the next, as for keeping each file's undo history only while it lasts. */
  id: number
  base: string
  files: ReadonlyMap<string, DraftFile>
}

/** How a draft changes a file, as the tree marks it. */
export type DraftEdit = 'added' | 'changed' | 'deleted'

/** A file as listed while there is a draft: as its head has it, and how the draft changes it. */
export type DraftedFile = CodeFile & { edit?: DraftEdit }

let drafts = 0

const unchanged = ({ before, after }: DraftFile) =>
  before.kind === 'text' ? after === before.text : before.kind === 'absent' && after === null

/** How the draft changes a file it touches. */
export const editOf = ({ before, after }: DraftFile): DraftEdit =>
  before.kind === 'absent' ? 'added' : after === null ? 'deleted' : 'changed'

/**
 * The draft with `path` as `after` (null to delete it), where it was `before` when the draft first
 * touched it: what the draft already has it as was is kept. A file put back as it was leaves the
 * draft, and a draft left with nothing in it goes. Without a draft, one is started from `base`.
 */
export const withFile = (draft: CodeDraft | undefined, base: string, path: string, before: DraftBefore, after: string | null): CodeDraft | undefined => {
  const entry: DraftFile = { before: draft?.files.get(path)?.before ?? before, after }
  const files = new Map(draft?.files)
  if (unchanged(entry)) files.delete(path)
  else files.set(path, entry)
  if (files.size === 0) return undefined
  return { id: draft?.id ?? ++drafts, base: draft?.base ?? base, files }
}

/** The draft with `path` put back as it was. */
export const restoreFile = (draft: CodeDraft | undefined, path: string): CodeDraft | undefined => {
  if (!draft?.files.has(path)) return draft
  const files = new Map(draft.files)
  files.delete(path)
  return files.size === 0 ? undefined : { ...draft, files }
}

/** How many files the draft changes. */
export const changeCount = (draft: CodeDraft | undefined) => draft?.files.size ?? 0

/** How the draft changes each file it touches, by path: all that listing the files needs of it. */
export const draftEdits = (draft: CodeDraft | undefined): ReadonlyMap<string, DraftEdit> =>
  new Map(draft ? [...draft.files].map(([path, entry]) => [path, editOf(entry)]) : [])

/**
 * The files as listed with the draft over them: the head's, each marked as the draft changes it,
 * with those it deletes still there until it is saved, and those it adds among them, in the order
 * the Code tab lists files.
 */
export const listDraft = (files: readonly CodeFile[], edits: ReadonlyMap<string, DraftEdit>): DraftedFile[] => {
  if (edits.size === 0) return [...files]
  const listed = new Set(files.map(({ path }) => path))
  const marked = files.map((file): DraftedFile => {
    const edit = edits.get(file.path)
    return edit ? { ...file, edit } : file
  })
  const added = [...edits]
    .filter(([path, edit]) => !listed.has(path) && edit !== 'deleted')
    .map(([path, edit]): DraftedFile => ({ ...codeFileAt(path), edit }))
  return added.length ? orderCodeFiles([...marked, ...added]) : marked
}

/** The paths that are there with the draft over them: none it deletes. */
export const livePaths = (files: readonly DraftedFile[]) => new Set(files.filter(({ edit }) => edit !== 'deleted').map(({ path }) => path))

const folderOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1)
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/**
 * Where a name typed for a file goes: relative to the folder it is typed in, so that a bare name
 * stays there and `sub/name` goes down into `sub`; `..` goes up a folder, and a leading `/` starts
 * from the top. Nothing for a name that ends in an empty folder or climbs above the top. Ported from
 * the old Workshop's `workpieceTree.ts`.
 */
export const resolveRenamePath = (path: string, name: string): string | null => {
  const raw = name.startsWith('/') ? name.slice(1) : folderOf(path) + name
  const out: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '') return null
    if (segment === '.') continue
    if (segment === '..') {
      if (out.length === 0) return null
      out.pop()
    } else {
      out.push(segment)
    }
  }
  return out.length > 0 ? out.join('/') : null
}

/** What a name typed for a file comes to: where it goes, why it can't, or nothing typed (or nothing changed). */
export type NameCheck = { path: string } | { problem: string } | { none: true }

// A control character: below a space, or delete.
const control = (typed: string) => [...typed].some((character) => character < ' ' || character === '\u007f')
const LENGTH = new Intl.NumberFormat('en').format(MAX_FILE_PATH_LENGTH)

/**
 * What `typed` comes to as the name of a new file in `at.folder` ('' for the top), or of the file
 * `at.renaming`, among the files there are (`live`, as `livePaths` gives them). A name differing
 * only in case is another name, as git takes it.
 */
export const checkName = (live: ReadonlySet<string>, typed: string, at: { folder: string } | { renaming: string }): NameCheck => {
  if (typed.trim() === '') return { none: true }
  if (control(typed)) return { problem: 'A name can’t have control characters in it' }
  if (typed.endsWith('/')) return { problem: 'A name can’t end with /' }
  const from = 'renaming' in at ? at.renaming : `${at.folder ? `${at.folder}/` : ''}_`
  const path = resolveRenamePath(from, typed)
  if (path === null) return { problem: typed.includes('//') ? 'A name can’t have // in it' : 'That’s above the top folder' }
  if (path.length > MAX_FILE_PATH_LENGTH) return { problem: `A name can’t be over ${LENGTH} characters` }
  if ('renaming' in at && path === at.renaming) return { none: true }
  const name = nameOf(path)
  const where = folderOf(path) === folderOf(from) ? 'here' : `in ${folderOf(path).slice(0, -1) || 'the top folder'}`
  if (live.has(path)) return { problem: `There’s already a ${name} ${where}.` }
  const inside = `${path}/`
  if ([...live].some((each) => each.startsWith(inside) && each !== ('renaming' in at ? at.renaming : undefined))) {
    return { problem: `There’s already a folder called ${name} ${where}.` }
  }
  const parts = path.split('/')
  for (let depth = 1; depth < parts.length; depth++) {
    const folder = parts.slice(0, depth).join('/')
    if (live.has(folder)) return { problem: `${nameOf(folder)} is a file, so nothing can go in it.` }
  }
  return { path }
}

/** The name a copy of `path` is made with, beside it: "styles copy.css", then "styles copy 2.css". */
export const copyName = (live: ReadonlySet<string>, path: string) => {
  const folder = folderOf(path)
  const name = nameOf(path)
  const dot = name.lastIndexOf('.')
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let count = 1; ; count++) {
    const made = `${folder}${stem} copy${count > 1 ? ` ${count}` : ''}${extension}`
    if (!live.has(made)) return made
  }
}

/** Whether the gadget starts from the file: its screen or server side, at the top. */
export const startsFrom = (path: string) => /^(client|server)\.[^/]+$/i.test(path)

/** What can be done to a file from its menu, and what is said of it. */
export type FileOffers = {
  rename: boolean
  duplicate: boolean
  /** True, or why it can't be. */
  delete: true | string
  restore: boolean
  /** A word of caution for renaming or deleting it. */
  caution?: string
}

/**
 * What can be done to a listed file. A file whose mode a change can't carry (an executable, a link,
 * another project) is not renamed, as it would come out a plain file, and one with no text is only
 * deleted. The last file there is is not deleted: a gadget needs at least one. A deleted file is
 * only brought back, which `deleted` says.
 */
export const fileOffers = (file: DraftedFile, files: readonly DraftedFile[], gadget: string, readable: boolean, deleted = 'It’s deleted until you save.'): FileOffers => {
  const restore = file.edit !== undefined
  if (file.edit === 'deleted') return { rename: false, duplicate: false, delete: deleted, restore }
  const plain = file.kind === 'file'
  const others = files.some((each) => each.path !== file.path && each.edit !== 'deleted')
  return {
    rename: plain && readable,
    duplicate: readable && (plain || file.kind === 'executable'),
    delete: others ? true : 'A gadget needs at least one file.',
    restore,
    caution: startsFrom(file.path) ? `${gadget} stops working without this file.` : undefined,
  }
}

/** The draft as one change to the gadget `gadgetId`: each file it touches set whole, or removed. */
export const toChange = (draft: CodeDraft, gadgetId: number): SharedCodeChange => ({
  [gadgetId]: [...draft.files].map(([path, { after }]) => (after === null ? [path, { remove: true }] : [path, { set: after }])),
})

/**
 * The draft moved onto `head`, where what it touches is as `atHead` says. Each file's `before`
 * becomes what it is there, so that what is saved is the draft's text over whatever is there now,
 * and a file the draft has as it already is there leaves it.
 */
export const rebase = (draft: CodeDraft, head: string, atHead: ReadonlyMap<string, DraftBefore>): CodeDraft | undefined => {
  const files = new Map<string, DraftFile>()
  for (const [path, { before, after }] of draft.files) {
    const entry = { before: atHead.get(path) ?? before, after }
    if (!unchanged(entry)) files.set(path, entry)
  }
  return files.size === 0 ? undefined : { ...draft, base: head, files }
}

const sameBefore = (a: DraftBefore, b: DraftBefore) => a.kind === b.kind && (a.kind !== 'text' || a.text === (b as { text: string }).text)

/**
 * The files the draft touches that someone changed since it touched them: those `atHead` has as
 * other than they were before the draft, and other than the draft has them. Each file's own
 * `before` is what is compared, rather than the draft's base, as a file touched after the head
 * moved was touched as the newer head had it.
 */
export const conflictsWith = (draft: CodeDraft, atHead: ReadonlyMap<string, DraftBefore>) =>
  [...draft.files].filter(([path, { before, after }]) => {
    const now = atHead.get(path)
    return now !== undefined && !sameBefore(before, now) && !unchanged({ before: now, after })
  }).map(([path]) => path)

/** What was done, as the chat a save of it makes on a gadget's own page says: "Edited client.ts and styles.css". */
export const editedLine = (draft: CodeDraft) => {
  const names = [...draft.files.keys()].map(nameOf)
  const MOST = 3
  const shown = names.length > MOST + 1 ? [...names.slice(0, MOST), `${names.length - MOST} other files`] : names
  return `Edited ${new Intl.ListFormat('en', { type: 'conjunction' }).format(shown)}`
}

/**
 * The drafts of every gadget, by `draftKey`, for as long as the app is open: flipping back to a
 * gadget, going to another page or opening it elsewhere finds its draft as it was. Observable per
 * draft (`subscribe`/`get`, for `useSyncExternalStore`).
 */
export class CodeDrafts {
  #drafts = new Map<string, CodeDraft>()
  #listeners = new Set<() => void>()

  /** `onAny` is told whenever there comes to be a draft, or none. */
  constructor(private readonly onAny?: (any: boolean) => void) {}

  get = (key: string): CodeDraft | undefined => this.#drafts.get(key)

  set = (key: string, draft: CodeDraft | undefined) => {
    if (this.#drafts.get(key) === draft) return
    const was = this.any
    if (draft) this.#drafts.set(key, draft)
    else this.#drafts.delete(key)
    if (this.any !== was) this.onAny?.(this.any)
    this.#listeners.forEach((listener) => listener())
  }

  /** Changes `key`'s draft by `change`, from the draft it has now. */
  update = (key: string, change: (draft: CodeDraft | undefined) => CodeDraft | undefined) => this.set(key, change(this.get(key)))

  /** Whether there is any draft at all, as closing the tab asks first while there is. */
  get any() {
    return this.#drafts.size > 0
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }
}

/** Which gadget a draft is of. */
export const draftKey = (workspaceId: string, gadgetId: number) => `${workspaceId}/${gadgetId}`

// Asks before the tab is closed or reloaded.
const leaving = (event: BeforeUnloadEvent) => event.preventDefault()

/** The drafts of this app's gadgets. While there is one, closing the tab or reloading asks first. */
export const codeDrafts = new CodeDrafts((any) => {
  if (typeof window === 'undefined') return
  if (any) window.addEventListener('beforeunload', leaving)
  else window.removeEventListener('beforeunload', leaving)
})
