import { createFileRoute } from '@tanstack/react-router'
import GadgetEditor from '../GadgetEditor'

/** An app's settings (Figma "MacBook Pro 14\" - 27"): who can use it, publishing and deleting it. */
export const Route = createFileRoute('/workspace/$id_/app/$appId_/settings')({
  component: AppSettingsRoute,
})

function AppSettingsRoute() {
  const { appId } = Route.useParams()
  return <GadgetEditor page={{ kind: 'settings', appId: Number(appId) }} />
}
