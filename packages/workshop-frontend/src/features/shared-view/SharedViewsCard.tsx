import { useState } from 'react'
import { Switch, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AdminApi } from '@gadgets/workshop-shared/api'
import { rpcFailureDescription } from '../../rpcErrors'

/** Whether people a gadget is shared with may see its owner's view when they can't open its data. */
export const SharedViewsCard = ({ admin, enabled, onSaved }: {
  admin: RpcStub<AdminApi>
  /** What the server holds. */
  enabled: boolean
  onSaved: (enabled: boolean) => void
}) => {
  const [saving, setSaving] = useState(false)
  const toasts = useKumoToastManager()

  const save = async (next: boolean) => {
    setSaving(true)
    try {
      await admin.setSharedViews(next)
      onSaved(next)
    } catch (err) {
      toasts.add({
        title: 'Failed to save the shared views setting',
        description: rpcFailureDescription(err),
        variant: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">Shared views</h2>
          <p className="text-sm text-kumo-subtle">
            People a gadget is shared with see it as its owner last saw it, even when they
            can&rsquo;t open its data themselves. Each view is recorded in the workspace&rsquo;s
            activity log. Turn this off and those people must verify access to everything the
            gadget reads before it opens, including in workspaces holding restricted data.
          </p>
        </div>
        <Switch
          aria-label="Shared views"
          checked={enabled}
          disabled={saving}
          onCheckedChange={next => void save(next)}
        />
      </div>
    </div>
  )
}
