import { useState } from 'react'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { OpenAiLogo } from '@phosphor-icons/react'
import type { ChatGptSignInStatus } from '@gadgets/workshop-shared/api'
import { rpcFailureDescription } from '../../rpcErrors'
import { ChatGptSignInDialog } from './ChatGptSignInDialog'
import type { ChatGptSignIn, StartedChatGptSignIn } from './useChatGptSignIn'

/** Sign in with ChatGPT, for the models that run on the user's own ChatGPT subscription. */
export const ChatGptSignInCard = ({ status, signIn }: {
  /** Shown only while the deployment offers signing in. */
  status: Exclude<ChatGptSignInStatus, { state: 'unavailable' }>
  signIn: Pick<ChatGptSignIn, 'begin' | 'complete' | 'signOut'>
}) => {
  const toasts = useKumoToastManager()
  const [pending, setPending] = useState<'begin' | 'signOut' | null>(null)
  const [flow, setFlow] = useState<StartedChatGptSignIn | null>(null)

  const begin = async () => {
    setPending('begin')
    try {
      setFlow(await signIn.begin())
    } catch (err) {
      console.error('Failed to start signing in with ChatGPT:', err)
      toasts.add({ title: 'Couldn’t start signing in with ChatGPT', description: rpcFailureDescription(err), variant: 'error' })
    } finally {
      setPending(null)
    }
  }

  const signOut = async () => {
    setPending('signOut')
    try {
      await signIn.signOut()
    } catch (err) {
      console.error('Failed to sign out of ChatGPT:', err)
      toasts.add({ title: 'Couldn’t sign out of ChatGPT', description: rpcFailureDescription(err), variant: 'error' })
    } finally {
      setPending(null)
    }
  }

  const signedIn = status.state === 'signedIn'
  // A sign-in the Workshop's own callback page finished arrives as a new status.
  if (flow && signedIn) setFlow(null)

  return (
    <div className="flex items-center gap-3 rounded-xl border border-kumo-line px-4 py-3">
      <OpenAiLogo size={18} className="shrink-0 text-kumo-default" />
      <div className="min-w-0 flex-1 text-[13px] leading-[18px] tracking-[-0.25px]">
        <p className="truncate font-medium text-kumo-default">
          {signedIn
            ? status.email ? `Signed in as ${status.email}` : 'Signed in with ChatGPT'
            : 'Use your ChatGPT subscription'}
        </p>
        <p className="text-kumo-subtle">
          {signedIn
            ? 'Your ChatGPT models run on your subscription, in workspaces only you can open.'
            : 'Sign in to use OpenAI models on your ChatGPT plan instead of an API key. Its models are added for you.'}
        </p>
      </div>
      {signedIn ? (
        <Button size="sm" variant="secondary" loading={pending === 'signOut'} disabled={pending !== null} onClick={signOut}>
          Sign out
        </Button>
      ) : (
        <Button size="sm" variant="secondary" loading={pending === 'begin'} disabled={pending !== null} onClick={begin}>
          Sign in with ChatGPT
        </Button>
      )}

      {flow && (
        <ChatGptSignInDialog
          key={flow.authorizeUrl}
          flow={flow}
          onComplete={async (callbackUrl) => {
            await signIn.complete(callbackUrl)
            setFlow(null)
            toasts.add({
              title: 'Signed in with ChatGPT',
              description: 'Your subscription’s models were added.',
              variant: 'success',
            })
          }}
          onClose={() => setFlow(null)}
        />
      )}
    </div>
  )
}
