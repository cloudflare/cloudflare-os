import { useEffect, useRef, useState } from 'react'
import { CheckCircle, WarningCircle } from '@phosphor-icons/react'
import { useAuthenticatedApi } from '../../AuthContext'
import { CHATGPT_SIGN_IN_CHANNEL } from './useChatGptSignIn'

type Outcome = { state: 'finishing' } | { state: 'done' } | { state: 'failed', message: string }

/**
 * Where OpenAI sends a Sign in with ChatGPT tab back when the Workshop is served from an address on
 * the user's own computer, as in local development (see ChatGptSignInStart.redirectUri). Finishes
 * the sign-in over this tab's session and tells the tab that started it.
 */
export const ChatGptCallbackPage = () => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [outcome, setOutcome] = useState<Outcome>({ state: 'finishing' })
  // The authorization code is single-use, so it is sent once even when the effect runs twice.
  const sent = useRef(false)

  useEffect(() => {
    if (sent.current) return
    sent.current = true
    const callbackUrl = window.location.href
    // Keeps the code out of the history and any copied link.
    window.history.replaceState(window.history.state, '', window.location.pathname)
    authenticatedApi.completeChatGptSignIn(callbackUrl).then(() => {
      const channel = new BroadcastChannel(CHATGPT_SIGN_IN_CHANNEL)
      // oxlint-disable-next-line require-post-message-target-origin -- a BroadcastChannel takes no origin.
      channel.postMessage('signedIn')
      channel.close()
      setOutcome({ state: 'done' })
    }, (err: unknown) => {
      setOutcome({
        state: 'failed',
        message: err instanceof Error && err.message ? err.message : 'Couldn’t finish signing in.',
      })
    })
  }, [authenticatedApi])

  return (
    <div className="flex min-h-full items-center justify-center bg-kumo-base p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center" role="status">
        {outcome.state === 'finishing' && (
          <>
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
            <p className="text-sm text-kumo-subtle">Finishing signing in with ChatGPT…</p>
          </>
        )}
        {outcome.state === 'done' && (
          <>
            <CheckCircle size={32} weight="duotone" className="text-kumo-success" />
            <p className="font-medium text-kumo-default">Signed in with ChatGPT</p>
            <p className="text-sm text-kumo-subtle">You can close this tab.</p>
          </>
        )}
        {outcome.state === 'failed' && (
          <>
            <WarningCircle size={32} weight="duotone" className="text-kumo-danger" />
            <p className="font-medium text-kumo-default">Couldn’t sign in with ChatGPT</p>
            <p className="text-sm text-kumo-subtle">{outcome.message}</p>
          </>
        )}
      </div>
    </div>
  )
}
