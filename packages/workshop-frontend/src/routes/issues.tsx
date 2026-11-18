import { createFileRoute } from '@tanstack/react-router'
import { MyIssues } from '../features/issue-reports/MyIssues'
import { useDocumentTitle } from '../useDocumentTitle'

type IssuesSearch = {
  /** The issue report that is open. */
  report?: string
}

const MyIssuesPage = () => {
  const { report } = Route.useSearch()
  useDocumentTitle('My issues')
  return <MyIssues reportId={report} />
}

export const Route = createFileRoute('/issues')({
  component: MyIssuesPage,
  // The router reads a search value as JSON where it can, so an id made of digits is a number.
  validateSearch: (search: Record<string, unknown>): IssuesSearch => ({
    report: typeof search.report === 'string' && search.report !== ''
      ? search.report
      : typeof search.report === 'number' ? String(search.report) : undefined,
  }),
})
