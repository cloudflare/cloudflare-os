import type { ApplyBlueprintResult, GadgetClient, GadgetUpstream } from '@gadgets/workshop-shared/api'

/** A template's release as it now stands: its version, and the commit that version is, where it names one. */
export type TemplateRelease = { version: number; commitId?: string }

/**
 * Whether the template a gadget follows has a release it has not taken (`available`), or the one
 * it has is the latest (`upToDate`). Neither can be told, and nothing is said, for a template
 * stored before releases were commits, which names none, nor for a gadget made before gadgets
 * recorded the release they took: an update that may not exist is not offered as one.
 */
export const templateUpdateStatus = (upstream: GadgetUpstream | undefined, release: TemplateRelease | undefined): 'available' | 'upToDate' | undefined => {
  if (upstream?.commitId === undefined || release?.commitId === undefined) return undefined
  return release.commitId === upstream.commitId ? 'upToDate' : 'available'
}

/**
 * How asking for an update went (`GadgetClient.applyBlueprint()`): proposed in a new chat, which
 * is where it is tried and accepted; nothing proposed, and why; or it could not be asked.
 */
export type TemplateUpdateOutcome = ApplyBlueprintResult | { outcome: 'failed'; message: string }

/** The part of a workspace's Overseer an update uses, and the lease that must be disposed. */
export type UpdateOverseer = {
  getGadget(id: number): Pick<GadgetClient, 'applyBlueprint'> & Disposable
} & Disposable

/**
 * Asks for the latest release of `templateId` to be merged into the gadget, which is proposed in a
 * new chat and changes nothing until it is accepted there. `reviewer` is the model that makes sure
 * the gadget's own changes still work with it, or null for none; `allowUnrelated` merges into a
 * gadget that shares no history with it, once the user has been warned. The workspace is opened
 * for this alone, and let go after.
 */
export const proposeTemplateUpdate = async (
  open: () => UpdateOverseer,
  gadgetId: number,
  templateId: string,
  { reviewer, allowUnrelated = false }: { reviewer: string | null; allowUnrelated?: boolean },
): Promise<TemplateUpdateOutcome> => {
  let overseer: UpdateOverseer | undefined
  let gadget: (Pick<GadgetClient, 'applyBlueprint'> & Disposable) | undefined
  try {
    overseer = open()
    // Pipelined: the gadget is asked as it is reached.
    gadget = overseer.getGadget(gadgetId)
    return await gadget.applyBlueprint(templateId, { modelId: reviewer, ...(allowUnrelated ? { allowUnrelated } : {}) })
  } catch (error) {
    // What the server says is shown as it is: it is how the user learns, for one, that the gadget
    // changed while the update was worked out, which trying again cures.
    const message = error instanceof Error && error.message ? error.message : 'Something went wrong while preparing the update.'
    return { outcome: 'failed', message }
  } finally {
    gadget?.[Symbol.dispose]()
    overseer?.[Symbol.dispose]()
  }
}
