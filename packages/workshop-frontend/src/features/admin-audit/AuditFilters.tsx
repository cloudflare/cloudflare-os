import { useRef, useState } from 'react'
import { Button, Combobox, Select } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import {
  AUDIT_METHOD_GROUPS,
  AUDIT_SENSITIVITIES,
  isFiltered,
  type AuditFilter,
  type AuditMethod,
  type AuditSensitivity,
} from './auditFilter'
import { SENSITIVITY_NAMES } from './SensitivityBadge'
import { TypedFilterField } from './TypedFilterField'

// The Action filter's choices: each group's methods, in alphabetical order, as Base UI groups them.
type ActionGroup = { value: string; items: AuditMethod[] }
const ACTION_GROUPS: ActionGroup[] =
  AUDIT_METHOD_GROUPS.map(({ label, methods }) => ({ value: label, items: methods.toSorted() }))

const ANY_SENSITIVITY = 'any'
type SensitivityChoice = AuditSensitivity | typeof ANY_SENSITIVITY

/**
 * The Audit tab's filters. The admin and the target user (the owner of a workspace an admin called
 * into) are typed, with `adminSuggestions` and `targetSuggestions` offered, and apply on Enter or
 * once a suggestion is picked. The action is
 * searched by typing, and the sensitivity chosen; both apply at once. The workspace filter is set
 * from a record's details in the log, and shows as a chip named `workspaceLabel` that removes
 * it.
 */
export const AuditFilters = ({ filter, adminSuggestions, targetSuggestions, workspaceLabel, onFilterChange }: {
  filter: AuditFilter
  adminSuggestions: string[]
  targetSuggestions: string[]
  /** What to call the filtered workspace: its title, or its id when no title is known. */
  workspaceLabel: string | undefined
  onFilterChange: (filter: AuditFilter) => void
}) => {
  // Kumo's Autocomplete hands out no ref to its input, so it is found through this wrapper: the
  // workspace chip and Clear filters remove themselves, and give focus to the admin field rather
  // than drop it.
  const adminField = useRef<HTMLDivElement>(null)
  // How many times every filter was cleared: text typed in the admin and owner fields and not
  // applied is cleared with them.
  const [clears, setClears] = useState(0)
  const focusAdminField = () =>
    adminField.current?.querySelector<HTMLInputElement>('[role="combobox"]')?.focus()

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" role="search" aria-label="Filter admin activity">
        <div ref={adminField}>
          <TypedFilterField
            label="Admin"
            placeholder="Any admin (press Enter)"
            value={filter.admin}
            clears={clears}
            suggestions={adminSuggestions}
            onApply={(admin) => onFilterChange({ ...filter, admin })}
          />
        </div>
        <Combobox
          label="Action"
          items={ACTION_GROUPS}
          value={filter.method ?? null}
          onValueChange={(method) => onFilterChange({ ...filter, method: (method as AuditMethod | null) ?? undefined })}
        >
          <Combobox.TriggerInput placeholder="Search actions…" clearLabel="Any action" />
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
        <Select<SensitivityChoice>
          label="Sensitivity"
          className="w-full"
          value={filter.sensitivity ?? ANY_SENSITIVITY}
          onValueChange={(sensitivity) => {
            if (sensitivity === null) return
            onFilterChange({ ...filter, sensitivity: sensitivity === ANY_SENSITIVITY ? undefined : sensitivity })
          }}
          renderValue={(sensitivity) => sensitivity === ANY_SENSITIVITY ? 'Any sensitivity' : SENSITIVITY_NAMES[sensitivity]}
        >
          <Select.Option value={ANY_SENSITIVITY}>Any sensitivity</Select.Option>
          {AUDIT_SENSITIVITIES.map((sensitivity) => (
            <Select.Option key={sensitivity} value={sensitivity}>{SENSITIVITY_NAMES[sensitivity]}</Select.Option>
          ))}
        </Select>
        <TypedFilterField
          label="Target user"
          placeholder="Any user (press Enter)"
          value={filter.owner}
          clears={clears}
          suggestions={targetSuggestions}
          onApply={(owner) => onFilterChange({ ...filter, owner })}
        />
      </div>
      {isFiltered(filter) && (
        <div className="flex flex-wrap items-center gap-2">
          {filter.workspace !== undefined && (
            <Button
              variant="secondary"
              size="sm"
              icon={X}
              aria-label={`Show every workspace, not only ${workspaceLabel ?? filter.workspace}`}
              onClick={() => {
                onFilterChange({ ...filter, workspace: undefined })
                focusAdminField()
              }}
            >
              <span className="max-w-64 truncate">Workspace: {workspaceLabel ?? filter.workspace}</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon={X}
            onClick={() => {
              setClears((n) => n + 1)
              onFilterChange({})
              focusAdminField()
            }}
          >
            Clear filters
          </Button>
        </div>
      )}
    </div>
  )
}
