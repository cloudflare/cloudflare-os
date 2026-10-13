type VisibleChat = { workspaceId: string; chatId: number }

// Only the editor knows whether its chat is on screen rather than covered, so it reports a getter,
// read when a notification arrives so it reflects the layout at that moment.
let getVisibleChat = (): VisibleChat | null => null

/** Reports the chat on screen; returns the cleanup that withdraws the report. */
export const reportVisibleChat = (get: () => VisibleChat | null) => {
  getVisibleChat = get
  return () => {
    if (getVisibleChat === get) getVisibleChat = () => null
  }
}

/** Whether the user can currently see the given chat. */
export const isChatVisible = (workspaceId: string, chatId: number) => {
  const chat = getVisibleChat()
  return chat?.workspaceId === workspaceId && chat.chatId === chatId
}
