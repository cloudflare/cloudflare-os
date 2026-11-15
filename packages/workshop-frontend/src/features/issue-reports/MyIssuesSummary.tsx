import { useEffect } from 'react'
import { Badge } from '@cloudflare/kumo'
import { Lifebuoy } from '@phosphor-icons/react'
import SidebarItem from '../../components/AppShell/SidebarItem'
import { useIssueReportCount } from './useIssueReportCount'

const REFRESH_INTERVAL_MS = 60_000

/**
 * Navigation to the user's issue reports, with how many of them hold a reply from an admin they
 * have not seen. The count is read, not pushed: when the item mounts, when the window regains
 * focus, every minute while the document is visible, and when something that changes it asks.
 */
export const MyIssuesSummary = ({ collapsed }: { collapsed: boolean }) => {
  const { count, refresh } = useIssueReportCount()

  useEffect(() => {
    refresh()
    const refreshWhileVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    const timer = setInterval(refreshWhileVisible, REFRESH_INTERVAL_MS)
    return () => {
      window.removeEventListener('focus', refresh)
      clearInterval(timer)
    }
  }, [refresh])

  return (
    <SidebarItem
      to="/issues"
      label="My issues"
      icon={<Lifebuoy size={14} weight="regular" />}
      trailing={count > 0 ? (
        <span
          role="img"
          className="inline-flex shrink-0"
          aria-label={`${count} ${count === 1 ? 'issue has' : 'issues have'} a new reply`}
        >
          <Badge variant="blue">{count}</Badge>
        </span>
      ) : undefined}
      collapsed={collapsed}
    />
  )
}
