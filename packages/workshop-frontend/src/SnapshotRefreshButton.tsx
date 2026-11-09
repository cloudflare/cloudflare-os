import { useState } from 'react'
import { Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowClockwise } from '@phosphor-icons/react'
import { WorkshopIconButton } from './components/WorkshopControls'

type Props = {
  // Takes a new copy of the gadget (see GadgetSnapshotClient.refresh()) and shows it.
  onRefresh: () => Promise<void>
}

/** Takes a new snapshot of a gadget, spinning meanwhile and reporting a failure as a toast. */
export const SnapshotRefreshButton = ({ onRefresh }: Props) => {
  const [refreshing, setRefreshing] = useState(false)
  const toasts = useKumoToastManager()

  const refresh = async () => {
    setRefreshing(true)
    try {
      await onRefresh()
    } catch (error) {
      console.error('Failed to refresh gadget snapshot:', error)
      toasts.add({ title: 'Failed to refresh the snapshot', variant: 'error' })
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <Tooltip content="Refresh snapshot" asChild>
      <WorkshopIconButton aria-label="Refresh snapshot" disabled={refreshing} onClick={refresh}>
        <ArrowClockwise size={17} className={refreshing ? 'animate-spin' : undefined} />
      </WorkshopIconButton>
    </Tooltip>
  )
}
