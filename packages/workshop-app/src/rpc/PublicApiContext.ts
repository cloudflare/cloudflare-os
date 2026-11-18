import { createContext, useContext, useSyncExternalStore } from 'react'
import type { BlueprintPublicInfo } from '@gadgets/workshop-shared/api'
import { sharedConnection } from './sharedConnection'

/** The part of the public API that reads a template, which anyone may (`PublicApi.getBlueprint()`). */
export type TemplateReader = { getBlueprint(id: string): Promise<BlueprintPublicInfo | null> }

/**
 * A public API to read templates from in place of the app's own connection's: the scripted chats'
 * fake, which has no backend to connect to.
 */
export const PublicApiContext = createContext<TemplateReader | null>(null)

const NOTHING = () => () => {}
const NO_CONNECTION = { publicApi: null }
const noConnection = () => NO_CONNECTION

/**
 * What reads a template: the one given (`PublicApiContext`), or else the app's own connection's,
 * which is null while it connects or connects again. Only the latter connects, so that a page
 * given its own opens nothing.
 */
export const useTemplateReader = (): TemplateReader | null => {
  const given = useContext(PublicApiContext)
  const connection = given ? undefined : sharedConnection()
  const { publicApi } = useSyncExternalStore(connection?.subscribe ?? NOTHING, connection?.getSnapshot ?? noConnection)
  return given ?? publicApi
}
