import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BlueprintPublicInfo } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import { useTemplateReader } from '@/rpc/PublicApiContext'
import { TemplateStore } from './TemplateStore'

/** The one store, so that the templates' page and a template's own show the same, stars and all. */
export const templateStore = new TemplateStore()

/**
 * The templates there are to start something from, and the ids of the starred ones, in their
 * order, kept over the backend connection there is: again over a new one, with what was read
 * before shown meanwhile.
 */
export const useTemplates = () => {
  const { api, reconnecting } = useApi()
  // Over a lost connection it could only fail; the new connection's `api` reads them.
  useEffect(() => {
    if (!reconnecting) templateStore.connect(api)
  }, [api, reconnecting])
  return { state: useSyncExternalStore(templateStore.subscribe, templateStore.getSnapshot), setStars: templateStore.setStars, reload: templateStore.reload }
}

/** What there is of a blueprint that is not among the templates listed, as one whose link was shared. */
export type SharedTemplateState = { status: 'loading' } | { status: 'gone' } | { status: 'failed'; message: string } | { status: 'ready'; info: BlueprintPublicInfo }

/**
 * A blueprint's own public record (`getBlueprint`), read once `wanted`, for one the user has not
 * saved and the deployment does not feature, which knowing its id is enough to read. Key whatever
 * uses it by the id.
 */
export const useSharedTemplate = (id: string, wanted: boolean): SharedTemplateState => {
  const publicApi = useTemplateReader()
  const [state, setState] = useState<SharedTemplateState>({ status: 'loading' })
  useEffect(() => {
    if (!wanted || !publicApi) return
    let current = true
    publicApi.getBlueprint(id).then(
      (info) => {
        if (current) setState(info ? { status: 'ready', info } : { status: 'gone' })
      },
      (error: unknown) => {
        if (current) setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      current = false
    }
  }, [id, wanted, publicApi])
  return state
}
