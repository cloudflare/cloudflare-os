import { useState } from 'react'
import { Button, Switch, TagInput, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AdminApi } from '@gadgets/workshop-shared/api'
import { rpcFailureDescription } from '../../rpcErrors'

/** What `webFetch` may still reach once a workspace has observed restricted data. */
export const RestrictedWebFetchCard = ({ admin, hosts, onSaved, approvals, onApprovalsSaved }: {
  admin: RpcStub<AdminApi>
  /** What the server holds. */
  hosts: string[]
  /** Receives the list as the server stored it. */
  onSaved: (hosts: string[]) => void
  /** Whether users may approve other URLs, as the server holds it. */
  approvals: boolean
  onApprovalsSaved: (enabled: boolean) => void
}) => {
  // The list being edited, or null while the field shows the server's list.
  const [draft, setDraft] = useState<string[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [savingApprovals, setSavingApprovals] = useState(false)
  const toasts = useKumoToastManager()
  const changed = draft !== null && draft.join('\n') !== hosts.join('\n')

  const save = async () => {
    if (draft === null) return
    setSaving(true)
    try {
      onSaved(await admin.setRestrictedWebFetchHosts(draft))
      setDraft(null)
      toasts.add({ title: 'Trusted hosts saved', variant: 'success' })
    } catch (err) {
      toasts.add({
        title: 'Failed to save trusted hosts',
        description: rpcFailureDescription(err),
        variant: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const saveApprovals = async (enabled: boolean) => {
    setSavingApprovals(true)
    try {
      await admin.setRestrictedWebFetchApprovals(enabled)
      onApprovalsSaved(enabled)
    } catch (err) {
      toasts.add({
        title: 'Failed to save the approval setting',
        description: rpcFailureDescription(err),
        variant: 'error',
      })
    } finally {
      setSavingApprovals(false)
    }
  }

  return (
    <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
      <h2 className="text-lg font-semibold text-kumo-strong mb-1">Web fetch in restricted workspaces</h2>
      <p className="text-sm text-kumo-subtle mb-5">
        Once a workspace reads data a connector marks as restricted, its agent can fetch web pages
        without asking only from these hosts, and only URLs without a query string. Add a host only
        if everyone who can see requests to it may see that data: whoever reads its logs, analytics
        and caches, and anything it forwards requests to.
      </p>

      <TagInput
        label="Trusted hosts"
        description="Exact host names, such as docs.example.com. A subdomain needs its own entry."
        placeholder="docs.example.com"
        autoComplete="off"
        value={draft ?? hosts}
        onValueChange={setDraft}
        disabled={saving}
      />

      <div className="flex items-center justify-end gap-2 mt-3">
        {changed && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={saving}>
            Reset
          </Button>
        )}
        <Button variant="primary" size="sm" onClick={save} loading={saving} disabled={!changed}>
          Save
        </Button>
      </div>

      <div className="flex items-center gap-4 mt-5 pt-5 border-t border-kumo-line">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-kumo-strong">Let users approve other URLs</p>
          <p className="text-sm text-kumo-subtle mt-0.5">
            The agent asks before fetching any other URL, and the user who approves it vouches that
            the URL holds none of that data. People approve most prompts they see, so leave this off
            unless users need pages you can&rsquo;t list. With it off and no hosts, those workspaces
            can&rsquo;t fetch at all.
          </p>
        </div>
        <Switch
          aria-label="Let users approve other URLs"
          checked={approvals}
          disabled={savingApprovals}
          onCheckedChange={enabled => void saveApprovals(enabled)}
        />
      </div>
    </div>
  )
}
