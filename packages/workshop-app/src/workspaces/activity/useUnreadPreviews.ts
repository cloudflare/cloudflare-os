import { useEffect, useState } from 'react'
import { useApi } from '@/rpc/ApiContext'

type Preview = { preview?: string; at?: Date }

/**
 * The start of the latest message of each of a workspace's chats with anything unread, by its id,
 * from the account's inbox (`getUnreadThreads()`), which says it without opening the workspace.
 * Read again as `unread` (what is unread, said as a string, such as ids and counts) changes. Until
 * read, and where it cannot be, there are none, and the chats are listed without.
 */
export const useUnreadPreviews = (workspaceId: string, unread: string): ReadonlyMap<number, Preview> => {
  const { api, reconnecting } = useApi()
  const [previews, setPreviews] = useState<ReadonlyMap<number, Preview>>(new Map())

  useEffect(() => {
    if (!unread || reconnecting) return
    let current = true
    // Through a promise, so that a server older than the inbox, which throws, is one that says nothing.
    Promise.resolve().then(() => api.getUnreadThreads()).then(
      (threads) => {
        if (!current) return
        setPreviews(new Map(threads
          .filter((thread) => thread.workspaceId === workspaceId)
          .map((thread) => [thread.chatId, { preview: thread.latestMessagePreview || undefined, at: thread.latestActivityAt }])))
      },
      () => {},
    )
    return () => {
      current = false
    }
  }, [api, reconnecting, workspaceId, unread])

  return previews
}
