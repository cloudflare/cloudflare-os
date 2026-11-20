import type { ReactNode } from 'react'
import type { AdminSettingsView } from '@gadgets/workshop-shared/api'
import { Button } from '@gadgets/ui'
import type { AdminSettingsState } from './useAdminSettings'

/**
 * What an admin part says in place of the settings until they are there: that they are loading,
 * and, where they could not be read, why, with the way to try again. Then the part itself, from
 * what was read.
 */
export const AdminSettingsStatus = ({ state, children }: { state: AdminSettingsState; children: (view: AdminSettingsView) => ReactNode }) => {
  if (state.status === 'loading') return <p role="status" className="appears-late px-5 text-base text-kumo-subtle">Loading the deployment’s settings…</p>
  if (state.status === 'failed') {
    return (
      <p className="flex flex-wrap items-center gap-3 px-5 text-base text-kumo-subtle">
        Couldn’t load the deployment’s settings: {state.message}
        <Button variant="ghost" onClick={state.retry}>Try again</Button>
      </p>
    )
  }
  return children(state.view)
}
