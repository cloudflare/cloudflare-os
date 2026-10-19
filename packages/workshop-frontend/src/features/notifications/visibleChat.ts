type VisibleChat = { workspaceId: string; chatId: number }

// Only the editor knows whether its chat is on screen rather than covered, so it reports a getter,
// read when a notification arrives so it reflects the layout at that moment.
let getVisibleChat = (): VisibleChat | null => null
const listeners = new Set<() => void>()

/** Reports the chat on screen; returns the cleanup that withdraws the report. */
export const reportVisibleChat = (get: () => VisibleChat | null) => {
  getVisibleChat = get
  listeners.forEach(listener => listener())
  return () => {
    if (getVisibleChat === get) {
      getVisibleChat = () => null
      listeners.forEach(listener => listener())
    }
  }
}

/** Observe chat/layout changes without treating a hidden chat as read. */
export const subscribeVisibleChat = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Whether the user can currently see the given chat. */
export const isChatVisible = (workspaceId: string, chatId: number) => {
  const chat = getVisibleChat()
  return chat?.workspaceId === workspaceId && chat.chatId === chatId
}
