import { useEffect, useState } from 'react'
import { AlertCircleIcon, AppWindowIcon } from '@/components/icons'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { PaneNotice } from '@/blocks/PaneNotice'
import { useApi } from '@/rpc/ApiContext'
import { reportIssue } from '@/rpc/errorReporting'
import type { AppWorkspaceTarget } from './appNavigation'
import { GatekeeperAppFrame } from './GatekeeperAppFrame'

export type GatekeeperAppPaneProps = {
  /** The gatekeeper whose app it is, as `listGatekeeperApps()` lists it. */
  gatekeeperId: string
  /** What it is called, once the list of apps is read. */
  title: string | undefined
  onOpenWorkspace: (target: AppWorkspaceTarget) => void
  onOpenPrompt: (prompt: string) => void
}

// Held in an object: its API is a stub, which a state setter would take for an updater.
type Opened = { status: 'loading' } | { status: 'ready'; frame: GatekeeperUiFrame } | { status: 'missing' } | { status: 'failed'; message: string }

/**
 * A gatekeeper's management app, as a page of its own (`GatekeeperAppFrame`): opened
 * (`getGatekeeperApp()`) on each new connection, whose app replaces the last one's, and let go of
 * when the page is left. Says so where the user has no such app, as when its tool was turned off.
 */
export const GatekeeperAppPane = ({ gatekeeperId, title, onOpenWorkspace, onOpenPrompt }: GatekeeperAppPaneProps) => {
  const { api, reconnecting } = useApi()
  const [opened, setOpened] = useState<Opened>({ status: 'loading' })
  // Bumped to try again after a failure.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` opens it.
    if (reconnecting) return
    let cancelled = false
    let held: GatekeeperUiFrame | undefined
    api.getGatekeeperApp(gatekeeperId).then(
      (frame) => {
        const ui = frame?.ui as Partial<Disposable> | undefined
        if (cancelled) return void ui?.[Symbol.dispose]?.()
        held = frame ?? undefined
        setOpened(frame ? { status: 'ready', frame } : { status: 'missing' })
      },
      (error: unknown) => {
        reportIssue('gatekeeper-app.load', error, { gatekeeperVendorId: gatekeeperId })
        if (!cancelled) setOpened({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      cancelled = true
      const ui = held?.ui as Partial<Disposable> | undefined
      ui?.[Symbol.dispose]?.()
    }
  }, [api, reconnecting, gatekeeperId, attempt])

  if (opened.status === 'ready') {
    return <GatekeeperAppFrame frame={opened.frame} gatekeeperId={gatekeeperId} title={title ?? 'App'} onOpenWorkspace={onOpenWorkspace} onOpenPrompt={onOpenPrompt} />
  }
  if (opened.status === 'missing') {
    return <PaneNotice icon={AppWindowIcon} title="This app isn’t here" description="It may have been turned off, or this deployment doesn’t have it." />
  }
  if (opened.status === 'failed') {
    return (
      <PaneNotice
        icon={AlertCircleIcon}
        title={`Couldn’t open ${title ?? 'the app'}`}
        description={opened.message}
        action={{
          label: 'Try again',
          onClick: () => {
            setOpened({ status: 'loading' })
            setAttempt((current) => current + 1)
          },
        }}
      />
    )
  }
  return <PaneNotice title="Loading…" />
}
