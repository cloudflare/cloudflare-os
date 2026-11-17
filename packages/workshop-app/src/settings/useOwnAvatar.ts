import { useEffect, useSyncExternalStore } from 'react'
import { useObjectUrl } from '@/hooks/useObjectUrl'
import { useApi } from '@/rpc/ApiContext'
import { ownAvatar } from './OwnAvatar'

/**
 * The signed-in user's picture, as an address an `<img>` can show, or nothing while they have
 * none or it is still being read. The same picture wherever it is asked for (`OwnAvatar`).
 */
export const useOwnAvatar = () => {
  const { api, user, reconnecting } = useApi()
  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` reads it.
    if (!reconnecting) ownAvatar.load(user.id, () => api.getAvatar(user.id))
  }, [api, user.id, reconnecting])
  const kept = useSyncExternalStore(ownAvatar.subscribe, ownAvatar.getSnapshot)
  // What `setAvatar` is given is a JPEG (`avatarImage.ts`), and only ever shown in an `<img>`.
  return useObjectUrl(kept?.userId === user.id ? kept.bytes : undefined, 'image/jpeg')
}
