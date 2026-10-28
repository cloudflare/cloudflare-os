import type { Overseer } from '@gadgets/workshop-shared/api'
import { toChatItems, type ChatItem } from './chatItems'

export type ChatSnapshot =
  | { status: 'loading' }
  | {
      status: 'ready'
      /** The latest chat's title; undefined when the workspace has no chat yet. */
      title: string | undefined
      items: ChatItem[]
    }
  | { status: 'failed'; message: string }

/** The part of a workspace's Overseer a session uses, and the lease that must be disposed. */
export type ChatOverseer = Pick<Overseer, 'listChats' | 'getChatHistory'> & Disposable

const LOADING: ChatSnapshot = { status: 'loading' }

/**
 * One workspace's conversation. A workspace is treated as holding one chat: the most recently
 * active one. Observable through `subscribe`/`getSnapshot` (for `useSyncExternalStore`).
 *
 * Nothing happens until `start()`, and `stop()` releases the workspace connection, so the pair is
 * safe to run twice in a row (React does that in development) and a session abandoned before
 * starting holds nothing.
 */
export class ChatSession {
  #snapshot: ChatSnapshot = LOADING
  #listeners = new Set<() => void>()
  #overseer: ChatOverseer | undefined
  // Bumped by every start() and stop(), so a load that finishes after either can tell it is stale.
  #run = 0

  /** `open` connects to the workspace; the session disposes what it returns. */
  constructor(private readonly open: () => ChatOverseer) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  start() {
    const run = ++this.#run
    this.#publish(LOADING)
    void this.#load(run)
  }

  stop() {
    this.#run++
    this.#overseer?.[Symbol.dispose]()
    this.#overseer = undefined
  }

  #publish(snapshot: ChatSnapshot) {
    if (snapshot === this.#snapshot) return
    this.#snapshot = snapshot
    this.#listeners.forEach((listener) => listener())
  }

  async #load(run: number) {
    const overseer = this.open()
    this.#overseer = overseer
    try {
      const chats = await overseer.listChats()
      const latest = chats.toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())[0]
      const history = latest ? await overseer.getChatHistory(latest.id) : undefined
      if (run !== this.#run) return
      this.#publish({ status: 'ready', title: latest?.title, items: toChatItems(history?.messages ?? []) })
    } catch (error) {
      if (run !== this.#run) return
      this.#publish({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }
}
