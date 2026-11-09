import { useEffect, useEffectEvent, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ChatGptSignInStart, ChatGptSignInStatus } from '@gadgets/workshop-shared/api'
import { uniquePopupName } from '../../connectHandoff'

/**
 * The channel the Workshop's own ChatGPT callback page announces a finished sign-in on, so the tab
 * that started it can update (see ChatGptCallbackPage).
 */
export const CHATGPT_SIGN_IN_CHANNEL = 'chatgpt-sign-in'

/** A Sign in with ChatGPT flow the user has started, waiting for the tab to finish it. */
export type StartedChatGptSignIn = ChatGptSignInStart & {
  /** False when the browser blocked the sign-in tab, so the user has to open it themselves. */
  tabOpened: boolean
  /**
   * True when OpenAI sends the tab back to the Workshop itself (local development), which
   * finishes the sign-in there. Otherwise the tab ends on an error page whose address the user
   * pastes.
   */
  returnsHere: boolean
}

/** The user's Sign in with ChatGPT status, and the actions that change it. */
export type ChatGptSignIn = {
  /** Null until the status loads, and when it fails to. */
  status: ChatGptSignInStatus | null
  /**
   * Open OpenAI's sign-in page in a new tab. Must be called from the click that asked for it, or
   * the browser blocks the tab.
   */
  begin: () => Promise<StartedChatGptSignIn>
  /** Finish the started sign-in with the address its tab ended at. Rejects with the server's reason. */
  complete: (callbackUrl: string) => Promise<void>
  signOut: () => Promise<void>
}

/**
 * `onSignedIn` runs once a sign-in finishes, here or in the Workshop's own callback page, which also
 * adds the subscription's models.
 */
export const useChatGptSignIn = (authenticatedApi: RpcStub<AuthenticatedApi>,
                                 onSignedIn?: () => void): ChatGptSignIn => {
  const [status, setStatus] = useState<ChatGptSignInStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.getChatGptSignIn().then(
      (loaded) => { if (!cancelled) setStatus(loaded) },
      (err) => { if (!cancelled) console.error('Failed to load the ChatGPT sign-in status:', err) },
    )
    return () => { cancelled = true }
  }, [authenticatedApi])

  const signedInElsewhere = useEffectEvent(async () => {
    setStatus(await authenticatedApi.getChatGptSignIn())
    onSignedIn?.()
  })

  useEffect(() => {
    const channel = new BroadcastChannel(CHATGPT_SIGN_IN_CHANNEL)
    channel.addEventListener('message', () => {
      signedInElsewhere().catch((err: unknown) =>
        console.error('Failed to load the ChatGPT sign-in status:', err))
    })
    return () => channel.close()
  }, [])

  const begin = async (): Promise<StartedChatGptSignIn> => {
    // Opened before the first await, while the click still counts as a user gesture. A tab rather
    // than a popup window, since the user may need to copy the address it ends at. Disowned as in
    // openDisownedPopup, so OpenAI's pages get no handle on this tab.
    const tab = window.open('', uniquePopupName('chatgpt-sign-in'))
    if (tab) tab.opener = null
    let start: ChatGptSignInStart
    try {
      start = await authenticatedApi.beginChatGptSignIn()
    } catch (err) {
      tab?.close()
      throw err
    }
    tab?.location.replace(start.authorizeUrl)
    return {
      ...start,
      tabOpened: tab !== null,
      returnsHere: new URL(start.redirectUri).origin === window.location.origin,
    }
  }

  const complete = async (callbackUrl: string) => {
    setStatus(await authenticatedApi.completeChatGptSignIn(callbackUrl))
    onSignedIn?.()
  }

  const signOut = async () => {
    await authenticatedApi.signOutChatGpt()
    setStatus({ state: 'signedOut' })
  }

  return { status, begin, complete, signOut }
}
