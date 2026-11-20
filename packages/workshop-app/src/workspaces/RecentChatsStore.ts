import type { AiChatMetadata, ChatReadState } from '@gadgets/workshop-shared/api'
import type { ChatTail, WorkspaceChatsReading } from './recentChats'
import { recentChatKey } from './recentChats'

/** What has been read of the viewer's chats for the sidebar: each workspace's, and the last messages of some. */
export type RecentChatsSnapshot = {
  readings: ReadonlyMap<string, WorkspaceChatsReading>
  tails: ReadonlyMap<string, ChatTail>
  /** Every workspace asked for has answered, or could not. */
  known: boolean
}

/**
 * The viewer's chats as the sidebar's sweep reads them (`AgentsWaitingProvider`), a workspace at
 * a time, with the last messages of some (`recentChatsOf` says which are listed). What the viewer
 * changes of a chat (muted, read) shows at once (`markChat`), until the workspace is read again.
 * Observable through `subscribe`/`snapshot`.
 */
export class RecentChats {
  #snapshot: RecentChatsSnapshot = { readings: new Map(), tails: new Map(), known: false }
  #expected = new Set<string>()
  #answered = new Set<string>()
  #listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  snapshot = () => this.#snapshot

  /** The workspaces that will be asked: until each has answered, or could not, the list is not known whole. */
  expect(ids: readonly string[]) {
    this.#expected = new Set(ids)
    this.#publish({})
  }

  /** What a workspace said of its chats, with the last messages of those read with it. */
  set(workspaceId: string, reading: WorkspaceChatsReading, tails: ReadonlyMap<number, ChatTail> = new Map()) {
    this.#answered.add(workspaceId)
    const nextTails = new Map(this.#snapshot.tails)
    for (const [chatId, tail] of tails) nextTails.set(recentChatKey(workspaceId, chatId), tail)
    this.#publish({ readings: new Map(this.#snapshot.readings).set(workspaceId, reading), tails: nextTails })
  }

  /** A workspace could not be read: what it said before stays. */
  failed(workspaceId: string) {
    this.#answered.add(workspaceId)
    this.#publish({})
  }

  /** Whether a chat's last messages are to be read: never yet, or not since it was last active. */
  needsTail(workspaceId: string, chat: AiChatMetadata) {
    return this.#snapshot.tails.get(recentChatKey(workspaceId, chat.id))?.lastActive !== chat.lastActive.getTime()
  }

  /**
   * Shows a change the viewer made to a chat's read state, as the server has been asked for it,
   * until the workspace is read again. Returns how it was, to put back should the server refuse.
   */
  markChat(workspaceId: string, chatId: number, change: Partial<ChatReadState>): ChatReadState | undefined {
    const reading = this.#snapshot.readings.get(workspaceId)
    if (!reading) return undefined
    const was = reading.readStates.find((state) => state.chatId === chatId)
    const next: ChatReadState = { ...(was ?? { workspaceId, chatId, unreadMessageCount: 0, readThroughSequence: -1 }), ...change }
    const readStates = was ? reading.readStates.map((state) => (state === was ? next : state)) : [...reading.readStates, next]
    this.#publish({ readings: new Map(this.#snapshot.readings).set(workspaceId, { ...reading, readStates }) })
    return was
  }

  /** Puts a chat's read state back as it was (`markChat`'s answer), as after the server refused. */
  restoreChat(workspaceId: string, chatId: number, was: ChatReadState | undefined) {
    const reading = this.#snapshot.readings.get(workspaceId)
    if (!reading) return
    const others = reading.readStates.filter((state) => state.chatId !== chatId)
    this.#publish({ readings: new Map(this.#snapshot.readings).set(workspaceId, { ...reading, readStates: was ? [...others, was] : others }) })
  }

  #publish(change: Partial<Omit<RecentChatsSnapshot, 'known'>>) {
    const known = [...this.#expected].every((id) => this.#answered.has(id))
    this.#snapshot = { ...this.#snapshot, ...change, known }
    for (const listener of this.#listeners) listener()
  }
}
