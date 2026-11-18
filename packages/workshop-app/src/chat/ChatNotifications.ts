import { RpcTarget, type RpcStub } from 'capnweb'
import type { AuthenticatedApi, ChatReadState, Overseer, UnreadStateSubscriber, UserUnreadState } from '@gadgets/workshop-shared/api'

/** Whether a chat tells the viewer of what happens in it: its unread badge, and its alerts. */
export type ChatNotificationState = {
  enabled: boolean
  /**
   * What the viewer chose themselves, where they did. Without it the chat goes by the default,
   * which is on, but off in a chat they have not taken part in yet that asks for that.
   */
  override?: boolean
}

/** One way to change a chat's notifications, as a menu offers it. */
export type NotificationChoice = { enabled: boolean; label: string }

/** What the workspace says of a chat's notifications for the viewer, where it says anything. */
export type ChatNotificationRow = Pick<ChatReadState, 'notificationsEnabled' | 'notificationsEnabledOverride'>

/**
 * A chat's notifications for the viewer: what the workspace says of them, and otherwise the
 * default, which is off only where the chat asks to be taken part in first
 * (`notificationsRequireParticipation`).
 */
export const notificationsOf = (row: ChatNotificationRow | undefined, requiresParticipation: boolean): ChatNotificationState => ({
  enabled: row?.notificationsEnabled ?? !requiresParticipation,
  override: row?.notificationsEnabledOverride,
})

/**
 * The ways a chat's notifications can be changed, as the old app's menu offered them: turned on
 * where they are off, and muted where they are on. Off only by default, they can be muted as well,
 * as that also silences the alerts that ask for an approval, which the default lets through.
 */
export const notificationChoices = ({ enabled, override }: ChatNotificationState): NotificationChoice[] => [
  ...(enabled ? [] : [{ enabled: true, label: override === false ? 'Unmute notifications' : 'Enable notifications' }]),
  ...(enabled || override !== false ? [{ enabled: false, label: 'Mute notifications' }] : []),
]

/**
 * What the server calls with the viewer's read state. A class, because the server must receive a
 * single stub for the object.
 */
class ReadStateListener extends RpcTarget implements UnreadStateSubscriber {
  constructor(
    private readonly onState: (state: UserUnreadState) => void,
    private readonly onChat: (workspaceId: string, chatId: number, chat: ChatReadState | null) => void,
  ) {
    super()
  }

  async updated(state: UserUnreadState) {
    this.onState(state)
  }

  async summaryUpdated() {}

  async chatUpdated(workspaceId: string, chatId: number, chat: ChatReadState | null) {
    this.onChat(workspaceId, chatId, chat)
  }
}

/**
 * The part of the backend the notifications use, for one workspace. The subscribe call takes the
 * listener itself, as a call through a stub does, and its lease must be disposed.
 */
export type NotificationsBackend = {
  /** Subscribes to the viewer's read state for the workspace's chats. */
  subscribe(listener: Parameters<RpcStub<AuthenticatedApi>['subscribeToUnreadState']>[1]): Promise<Disposable>
  /** The workspace, to change a chat's notifications in; disposed once that is done. */
  open(): Pick<Overseer, 'setChatNotificationsEnabled'> & Disposable
}

/** What is known of each of a workspace's chats' notifications for the viewer, by the chat's id. */
export type ChatNotificationRows = ReadonlyMap<number, ChatNotificationRow>

/**
 * The viewer's notifications for one workspace's chats, live (`subscribeToUnreadState()`, scoped to
 * the workspace), and the way to change one's. Observable through `subscribe`/`getSnapshot`.
 *
 * A change shows at once and stays until what the workspace says next of that chat, which should
 * be the change; refused, it is put back. The subscription is the user's own, not the workspace's,
 * so a workspace that restarts does not break it; a new connection makes a new one.
 */
export class ChatNotifications {
  #rows = new Map<number, ChatNotificationRow>()
  // Changes asked for, by chat, until the workspace has said what they came to.
  #chosen = new Map<number, { enabled: boolean; settled: boolean }>()
  #snapshot: ChatNotificationRows = new Map()
  #listeners = new Set<() => void>()
  #lease: Promise<Disposable> | undefined
  // Bumped by every start() and stop(), so a call from an earlier run can tell it is stale.
  #run = 0

  constructor(private readonly backend: NotificationsBackend, private readonly workspaceId: string) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  start() {
    const run = ++this.#run
    const listener = new ReadStateListener(
      (state) => {
        if (run !== this.#run) return
        this.#rows = new Map(state.chats.filter(({ workspaceId }) => workspaceId === this.workspaceId).map((chat) => [chat.chatId, chat]))
        for (const [chatId, chosen] of this.#chosen) if (chosen.settled) this.#chosen.delete(chatId)
        this.#publish()
      },
      (workspaceId, chatId, chat) => {
        if (run !== this.#run || workspaceId !== this.workspaceId) return
        if (chat) this.#rows.set(chatId, chat)
        else this.#rows.delete(chatId)
        if (this.#chosen.get(chatId)?.settled) this.#chosen.delete(chatId)
        this.#publish()
      },
    )
    this.#lease = this.backend.subscribe(listener)
    // Without it the chats go by their defaults, which is what they show until it is in.
    this.#lease.catch(() => {})
  }

  stop() {
    this.#run++
    void this.#lease?.then((held) => held[Symbol.dispose](), () => {})
    this.#lease = undefined
  }

  /**
   * Turns a chat's notifications on or off for the viewer. Shown at once; rejects with why, and is
   * put back, when the workspace refuses it.
   */
  setEnabled = async (chatId: number, enabled: boolean) => {
    const chosen = { enabled, settled: false }
    this.#chosen.set(chatId, chosen)
    this.#publish()
    const overseer = this.backend.open()
    try {
      await overseer.setChatNotificationsEnabled(chatId, enabled)
      chosen.settled = true
    } catch (error) {
      // Unless it has been changed again since.
      if (this.#chosen.get(chatId) === chosen) {
        this.#chosen.delete(chatId)
        this.#publish()
      }
      throw error
    } finally {
      overseer[Symbol.dispose]()
    }
  }

  #publish() {
    const rows = new Map(this.#rows)
    for (const [chatId, { enabled }] of this.#chosen) rows.set(chatId, { notificationsEnabled: enabled, notificationsEnabledOverride: enabled })
    this.#snapshot = rows
    this.#listeners.forEach((listener) => listener())
  }
}
