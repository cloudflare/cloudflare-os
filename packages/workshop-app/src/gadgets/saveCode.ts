import { RpcTarget, type RpcStub } from 'capnweb'
import { MAX_READ_FILES_PER_CALL, type FileAtCommit, type Overseer, type WorkpieceSummary, type WorkpiecesSubscriber } from '@gadgets/workshop-shared/api'
import { conflictsWith, editedLine, rebase, toChange, type CodeDraft, type DraftBefore } from './codeDrafts'

/**
 * The part of a workspace's Overseer a save uses, and the lease that must be disposed. The
 * subscribe call takes the subscriber object itself, as a call through a stub does.
 */
export type SavingOverseer = Pick<Overseer, 'listChats' | 'newChat' | 'setChatTitle' | 'submitCodeChange' | 'mergeChanges' | 'revertChanges' | 'readFilesAtCommit'> & {
  subscribeToWorkpieces(subscriber: Parameters<RpcStub<Overseer>['subscribeToWorkpieces']>[0]): ReturnType<Overseer['subscribeToWorkpieces']>
} & Disposable

export type SaveCodeOptions = {
  gadgetId: number
  draft: CodeDraft
  /**
   * The chat the save is kept through: the one this device last made for the gadget's edits where
   * it can still take them (`reuse`), else a new one, titled for the gadget (`title`), whose agent
   * is off. Beside a chat, edits go into that chat as they are made, and keeping it keeps them.
   */
  chat: { title: string; reuse?: number }
  /** Saves the files the draft touches as it has them, over what others changed in them since. */
  anyway?: boolean
  /** Told of a chat made for the save, for the next save of the gadget to reuse. */
  onChatMade?: (chatId: number) => void
  /** A new editing session's id, for each change submitted. */
  newClientId?: () => string
}

/** What came of a save. */
export type SaveResult =
  /** Kept: the gadget's head is now `head`, where it could be read. */
  | { status: 'saved'; head?: string }
  /** Nothing was saved: someone changed these files of the draft's since it touched them. */
  | { status: 'conflict'; paths: string[] }
  | { status: 'failed'; message: string }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Hears the workspace's workpieces once over, for one gadget's head.
class HeadReader extends RpcTarget implements WorkpiecesSubscriber {
  #found: { commitId?: string } | undefined
  constructor(private readonly gadgetId: number, private readonly done: (found: { commitId?: string } | undefined) => void) {
    super()
  }

  entry(summary: WorkpieceSummary) {
    if (summary.id === this.gadgetId && summary.type === 'gadget') this.#found = { commitId: summary.commitId }
  }

  removed() {}

