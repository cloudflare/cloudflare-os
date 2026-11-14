import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { BlueprintPublicInfo, BlueprintSource } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import { sharedConnection } from '@/rpc/sharedConnection'
import { blueprintEntries, type BlueprintEntry } from './blueprintEntries'

export type BlueprintsState =
  | { status: 'loading' }
  | { status: 'ready'; entries: BlueprintEntry[] }
  | { status: 'failed'; message: string; retry: () => void }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The public API, where a blueprint's own record is read (`getBlueprint`), or null between connections. */
export const usePublicApi = () => {
  const connection = sharedConnection()
  return useSyncExternalStore(connection.subscribe, connection.getSnapshot).publicApi
}

/**
 * Every blueprint the user can find in their Library (`blueprintEntries`): those the deployment
 * features, those they saved or uploaded, and those they published, each of those read from its
 * public record for its picture. Read when mounted and over each new connection, keeping what was
 * read meanwhile, and again on `reread`, as after one is saved.
 */
export const useBlueprints = () => {
  const { api, reconnecting } = useApi()
  const publicApi = usePublicApi()
  const [state, setState] = useState<BlueprintsState>({ status: 'loading' })
  // Bumped to read it again.
  const [attempt, setAttempt] = useState(0)
  const reread = useCallback(() => setAttempt((count) => count + 1), [])

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` reads it.
    if (reconnecting) return
    let current = true
    const read = async () => {
      const [featured, library, published] = await Promise.all([api.listFeaturedBlueprints(), api.listLibraryBlueprints(), api.listOwnBlueprints()])
      // Its picture only, which it is listed without when its record cannot be read.
      const recordOf = (id: string): Promise<BlueprintPublicInfo | null> => publicApi ? publicApi.getBlueprint(id).catch(() => null) : Promise.resolve(null)
      const own = await Promise.all(published.map(async (summary) => ({ summary, info: await recordOf(summary.id) })))
      return blueprintEntries({ featured, library, own })
    }
    read().then(
      (entries) => {
        if (current) setState({ status: 'ready', entries })
      },
      (error: unknown) => {
        if (!current) return
        setState({
          status: 'failed',
          message: messageOf(error),
          retry: () => {
            setState({ status: 'loading' })
            reread()
          },
        })
      },
    )
    return () => {
      current = false
    }
  }, [api, publicApi, reconnecting, attempt, reread])

  /** Saves a blueprint to the Library, or takes it out (deleting one the user uploaded), then reads them again. */
  const setSaved = useCallback(async (id: string, saved: boolean) => {
    await (saved ? api.addBlueprintToLibrary(id) : api.removeBlueprintFromLibrary(id))
    reread()
  }, [api, reread])

  /** Uploads a blueprint's file (`.gadget`, from Download), resolving to the blueprint it became. */
  const upload = useCallback(async (file: File) => {
    const id = await api.importBlueprint(file.stream())
    reread()
    return id
  }, [api, reread])

  return { state, setSaved, upload, reread }
}

/** One blueprint, as its page shows it, with how the user has it. */
export type BlueprintRecord = BlueprintPublicInfo & {
  /** In the user's Library: saved, or uploaded by them. */
  saved?: { uploaded: boolean }
  /** The user published it: where from, with the workspace where that is still there. */
  source?: Exclude<BlueprintSource, { type: 'imported' }>
}

export type BlueprintState =
  | { status: 'loading' }
  | { status: 'gone' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; blueprint: BlueprintRecord }

/**
 * One blueprint (`getBlueprint`), with whether the user has it in their Library and whether they
 * published it, and from where. Read when mounted and over each new connection; `setSaved` saves it or takes it
 * out, shown at once and put back, with why, if the server refuses.
 */
export const useBlueprint = (id: string) => {
  const { api, reconnecting } = useApi()
  const publicApi = usePublicApi()
  const [state, setState] = useState<BlueprintState>({ status: 'loading' })

  useEffect(() => {
    if (reconnecting || !publicApi) return
    let current = true
    Promise.all([publicApi.getBlueprint(id), api.isBlueprintInLibrary(id), api.getOwnBlueprint(id)]).then(
      ([info, saved, own]) => {
        // One the user added rather than published is theirs only as saved.
        const source = own && own.source.type !== 'imported' ? own.source : undefined
        if (current) setState(info ? { status: 'ready', blueprint: { ...info, saved: saved ?? undefined, source } } : { status: 'gone' })
      },
      (error: unknown) => {
        if (current) setState({ status: 'failed', message: messageOf(error) })
      },
    )
    return () => {
      current = false
    }
  }, [api, publicApi, reconnecting, id])

  const setSaved = useCallback(async (saved: boolean) => {
    const mark = (next: { uploaded: boolean } | undefined) =>
      setState((current) => (current.status === 'ready' ? { ...current, blueprint: { ...current.blueprint, saved: next } } : current))
    mark(saved ? { uploaded: false } : undefined)
    try {
      await (saved ? api.addBlueprintToLibrary(id) : api.removeBlueprintFromLibrary(id))
    } catch (error) {
      mark(saved ? undefined : { uploaded: false })
      throw error
    }
  }, [api, id])

  return { state, setSaved }
}
