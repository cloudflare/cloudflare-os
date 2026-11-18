import type { RefObject } from 'react'
import { DropdownMenu } from '@cloudflare/kumo'
import { MENU_ITEM } from '../../components/menuStyles'
import { useReportIssue, type ReportIssueContext } from './ReportIssueHost'

const HOME: ReportIssueContext = {}

/**
 * A menu's "Report issue" item. It asks the app's one dialog to open (see ReportIssueProvider)
 * with the context it was given, unchanged, and renders no dialog itself.
 */
export const ReportIssueItem = ({ context = HOME, opener }: {
  /** Where the menu is. Absent on the home page, which names no workspace. */
  context?: ReportIssueContext
  /** The trigger of the menu this item sits in, which takes focus when the dialog closes. */
  opener: RefObject<HTMLElement | null>
}) => {
  const reportIssue = useReportIssue()
  return (
    <DropdownMenu.Item onClick={() => reportIssue(context, opener.current)} className={MENU_ITEM}>
      Report issue
    </DropdownMenu.Item>
  )
}
