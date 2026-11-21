import { useRef } from 'react'
import { Button, Select } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import {
  ISSUE_REPORT_PRIORITIES,
  ISSUE_REPORT_STATUSES,
  type IssueReportPriority,
  type IssueReportStatus,
  type NamedUser,
} from '@gadgets/workshop-shared/api'
import { ADMIN_ISSUE_STATUS_NAMES, ISSUE_PRIORITY_NAMES } from '../issue-reports/issueLabels'
import { isFiltered, type ReportFilter } from './reportFilter'

const ANY = 'any'
type StatusChoice = IssueReportStatus | typeof ANY
type PriorityChoice = IssueReportPriority | typeof ANY
// Who holds the reports listed: anyone, the admin reading the list, nobody, or the one admin a
// row or the URL named, which the select shows and does not offer. That admin is the reader
// themselves until `me` is known, so the choice's name does not say whose reports they are.
type AssigneeChoice = typeof ANY | 'me' | 'nobody' | 'named'
const ASSIGNEE_CHOICES: Record<AssigneeChoice, string> = {
  any: 'Anyone', me: 'Me', nobody: 'Nobody', named: 'One admin',
}

/**
 * The Reports tab's filters. The status, the priority and the assignee are chosen, and apply at
 * once: the assignee is anyone, the admin reading the list once `me` is known, or nobody. The
 * reporter, the workspace and another admin as the assignee are set from a report's row in the
 * list, and each shows as a chip that removes it: the reporter's is named `reporterName` and the
 * assignee's `assigneeName`. Only reports one admin holds and only reports nobody holds are one
 * choice of two: making either unmakes the other.
 */
export const ReportFilters = ({ filter, me, reporterName, assigneeName, onFilterChange }: {
  filter: ReportFilter
  /** The admin reading the list, once known. */
  me: NamedUser | undefined
  /** What to call the reporter filtered by: their name, or their id when no name is known. */
  reporterName: string | undefined
  /** What to call the assignee filtered by: their name, or their id when no name is known. */
  assigneeName: string | undefined
  onFilterChange: (filter: ReportFilter) => void
}) => {
  // Kumo's Select hands out no ref to its trigger, so it is found through this wrapper: a chip and
  // Clear filters remove themselves, and give focus to the status filter rather than drop it.
  const statusField = useRef<HTMLDivElement>(null)
  const focusStatus = () => statusField.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus()

  const assignee: AssigneeChoice = filter.unassigned ? 'nobody'
    : filter.assignee === undefined ? ANY
    : filter.assignee === me?.id ? 'me' : 'named'

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3" role="search" aria-label="Filter issue reports">
        <div ref={statusField}>
          <Select<StatusChoice>
            label="Status"
            className="w-full"
            value={filter.status ?? ANY}
            onValueChange={(status) => {
              if (status === null) return
              onFilterChange({ ...filter, status: status === ANY ? undefined : status })
            }}
            renderValue={(status) => status === ANY ? 'Any status' : ADMIN_ISSUE_STATUS_NAMES[status]}
          >
            <Select.Option value={ANY}>Any status</Select.Option>
            {ISSUE_REPORT_STATUSES.map((status) => (
              <Select.Option key={status} value={status}>{ADMIN_ISSUE_STATUS_NAMES[status]}</Select.Option>
            ))}
          </Select>
        </div>
        <Select<PriorityChoice>
          label="Priority"
          className="w-full"
          value={filter.priority ?? ANY}
          onValueChange={(priority) => {
            if (priority === null) return
            onFilterChange({ ...filter, priority: priority === ANY ? undefined : priority })
          }}
          renderValue={(priority) => priority === ANY ? 'Any priority' : ISSUE_PRIORITY_NAMES[priority]}
        >
          <Select.Option value={ANY}>Any priority</Select.Option>
          {ISSUE_REPORT_PRIORITIES.map((priority) => (
            <Select.Option key={priority} value={priority}>{ISSUE_PRIORITY_NAMES[priority]}</Select.Option>
          ))}
        </Select>
        <div data-filter-field="assignee">
          <Select<AssigneeChoice>
            label="Assignee"
            className="w-full"
            value={assignee}
            onValueChange={(choice) => {
              if (choice === null || choice === 'named') return
              onFilterChange({
                ...filter,
                assignee: choice === 'me' ? me?.id : undefined,
                unassigned: choice === 'nobody' ? true : undefined,
              })
            }}
            renderValue={(choice) => ASSIGNEE_CHOICES[choice]}
          >
            <Select.Option value={ANY}>{ASSIGNEE_CHOICES.any}</Select.Option>
            {me !== undefined && <Select.Option value="me">{ASSIGNEE_CHOICES.me}</Select.Option>}
            <Select.Option value="nobody">{ASSIGNEE_CHOICES.nobody}</Select.Option>
          </Select>
        </div>
      </div>
      {isFiltered(filter) && (
        <div className="flex flex-wrap items-center gap-2">
          {filter.reporter !== undefined && (
            <Button
              variant="secondary"
              size="sm"
              icon={X}
              data-filter-chip="reporter"
              aria-label={`Show every reporter, not only ${reporterName ?? filter.reporter}`}
              onClick={() => {
                onFilterChange({ ...filter, reporter: undefined })
                focusStatus()
              }}
            >
              <span className="max-w-64 truncate">Reporter: {reporterName ?? filter.reporter}</span>
            </Button>
          )}
          {filter.workspace !== undefined && (
            <Button
              variant="secondary"
              size="sm"
              icon={X}
              data-filter-chip="workspace"
              aria-label={`Show every workspace, not only ${filter.workspace}`}
              onClick={() => {
                onFilterChange({ ...filter, workspace: undefined })
                focusStatus()
              }}
            >
              <span className="max-w-64 truncate">Workspace: {filter.workspace}</span>
            </Button>
          )}
          {assignee === 'named' && (
            <Button
              variant="secondary"
              size="sm"
              icon={X}
              data-filter-chip="assignee"
              aria-label={`Show every assignee, not only ${assigneeName ?? filter.assignee}`}
              onClick={() => {
                onFilterChange({ ...filter, assignee: undefined })
                focusStatus()
              }}
            >
              <span className="max-w-64 truncate">Assignee: {assigneeName ?? filter.assignee}</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon={X}
            onClick={() => {
              onFilterChange({})
              focusStatus()
            }}
          >
            Clear filters
          </Button>
        </div>
      )}
    </div>
  )
}
