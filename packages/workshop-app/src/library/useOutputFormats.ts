import { useEffect, useState } from 'react'
import type { BlueprintOutput, OutputFormatOffer } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'

/**
 * The formats something new can be started as by asking for one by name: all but those whose
 * blueprint has something to set up first, which a message cannot do.
 */
export const startableFormats = (offers: OutputFormatOffer[]): BlueprintOutput[] =>
  offers.filter(({ requiresSetup }) => !requiresSetup).map(({ output }) => output)

/**
 * The formats the deployment offers to make something as (a Document, a Spreadsheet, …), in its
 * order: what the library can hold, whether or not it does yet, and what a new one can be started
 * as. None until they are loaded, and none if that fails, which is not said: there are then only
 * the types of what has been made. Not loaded unless `wanted`.
 */
export const useOutputFormats = (wanted = true): OutputFormatOffer[] => {
  const { api, reconnecting } = useApi()
  const [formats, setFormats] = useState<OutputFormatOffer[]>([])

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` loads it.
    if (!wanted || reconnecting) return
    let cancelled = false
    api.listOutputFormats().then(
      (offers) => {
        if (!cancelled) setFormats(offers)
      },
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [api, reconnecting, wanted])

  return formats
}
