import { useState, type FormEvent } from 'react'
import { Delete02Icon, PlusSignIcon } from '@/components/icons'
import { Button, CardAction, LIST_ACTION, ON_SETTINGS_CARD, SettingRow, SettingsCard, SettingsGroup, Switch, TextField } from '@gadgets/ui'

export type RestrictedWebFetchProps = {
  /** The hosts it may reach, as the server keeps them. */
  hosts: string[]
  /** Keeps another list of hosts, resolving to whether it was kept: what is written stays until it is. */
  onHostsChange: (hosts: string[]) => Promise<boolean>
  /** Whether people may let it reach any other address, one at a time. */
  approvals: boolean
  onApprovalsChange: (enabled: boolean) => void
}

/**
 * What a workspace's agent may still fetch from the web once it has read data a service marks as
 * restricted: a list of hosts, each taken out while pointed at, with the way to add one across
 * from the title, which opens a field under them; and whether people may let it fetch from any
 * other, an address at a time.
 */
export const RestrictedWebFetch = ({ hosts, onHostsChange, approvals, onApprovalsChange }: RestrictedWebFetchProps) => {
  // Open while a host is being written, and what is written of it.
  const [draft, setDraft] = useState<string>()
  const [pending, setPending] = useState(false)

  const keep = async (next: string[]) => {
    setPending(true)
    const kept = await onHostsChange(next)
    setPending(false)
    return kept
  }

  const add = async (event: FormEvent) => {
    event.preventDefault()
    const host = draft?.trim().toLowerCase()
    if (!host) return
    if (hosts.includes(host) || await keep([...hosts, host])) setDraft(undefined)
  }

  return (
    <SettingsGroup
      title="Web fetch in restricted workspaces"
      description="Once a workspace reads data a service marks as restricted, its agent fetches pages without asking only from these hosts, and only addresses without a query. Add a host only if everyone who can see requests to it may see that data."
      action={<Button icon={PlusSignIcon} disabled={draft !== undefined} onClick={() => setDraft('')}>Add host</Button>}
      plain
    >
      <SettingsCard>
        {hosts.length === 0 && draft === undefined && <p className="py-4 text-kumo-subtle">No hosts. Without any, and without approvals, those workspaces can’t fetch at all.</p>}
        {hosts.length > 0 && (
          <ul aria-label="Trusted hosts" className="flex flex-col">
            {hosts.map((host) => (
              <li key={host} className="group flex items-center gap-3 border-t border-kumo-line py-2 first:border-t-0">
                <p className="min-w-0 flex-1 py-2 leading-snug wrap-anywhere text-kumo-default">{host}</p>
                <CardAction>
                  <Button variant="ghost" icon={Delete02Icon} aria-label={`Remove ${host}`} title="Remove" disabled={pending} onClick={() => void keep(hosts.filter((other) => other !== host))} className={LIST_ACTION} />
                </CardAction>
              </li>
            ))}
          </ul>
        )}
        {/* Under the hosts, where the one written is then listed. */}
        {draft !== undefined && (
          <form onSubmit={(event) => void add(event)} className={hosts.length > 0 ? 'flex flex-col gap-3 border-t border-kumo-line py-4' : 'flex flex-col gap-3 py-4'}>
            <TextField
              aria-label="New trusted host"
              placeholder="docs.example.com"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={draft}
              readOnly={pending}
              onValueChange={setDraft}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setDraft(undefined)
              }}
            />
            <p className="text-sm text-kumo-subtle">An exact host name. A subdomain needs one of its own.</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(undefined)} className={ON_SETTINGS_CARD}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={!draft.trim() || pending}>Add</Button>
            </div>
          </form>
        )}
      </SettingsCard>
      <SettingsCard>
        <SettingRow
          title="Let people approve other addresses"
          description="The agent asks before fetching from anywhere else, and whoever approves it vouches that the address holds none of that data. People approve most of what they are asked, so leave this off unless they need pages you can’t list."
        >
          <Switch aria-label="Let people approve other addresses" checked={approvals} onCheckedChange={onApprovalsChange} />
        </SettingRow>
      </SettingsCard>
    </SettingsGroup>
  )
}
