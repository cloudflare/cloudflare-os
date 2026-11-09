import { useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { GadgetClient, Overseer } from '@gadgets/workshop-shared/api'
import { rpcFailureDescription } from '../../rpcErrors'
import { ApprovalModeMenu, type ApprovalMode } from './ApprovalModeMenu'
import { allDrafts, type DraftGroup } from './drafts'
import { DraftsTray } from './DraftsTray'
import { useDraftDecisions } from './useDraftDecisions'

/**
 * Whether the gadget's own changes wait for review or apply on their own, in its pane's header.
 * In Auto they apply whoever uses it and while no one is watching, as a scheduled gadget needs.
 */
export const GadgetApprovalMode = ({ gadget, mode, waiting, restricted }: {
  gadget: RpcStub<GadgetClient>
  mode: ApprovalMode
  waiting: number
  restricted: boolean
}) => {
  const toasts = useKumoToastManager()
  const [busy, setBusy] = useState(false)
  const change = async (next: ApprovalMode) => {
    setBusy(true)
    try {
      await gadget.setAutoApprove(next === 'auto')
    } catch (error) {
      console.error("Failed to change the gadget's approval mode:", error)
      toasts.add({
        title: next === 'auto' ? "Couldn't turn on Auto" : "Couldn't switch to Review first",
        description: rpcFailureDescription(error),
        variant: 'error',
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <ApprovalModeMenu scope="gadget" side="bottom" mode={mode} waiting={waiting} restricted={restricted}
      busy={busy} onChange={next => void change(next)} />
  )
}

/** What the gadget's own code drafted, above the gadget in its pane (see DraftsTray). */
export const GadgetDraftsTray = ({ overseer, groups, restricted, onReview }: {
  overseer: RpcStub<Overseer>
  groups: readonly DraftGroup[]
  restricted: boolean
  onReview: (group: DraftGroup) => void
}) => {
  const decisions = useDraftDecisions(overseer)
  if (allDrafts(groups).length === 0 && decisions.run.status !== 'failed') return null
  return (
    <div className="pt-1">
      <DraftsTray groups={groups} decisions={decisions} restricted={restricted} onReview={onReview} />
    </div>
  )
}
