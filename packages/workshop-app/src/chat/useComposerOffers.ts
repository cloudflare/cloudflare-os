import { useMemo } from 'react'
import type { ComposerAddOffer } from '@/blocks/composerAddEntries'
import { addableServices, type AddableService } from '@/connections/connectionChoices'
import { useConnections } from '@/connections/useConnections'
import { useHandler } from '@/hooks/useHandler'
import { useOutputFormats } from '@/library/useOutputFormats'
import { useTemplates } from '@/library/useTemplates'
import { composerOffers } from './composerOffers'
import type { StartFormat } from './startWithFormat'

/**
 * What a chat's + menu offers besides uploading and the skills (`composerOffers`): the formats
 * and the templates, read only once `wanted`, as the composer is first pointed at or written in,
 * and, where the viewer builds in the chat's workspace (`builds`), the services to connect
 * something of and setting up an automation, which writes the start of the request (`onDraft`). The same list until
 * what it is read from changes, for a composer that is drawn again far less often than its chat.
 */
export const useComposerOffers = ({ wanted, builds, onConnect, onStartWith, onDraft }: {
  wanted: boolean
  builds: boolean
  onConnect: (service: AddableService) => void
  onStartWith: (start: StartFormat) => void
  onDraft: (text: string) => void
}): ComposerAddOffer[] => {
  const { state: connections } = useConnections()
  const formats = useOutputFormats(wanted)
  const { state: templates } = useTemplates(wanted)
  const connect = useHandler(onConnect)
  const startWith = useHandler(onStartWith)
  const draft = useHandler(onDraft)
  const services = useMemo(() => (connections.status === 'ready' ? addableServices(connections.connections) : []), [connections])
  return useMemo(() => composerOffers({
    formats,
    templates: templates.status === 'ready' ? templates.templates : [],
    stars: templates.status === 'ready' ? templates.stars : [],
    services,
    onStartWith: startWith,
    onConnect: builds ? connect : undefined,
    onDraft: builds ? draft : undefined,
  }), [formats, templates, services, builds, connect, startWith, draft])
}
