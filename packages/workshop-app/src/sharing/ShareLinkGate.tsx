import { useEffect, useState, type ReactNode } from 'react'
import { LinkBreakIcon } from '@phosphor-icons/react'
import { PaneNotice } from '@/blocks/PaneNotice'
import { useApi } from '@/rpc/ApiContext'
import { shareKeyOf, workspaceOfPath } from './sharingRules'

type Redeeming = { status: 'redeeming' } | { status: 'failed'; message: string } | { status: 'done' }

// The fragment goes, so the key is not kept in the history, copied on, or tried again on reload.
const forgetKey = () => {
  const { pathname, search } = window.location
  window.history.replaceState(window.history.state, '', `${pathname}${search}`)
}

/**
 * Lets the viewer in through a shared link (`#share=<key>` on a gadget's page) before anything on
 * the page asks for what it gives: until the server has taken the key, nothing beneath is shown,
 * so nothing is refused for want of it. Opened without a key, it is not there at all.
 */
export const ShareLinkGate = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  // Read once, as the page opened.
  const [link] = useState(() => {
    const key = shareKeyOf(window.location.hash)
    const workspaceId = key === undefined ? undefined : workspaceOfPath(window.location.pathname)
    return key !== undefined && workspaceId !== undefined ? { key, workspaceId } : undefined
  })
  const [state, setState] = useState<Redeeming>(link ? { status: 'redeeming' } : { status: 'done' })

  useEffect(() => {
    if (!link || reconnecting || state.status !== 'redeeming') return
    let cancelled = false
    const workspace = api.openWorkspace(link.workspaceId, link.key)
    // Asking anything of it is what has the key redeemed.
    workspace.getMetadata().then(
      () => {
        if (cancelled) return
        forgetKey()
        setState({ status: 'done' })
      },
      (error: unknown) => {
        if (cancelled) return
        forgetKey()
        setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    ).finally(() => workspace[Symbol.dispose]())
    return () => {
      cancelled = true
    }
  }, [api, reconnecting, link, state.status])

  if (state.status === 'done') return children
  if (state.status === 'redeeming') return <div className="flex h-dvh"><PaneNotice title="Opening the shared link…" /></div>
  return (
    <div className="flex h-dvh">
      <PaneNotice
        icon={LinkBreakIcon}
        title="This link doesn’t work any more"
        description={`It may have been turned off, or you may need to ask for access again. ${state.message}`}
        action={{ label: 'Continue', onClick: () => setState({ status: 'done' }) }}
      />
    </div>
  )
}
