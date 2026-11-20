import { createContext, useContext, useSyncExternalStore } from 'react'
import type { PublicApi } from '@gadgets/workshop-shared/api'
import { sharedConnection } from './sharedConnection'

/** The public API's template read, also implemented by the scripted chats. */
export type TemplateReader = Pick<PublicApi, 'getBlueprint'>

/** Lets development previews read templates without opening a real backend connection. */
export const PublicApiContext = createContext<TemplateReader | null>(null)

const noSubscribe = () => () => {}
const NO_CONNECTION = { publicApi: null }
const noConnection = () => NO_CONNECTION

/** The supplied template reader, or the app's public API (null between connections). */
export const useTemplateReader = (): TemplateReader | null => {
  const given = useContext(PublicApiContext)
  const connection = given ? undefined : sharedConnection()
  const { publicApi } = useSyncExternalStore(connection?.subscribe ?? noSubscribe, connection?.getSnapshot ?? noConnection)
  return given ?? publicApi
}
