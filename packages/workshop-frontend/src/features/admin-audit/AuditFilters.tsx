import { useRef, useState, type KeyboardEvent } from 'react'
import { Autocomplete, Button, Combobox } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import { AUDIT_METHOD_GROUPS, type AuditFilter, type AuditMethod } from './auditFilter'

// The Action filter's choices: each group's methods, in alphabetical order, as Base UI groups them.
type ActionGroup = { value: string; items: AuditMethod[] }
const ACTION_GROUPS: ActionGroup[] =
  AUDIT_METHOD_GROUPS.map(({ label, methods }) => ({ value: label, items: methods.toSorted() }))

/**
 * The Audit tab's filters. The admin is typed (the deployment's admins are listed nowhere), with
 * `adminSuggestions` offered as the field is typed in, and applies on Enter or once a suggestion is
 * picked. The action is searched by typing, and applies as soon as it is chosen; clearing it shows
 * every action.
 */
export const AuditFilters = ({ filter, adminSuggestions, onFilterChange }: {
  filter: AuditFilter
  adminSuggestions: string[]
  onFilterChange: (filter: AuditFilter) => void
}) => {
  // What is typed in the admin field, for the admin filter it was typed over. Dropped as soon as the
  // filter changes from elsewhere (an admin's name picked in the log), during that render, so the
  // field shows the new filter and coming back to the old one does not bring back what was typed.
  const [typed, setTyped] = useState({ over: filter.admin, text: filter.admin ?? '' })
  if (typed.over !== filter.admin) setTyped({ over: filter.admin, text: filter.admin ?? '' })
  const adminText = typed.over === filter.admin ? typed.text : (filter.admin ?? '')

  const applyAdmin = (text: string) => {
    const admin = text.trim()
    setTyped({ over: admin || undefined, text: admin })
    onFilterChange({ ...filter, admin: admin || undefined })
  }
  // Enter applies what is typed. Base UI gives the Autocomplete and the Select hidden text inputs of
  // their own, and a form of several text inputs and no submit button is never submitted by Enter,
  // so the key is handled here. While a suggestion is highlighted, Enter picks it instead.
  const applyOnEnter = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    if (event.target instanceof HTMLElement && event.target.getAttribute('aria-activedescendant')) return
    event.preventDefault()
    applyAdmin(adminText)
  }
  const filtered = filter.admin !== undefined || filter.method !== undefined
  // Kumo's Autocomplete hands out no ref to its input, so it is found through this wrapper: Clear
  // filters removes itself, and gives focus to the admin field rather than drop it.
  const adminField = useRef<HTMLDivElement>(null)

  return (
    <div className="flex flex-wrap items-end gap-3" role="search" aria-label="Filter admin activity">
      <div ref={adminField} className="w-full sm:w-72" onKeyDown={applyOnEnter}>
        <Autocomplete<string>
          label="Admin"
          items={adminSuggestions}
          value={adminText}
          onValueChange={(text, { reason }) => {
            setTyped({ over: filter.admin, text })
            if (reason === 'item-press') applyAdmin(text)
          }}
        >
          <Autocomplete.InputGroup placeholder="Any admin (press Enter to filter)" />
          <Autocomplete.Content>
            <Autocomplete.List>
              {(admin: string) => (
                <Autocomplete.Item key={admin} value={admin}>{admin}</Autocomplete.Item>
              )}
            </Autocomplete.List>
          </Autocomplete.Content>
        </Autocomplete>
      </div>
      <div className="w-full sm:w-80">
        <Combobox
          label="Action"
          items={ACTION_GROUPS}
          value={filter.method ?? null}
          onValueChange={(method) => onFilterChange({ ...filter, method: (method as AuditMethod | null) ?? undefined })}
        >
          <Combobox.TriggerInput placeholder="Any action (type to search)" clearLabel="Any action" />
          <Combobox.Content>
            <Combobox.Empty>No action matches.</Combobox.Empty>
            <Combobox.List>
              {(group: ActionGroup) => (
                <Combobox.Group key={group.value} items={group.items}>
                  <Combobox.GroupLabel>{group.value}</Combobox.GroupLabel>
                  <Combobox.Collection>
                    {(method: AuditMethod) => (
                      <Combobox.Item key={method} value={method}>
                        <span className="font-mono text-xs">{method}</span>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Content>
        </Combobox>
      </div>
      {filtered && (
        <Button
          variant="ghost"
          icon={X}
          onClick={() => {
            setTyped({ over: undefined, text: '' })
            onFilterChange({})
            adminField.current?.querySelector<HTMLInputElement>('[role="combobox"]')?.focus()
          }}
        >
          Clear filters
        </Button>
      )}
    </div>
  )
}
