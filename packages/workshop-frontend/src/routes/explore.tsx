import { createFileRoute } from '@tanstack/react-router'
import BlueprintsPage from '../BlueprintsPage'
import { useDocumentTitle } from '../useDocumentTitle'
import { useT } from '../i18n'

export const Route = createFileRoute('/explore')({
  component: ExplorePage,
})

function ExplorePage() {
  const t = useT()
  useDocumentTitle(t('explore.title'))

  return <BlueprintsPage />
}
