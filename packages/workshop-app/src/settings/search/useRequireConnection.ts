import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'

/**
 * Throws, once the notice has told the user so, where the connection is down and a change could
 * only fail, so that it is left as it was and search says why. Call it before asking the server
 * for anything.
 */
export const useRequireConnection = () => {
  const notice = useConnectionNotice()
  return () => {
    if (notice?.blocked()) throw new Error('Not connected. Try again once the connection is back.')
  }
}
