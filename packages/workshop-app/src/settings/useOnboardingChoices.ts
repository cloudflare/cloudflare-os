import { useEffect, useState } from 'react'
import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import { ConnectedAccounts } from '@/connections/ConnectedAccounts'
import type { ConnectedAccount } from '@/connections/connectionList'
import { useApi } from '@/rpc/ApiContext'
import { messageOf } from './useAttempt'
import { onboardingChoicesOf, type OnboardingChoices } from './onboardingSteps'

/**
 * What setting up offers (`onboardingChoicesOf`), read as it is mounted: the services, the tools,
 * and the user's accounts, which are kept up to date, as one is connected in a window of its own.
 * The tools are waited for too, as finishing turns on those that are offered: where they cannot be
 * read, there are none, and the services are still offered.
 */
export const useOnboardingChoices = (): OnboardingChoices => {
  const { api, reconnecting } = useApi()
  const [vendors, setVendors] = useState<GatekeeperVendorInfo[]>()
  const [addable, setAddable] = useState<GatekeeperVendorInfo[]>()
  const [accounts, setAccounts] = useState<ConnectedAccount[]>()
  const [problem, setProblem] = useState<string>()
  // Bumped to ask again after a failure.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` reads it.
    if (reconnecting) return
    let cancelled = false
    const fail = (error: unknown) => {
      if (!cancelled) setProblem(messageOf(error))
    }
    api.listGatekeeperVendors().then((list) => {
      if (!cancelled) setVendors(list)
    }, fail)
    api.listAddableGatekeepers().then(
      (list) => {
        if (!cancelled) setAddable(list)
      },
      () => {
        if (!cancelled) setAddable([])
      },
    )
    const subscription = api.subscribeConnectedAccounts(new ConnectedAccounts((next) => {
      if (!cancelled) setAccounts(next)
    }))
    subscription.catch(fail)
    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [api, reconnecting, attempt])

  if (vendors && addable && accounts) return { status: 'ready', ...onboardingChoicesOf({ vendors, addable, accounts }) }
  if (problem !== undefined) {
    return {
      status: 'failed',
      message: problem,
      retry: () => {
        setProblem(undefined)
        setAttempt((count) => count + 1)
      },
    }
  }
  return { status: 'loading' }
}