  ready() {
    this.done(this.#found)
  }
}

/** The gadget's head as it is now, read through a subscription let go of once it has said. */
const readHead = async (overseer: SavingOverseer, gadgetId: number) => {
  let heard!: (found: { commitId?: string } | undefined) => void
  const found = new Promise<{ commitId?: string } | undefined>((resolve) => { heard = resolve })
  const lease = overseer.subscribeToWorkpieces(new HeadReader(gadgetId, heard))
  try {
    // A subscription that fails says so, rather than leaving the head unheard of for ever.
    const head = await Promise.race([found, lease.then(() => found)])
    if (!head) throw new Error('It’s no longer there.')
    if (!head.commitId) throw new Error('It’s still waiting in a chat. Keep that chat’s changes to edit it here.')
    return head.commitId
  } finally {
    void lease.then((made) => made[Symbol.dispose](), () => {})
  }
}

const beforeOf = (file: FileAtCommit): DraftBefore =>
  file.kind === 'text' ? { kind: 'text', text: file.text } : file.kind === 'absent' ? { kind: 'absent' } : { kind: 'other' }

/**
 * The files at `commit`, as a draft's `before` takes them. A call names so many paths at most, and
 * the server may answer fewer, leaving the rest to be asked for again.
 */
const readBefores = async (overseer: SavingOverseer, commit: string, paths: string[]) => {
  const read = new Map<string, DraftBefore>()
  let left = paths
  while (left.length) {
    const asked = left.slice(0, MAX_READ_FILES_PER_CALL)
    const answered = await overseer.readFilesAtCommit(commit, asked)
    for (const [path, file] of answered) read.set(path, beforeOf(file))
    const next = left.filter((path) => !read.has(path))
    if (next.length === left.length) throw new Error('The workspace didn’t say what its files are.')
    left = next
  }
  return read
}

/**
 * Saves a draft of the gadget `gadgetId`'s code, as one change kept through a chat: the backend
 * only changes a gadget's code that way.
 *
 * Its head is read first. Where it has moved since the draft was started, the files the draft
 * touches are read there: any someone changed meanwhile stop the save (unless `anyway`), and
 * otherwise the draft moves onto the head. The chat is then found or made, the draft submitted to
 * it as one change of whole files, pinned at the head unless the chat has the gadget pinned, and
 * the chat's changes kept. A keep refused as stale (someone kept in between) takes the change back
 * out of the chat and goes round once more.
 */
export const saveCode = async (open: () => SavingOverseer, options: SaveCodeOptions): Promise<SaveResult> => {
  const { gadgetId, anyway = false, onChatMade, newClientId = () => crypto.randomUUID() } = options
  const overseer = open()
  let draft = options.draft
  let chatId: number | undefined
  // A chat the change is in, not kept: it is taken back out should the save fail.
  let submitted: number | undefined
  try {
    for (let round = 0; ; round++) {
      const head = await readHead(overseer, gadgetId)
      if (head !== draft.base) {
        const atHead = await readBefores(overseer, head, [...draft.files.keys()])
        const paths = conflictsWith(draft, atHead)
        if (paths.length && !anyway) return { status: 'conflict', paths }
        const moved = rebase(draft, head, atHead)
        // The head already has it as the draft does.
        if (!moved) return { status: 'saved', head }
        draft = moved
      }

      const chats = await overseer.listChats()
      let chat = chats.find(({ id }) => id === chatId)
      if (!chat) {
        const { title, reuse } = options.chat
        const reused = chats.find(({ id }) => id === reuse)
        if (reused && !reused.activeAgent && !reused.proposedChangeWorkpieces?.length) {
          chat = reused
        } else {
          // Its agent off: the chat only records the save.
          chatId = await overseer.newChat(editedLine(draft), null)
          onChatMade?.(chatId)
          // Its title is how it reads in the chats and in the history; without one it is named from its line.
          await overseer.setChatTitle(chatId, `Edits to ${title}`).catch(() => {})
        }
        chatId = chat?.id ?? chatId
      }
      if (chatId === undefined) return { status: 'failed', message: 'There was no chat to save it through.' }

      // A chat with nothing in it yet has no code base: generation 0, revision 0, nothing pinned.
      const base = chat?.codeBase
      const pinned = base?.pins.some((pin) => pin.gadgetId === gadgetId) ?? false
      submitted = chatId
      await overseer.submitCodeChange(chatId, {
        generation: base?.generation ?? 0,
        revision: base?.revision ?? 0,
        clientId: newClientId(),
        seq: 1,
        pins: pinned ? [] : [{ gadgetId, baseCommit: head }],
        change: toChange(draft, gadgetId),
      })
      const { outcome } = await overseer.mergeChanges(chatId)
      if (outcome === 'merged') {
        submitted = undefined
        return { status: 'saved', head: await readHead(overseer, gadgetId).catch(() => undefined) }
      }
      await overseer.revertChanges(chatId, 0)
      submitted = undefined
      if (round === 1) return { status: 'failed', message: 'Someone else’s changes landed meanwhile. Try again.' }
    }
  } catch (error) {
    // Left in the chat, the change would be kept by whoever next keeps its changes.
    if (submitted !== undefined) await overseer.revertChanges(submitted, 0).catch(() => {})
    return { status: 'failed', message: messageOf(error) }
  } finally {
    overseer[Symbol.dispose]()
  }
}
