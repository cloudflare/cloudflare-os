import { useRef, useState } from 'react'
import { Button, Checkbox, Combobox, Select } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import type { AdminAccessExposure, AdminAuditKind } from '@gadgets/workshop-shared/api'
import {
  AUDIT_EXPOSURES,
  AUDIT_KINDS,
  AUDIT_METHOD_GROUPS,
  isFiltered,
  type AuditFilter,
  type AuditMethod,
} from './auditFilter'
import { KIND_NAMES } from './KindBadge'
import { TypedFilterField } from './TypedFilterField'

// The Action filter's choices: each group's methods, in alphabetical order, as Base UI groups them.
type ActionGroup = { value: string; items: AuditMethod[] }
const ACTION_GROUPS: ActionGroup[] =
  AUDIT_METHOD_GROUPS.map(({ label, methods }) => ({ value: label, items: methods.toSorted() }))

const ANY_KIND = 'any'
type KindChoice = AdminAuditKind | typeof ANY_KIND

const ANY_EXPOSURE = 'any'
type ExposureChoice = AdminAccessExposure | typeof ANY_EXPOSURE
const EXPOSURE_CHOICE_NAMES: Record<ExposureChoice, string> = {
  [ANY_EXPOSURE]: 'Anything',
  content: 'Content reads',
  metadata: 'Metadata only',
}

/**
 * The Audit tab's filters. The admin and the target user (the owner of a workspace an admin called
 * into, or the user whose account one inspected) are typed, with `adminSuggestions` and
 * `targetSuggestions` offered, and apply on Enter or once a suggestion is picked. The action is
 * searched by typing, and the kind and what a call exposed chosen; all three apply at once. Only a
 * call into a workspace can expose content, and a call into a user's account always exposed
 * metadata, so a choice of what was exposed lists access records alone. "Pending requests only"
 * lists the requests to read a workspace's content that an admin can still approve or deny, and is
 * offered when `offerPending` says requests can be made, or while it is set. The
 * workspace filter is set from a record's details in the log, and shows as a chip named
 * `workspaceLabel` that removes it.
 */
export const AuditFilters = ({
  filter, adminSuggestions, targetSuggestions, workspaceLabel, offerPending, onFilterChange,
}: {
  filter: AuditFilter
  adminSuggestions: string[]
  targetSuggestions: string[]
  /** What to call the filtered workspace: its title, or its id when no title is known. */
  workspaceLabel: string | undefined
  /** Whether content access can be requested and approved: the level in force is Content. */
  offerPending: boolean
  onFilterChange: (filter: AuditFilter) => void
}) => {
  // Kumo's Autocomplete hands out no ref to its input, so it is found through this wrapper: the
  // workspace chip and Clear filters remove themselves, and give focus to the admin field rather
  // than drop it.
  const adminField = useRef<HTMLDivElement>(null)
  // How many times every filter was cleared: text typed in the admin and owner fields and not
  // applied is cleared with them.
  const [clears, setClears] = useState(0)
  const showPending = offerPending || filter.pending === true
  const focusAdminField = () =>
    adminField.current?.querySelector<HTMLInputElement>('[role="combobox"]')?.focus()

  return (
    <div className="space-y-3" role="search" aria-label="Filter admin activity">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div ref={adminField} data-filter-field="admin">
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
        <Select<KindChoice>
          label="Kind"
          className="w-full"
          value={filter.kind ?? ANY_KIND}
          onValueChange={(kind) => {
            if (kind === null) return
            onFilterChange({ ...filter, kind: kind === ANY_KIND ? undefined : kind })
          }}
          renderValue={(kind) => kind === ANY_KIND ? 'Any kind' : KIND_NAMES[kind]}
        >
          <Select.Option value={ANY_KIND}>Any kind</Select.Option>
          {AUDIT_KINDS.map((kind) => (
            <Select.Option key={kind} value={kind}>{KIND_NAMES[kind]}</Select.Option>
          ))}
        </Select>
        <Select<ExposureChoice>
          label="Exposed"
          className="w-full"
          value={filter.exposed ?? ANY_EXPOSURE}
          onValueChange={(exposed) => {
            if (exposed === null) return
            onFilterChange({ ...filter, exposed: exposed === ANY_EXPOSURE ? undefined : exposed })
          }}
          renderValue={(exposed) => EXPOSURE_CHOICE_NAMES[exposed]}
        >
          <Select.Option value={ANY_EXPOSURE}>{EXPOSURE_CHOICE_NAMES[ANY_EXPOSURE]}</Select.Option>
          {AUDIT_EXPOSURES.map((exposed) => (
            <Select.Option key={exposed} value={exposed}>{EXPOSURE_CHOICE_NAMES[exposed]}</Select.Option>
          ))}
        </Select>
        <div data-filter-field="owner">
          <TypedFilterField
            label="Target user"
            placeholder="Any user (press Enter)"
            value={filter.owner}
            clears={clears}
            suggestions={targetSuggestions}
            onApply={(owner) => onFilterChange({ ...filter, owner })}
          />
        </div>
      </div>
      {/* Below the fields, which keep their width, with the chips that remove filters. */}
      {(showPending || isFiltered(filter)) && (
        <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2">
          {showPending && (
            <div data-filter-field="pending">
              <Checkbox
                label="Pending requests only"
                checked={filter.pending === true}
                onCheckedChange={(checked) => onFilterChange({ ...filter, pending: checked ? true : undefined })}
              />
            </div>
          )}
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
          {isFiltered(filter) && (
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
          )}
        </div>
      )}
    </div>
  )
}
