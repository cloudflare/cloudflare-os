import { createFileRoute } from '@tanstack/react-router'
import GadgetEditor from '../GadgetEditor'

/** An app on its own, full screen (Figma "MacBook Pro 14\" - 24"); the link an app's pane copies. */
export const Route = createFileRoute('/workspace/$id_/app/$appId')({
  component: SharedAppRoute,
})

function SharedAppRoute() {
  const { appId } = Route.useParams()
  return <GadgetEditor page={{ kind: 'app', appId: Number(appId) }} />
}
