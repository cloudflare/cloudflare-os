import { RpcTarget, type RpcStub } from 'capnweb'
import type { AuthenticatedApi, NotificationSubscriber, UserNotification } from '@gadgets/workshop-shared/api'

/** A task the viewer is told of in the app: one of their chats finished, or waits for their approval. */
export type TaskNotice = Pick<UserNotification, 'id' | 'kind' | 'workspaceId' | 'chatId' | 'chatTitle'>

/**
 * What the server calls with each notification while this tab can show it. A class, because the
 * server must receive a single stub for the object. Refusing one (`notify` rejecting) is what
 * sends it to the user's devices and browsers instead.
 */
class NoticeListener extends RpcTarget implements NotificationSubscriber {
  constructor(
    private readonly onNotice: (notice: UserNotification) => void,
    private readonly onReleased: () => void,
  ) {
    super()
  }

  async notify(notification: UserNotification) {
    this.onNotice(notification)
  }

  [Symbol.dispose]() {
    this.onReleased()
  }
}

/** Whether the tab is in view, and word of when that changes. */
export type TabVisibility = {
  visible(): boolean
  /** Calls `listener` whenever it changes, until the function returned is called. */
  onChange(listener: () => void): () => void
}

/** The tab's own, from the document. */
export const documentVisibility: TabVisibility = {
  visible: () => document.visibilityState === 'visible',
  onChange: (listener) => {
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
}

/** The part of the backend the notifications use. The subscription's lease must be disposed. */
export type NoticesBackend = {
  subscribe(listener: Parameters<RpcStub<AuthenticatedApi>['subscribeToNotifications']>[0]): Promise<Disposable>
}

/** How long a notice stays before it goes by itself, in milliseconds. */
export const NOTICE_SHOWN_FOR = 8000
// After a subscription fails, it is tried again after these, doubling.
const RETRY_DELAY = { first: 1000, most: 30_000 }

/**
 * The viewer's notifications of their tasks, shown in this tab while it is in view
 * (`subscribeToNotifications`), one at a time: the latest, until it is put away or has been up for
 * `NOTICE_SHOWN_FOR`. Observable through `subscribe`/`getSnapshot`.
 *
 * Subscribed only while the tab is in view, and refusing any that arrives while it is not, so that
 * the account sends it to the user's devices and browsers instead (see `browserPush.ts`). One for a
 * chat that is on screen (`isShown`) is taken as seen and not shown. The account has already left
 * out what the user muted: a workspace's finished tasks, and a chat's notifications.
 */
export class TaskNotices {
  #snapshot: TaskNotice | undefined
  #listeners = new Set<() => void>()
  #lease: Promise<Disposable> | undefined
  #hide: ReturnType<typeof setTimeout> | undefined
  #retry: ReturnType<typeof setTimeout> | undefined
  #retryDelay = 0
  #stopWatching: (() => void) | undefined
  // Bumped by every subscription and stop(), so a call from an earlier one can tell it is stale.
  #run = 0

  constructor(
    private readonly backend: NoticesBackend,
    private readonly isShown: (workspaceId: string, chatId: number) => boolean,
    private readonly visibility: TabVisibility = documentVisibility,
  ) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  start() {
    this.#stopWatching?.()
    this.#stopWatching = this.visibility.onChange(() => {
      this.#retryDelay = 0
      this.#resubscribe()
    })
    this.#retryDelay = 0
    this.#resubscribe()
  }

  stop() {
    this.#stopWatching?.()
    this.#stopWatching = undefined
    this.#run++
    clearTimeout(this.#retry)
    clearTimeout(this.#hide)
    this.#releaseLease()
  }

  /** Puts the notice with this id away, if it is still the one shown. */
  dismiss = (id: string) => {
    if (this.#snapshot?.id !== id) return
    clearTimeout(this.#hide)
    this.#publish(undefined)
  }

  #resubscribe() {
    const run = ++this.#run
    clearTimeout(this.#retry)
    this.#releaseLease()
    // Out of view, nothing could be shown: the account pushes to the devices instead.
    if (!this.visibility.visible()) return
    let live = false
    let released = false
    const listener = new NoticeListener(
      (notification) => {
        if (run !== this.#run || !this.visibility.visible()) throw new Error('This tab can’t show notifications right now.')
        if (!this.isShown(notification.workspaceId, notification.chatId)) this.#show(notification)
      },
      () => {
        released = true
        // Let go of after it took, while still the current one: the account forgot it.
        if (live && run === this.#run) this.#resubscribe()
      },
    )
    const lease = this.backend.subscribe(listener)
    this.#lease = lease
    lease.then(
      () => {
        if (run !== this.#run) return
        live = true
        this.#retryDelay = 0
        if (released) this.#resubscribe()
      },
      () => {
        if (run !== this.#run) return
        const delay = this.#retryDelay || RETRY_DELAY.first
        this.#retryDelay = Math.min(delay * 2, RETRY_DELAY.most)
        this.#retry = setTimeout(() => {
          if (run === this.#run) this.#resubscribe()
        }, delay)
      },
    )
  }

  #show({ id, kind, workspaceId, chatId, chatTitle }: UserNotification) {
    clearTimeout(this.#hide)
    this.#publish({ id, kind, workspaceId, chatId, chatTitle })
    this.#hide = setTimeout(() => this.dismiss(id), NOTICE_SHOWN_FOR)
  }

  #releaseLease() {
    void this.#lease?.then((held) => held[Symbol.dispose](), () => {})
    this.#lease = undefined
  }

  #publish(snapshot: TaskNotice | undefined) {
    this.#snapshot = snapshot
    this.#listeners.forEach((listener) => listener())
  }
}
