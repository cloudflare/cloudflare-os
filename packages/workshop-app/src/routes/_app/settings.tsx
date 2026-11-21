import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { SettingsPane } from '@/settings/SettingsPane'
import { isSettingsSection, type SettingsSection } from '@/settings/settingsSections'

/**
 * The user's settings, in parts: `?section=` names the one showing. Beside a sidebar the parts
 * are chosen there (`_app`); this is how a narrow screen goes into one from the list, and back.
 */
export const Route = createFileRoute('/_app/settings')({
  validateSearch: (search: Record<string, unknown>): { section?: SettingsSection } => ({
    section: isSettingsSection(search.section) ? search.section : undefined,
  }),
  component: Settings,
})

function Settings() {
  const { section } = Route.useSearch()
  const navigate = useNavigate()
  const router = useRouter()

  return (
    <SettingsPane
      section={section}
      onSectionChange={(next) => {
        if (next === undefined) {
          // Back to the list of the parts: where this part was gone into from, if it was.
          if (router.state.location.state.settingsPartOpenedHere) return router.history.back()
          return void navigate({ to: '/settings', replace: true, state: true })
        }
        // A part is gone into from the list, so going back is to the list.
        void navigate({ to: '/settings', search: { section: next }, state: { settingsPartOpenedHere: true } })
      }}
      sectionHref={(id) => router.buildLocation({ to: '/settings', search: { section: id } }).href}
    />
  )
}
