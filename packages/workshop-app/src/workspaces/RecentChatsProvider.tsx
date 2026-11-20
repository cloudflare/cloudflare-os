import { useEffect, useState, type ReactNode } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { RecentChats } from './RecentChatsStore'
import { RecentChatsContext } from './RecentChatsContext'

/** Follows the viewer's recent chats from the account, for the sidebar, while a connection is up. */
export const RecentChatsProvider = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  const [store] = useState(() => new RecentChats())

  useEffect(() => {
    if (reconnecting) return
    return store.start(api)
  }, [api, reconnecting, store])

  return <RecentChatsContext value={store}>{children}</RecentChatsContext>
}
