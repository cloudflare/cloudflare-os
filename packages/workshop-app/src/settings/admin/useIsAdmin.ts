import { useEffect, useState } from 'react'
import { useApi } from '@/rpc/ApiContext'

// What each connection said, so that whatever asks again over it has the answer at once: the
// sidebar and the page both ask.
const answers = new WeakMap<object, boolean>()

/**
 * Whether the user is one of the deployment's admins, who are shown its settings too, or
 * undefined until the server has said. A new connection asks again, and until it has answered
 * what the last one said stands, so that nothing comes and goes over a reconnect.
 */
export const useIsAdmin = (): boolean | undefined => {
  const { api, reconnecting } = useApi()
  const [last, setLast] = useState<boolean>()

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` asks.
    if (reconnecting || answers.has(api)) return
    let cancelled = false
    api.amIAdmin().then(
      (admin) => {
        answers.set(api, admin)
        if (!cancelled) setLast(admin)
      },
      // Not knowing is not being one: nothing of the deployment's is shown.
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [api, reconnecting])

  return answers.get(api) ?? last
}
