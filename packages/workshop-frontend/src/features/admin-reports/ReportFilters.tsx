import { useRef } from 'react'
import { Button, Select } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import {
  ISSUE_REPORT_PRIORITIES,
  ISSUE_REPORT_STATUSES,
  type IssueReportPriority,
  type IssueReportStatus,
} from '@gadgets/workshop-shared/api'
import { ADMIN_ISSUE_STATUS_NAMES, ISSUE_PRIORITY_NAMES } from '../issue-reports/issueLabels'
import { isFiltered, type ReportFilter } from './reportFilter'

const ANY = 'any'
type StatusChoice = IssueReportStatus | typeof ANY
type PriorityChoice = IssueReportPriority | typeof ANY

/**
 * The Reports tab's filters. The status and the priority are chosen, and apply at once. The
 * reporter and the workspace are set from a report's row in the list, and each shows as a chip
 * that removes it: the reporter's is named `reporterName`.
 */
export const ReportFilters = ({ filter, reporterName, onFilterChange }: {
  filter: ReportFilter
  /** What to call the reporter filtered by: their name, or their id when no name is known. */
  reporterName: string | undefined
  onFilterChange: (filter: ReportFilter) => void
}) => {
  // Kumo's Select hands out no ref to its trigger, so it is found through this wrapper: a chip and
  // Clear filters remove themselves, and give focus to the status filter rather than drop it.
  const statusField = useRef<HTMLDivElement>(null)
  const focusStatus = () => statusField.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus()

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2" role="search" aria-label="Filter issue reports">
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
