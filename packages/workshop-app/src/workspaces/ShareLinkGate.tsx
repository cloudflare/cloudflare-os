import { useEffect, useState, type ReactNode } from 'react'
import { LinkBreakIcon, ShieldCheckIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { getAccessConfirmationErrorCode, getOpenWorkspaceErrorCode, OPEN_WORKSPACE_ERROR_CODES } from '@gadgets/workshop-shared/api'
import { PaneNotice } from '@/blocks/PaneNotice'
import { useAskAccessAgain } from '@/connections/ObserverAccessProvider'
import { useApi } from '@/rpc/ApiContext'
import { shareKeyOf, workspaceOfPath } from './sharingRules'

type Step = 'redeeming' | 'opening'

type Redeeming =
  | { status: 'redeeming' }
  | { status: 'opening' }
  // The link lets no one in: turned off, unknown, or refused by the workspace (`because`).
  | { status: 'dead'; because?: string }
  | { status: 'unconfirmed' }
  | { status: 'failed'; message: string; retry: Step }
  | { status: 'done' }

const DEAD_LINK = 'It may have been turned off. Ask whoever sent it to share it with you instead.'

// The fragment goes, so the key is not kept in the history, copied on, or tried again on reload.
const forgetKey = () => {
  const { pathname, search } = window.location
  window.history.replaceState(window.history.state, '', `${pathname}${search}`)
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Lets the viewer in through a shared link (`#share=<key>` on a gadget's page) before anything on
 * the page asks for what it gives: until the server has taken the key, nothing beneath is shown,
 * so nothing is refused for want of it. Opened without a key, it is not there at all.
 *
 * The key is redeemed on its own (`redeemWorkspaceShareLink`) and forgotten once the server has
 * said what it did: a link that lets no one in says so, and one that let the viewer in has the
 * workspace opened without it, where they confirm their access. A confirmation declined
 * (`ACCESS_CONFIRMATION_ERROR_CODES`) is said as that, with the access kept and asked for again
 * as the page opens; a failure before the server answered keeps the key, to try again.
 */
export const ShareLinkGate = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  const askAgain = useAskAccessAgain()
  // Read once, as the page opened.
  const [link] = useState(() => {
    const key = shareKeyOf(window.location.hash)
    const workspaceId = key === undefined ? undefined : workspaceOfPath(window.location.pathname)
    return key !== undefined && workspaceId !== undefined ? { key, workspaceId } : undefined
  })
  const [state, setState] = useState<Redeeming>(link ? { status: 'redeeming' } : { status: 'done' })

  useEffect(() => {
    if (!link || reconnecting || (state.status !== 'redeeming' && state.status !== 'opening')) return
    let cancelled = false
    const settle = (next: Redeeming) => {
      if (!cancelled) setState(next)
    }
    if (state.status === 'redeeming') {
      api.redeemWorkspaceShareLink(link.workspaceId, link.key).then(
        (works) => {
          if (cancelled) return
          forgetKey()
          settle(works ? { status: 'opening' } : { status: 'dead' })
        },
        (error: unknown) => {
          if (cancelled) return
          // Only the owner lets people in: trying the key again would be refused again.
          if (getOpenWorkspaceErrorCode(error) === OPEN_WORKSPACE_ERROR_CODES.shareLinksDisabled) {
            forgetKey()
            settle({ status: 'dead', because: messageOf(error) })
          } else {
            settle({ status: 'failed', message: messageOf(error), retry: 'redeeming' })
          }
        },
      )
    } else {
      const workspace = api.openWorkspace(link.workspaceId)
      workspace.getMetadata().then(
        () => settle({ status: 'done' }),
        (error: unknown) => settle(getAccessConfirmationErrorCode(error) ? { status: 'unconfirmed' } : { status: 'failed', message: messageOf(error), retry: 'opening' }),
      ).finally(() => workspace[Symbol.dispose]())
    }
    return () => {
      cancelled = true
    }
  }, [api, reconnecting, link, state.status])

  if (state.status === 'done') return children
  if (state.status === 'redeeming' || state.status === 'opening') return <div className="flex h-dvh"><PaneNotice title="Opening the shared link…" /></div>
  const notice = state.status === 'dead'
    ? { icon: LinkBreakIcon, title: 'This link doesn’t work any more', description: state.because ?? DEAD_LINK, action: { label: 'Continue', onClick: () => setState({ status: 'done' }) } }
    : state.status === 'unconfirmed'
      ? {
          icon: ShieldCheckIcon,
          title: 'You didn’t confirm your access',
          description: 'The link let you in. To open what it shares, choose which of your accounts it reads through.',
          action: { label: 'Confirm access', onClick: () => {
            // The page opens it, asking again; cancelling there is the page's to say.
            askAgain()
            setState({ status: 'done' })
          } },
        }
      : { icon: WarningCircleIcon, title: 'Couldn’t open the shared link', description: state.message, action: { label: 'Try again', onClick: () => setState({ status: state.retry }) } }
  return <div className="flex h-dvh"><PaneNotice {...notice} /></div>
}
