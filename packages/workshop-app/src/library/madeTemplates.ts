import type { BlueprintGadgetSummary } from '@gadgets/workshop-shared/api'
import type { MadeTemplate } from '@/blocks/CreateTemplateDialog'

/**
 * The templates made from a workspace's gadgets, as they are listed: what each has to release is
 * the backend's `unpublishedChanges`, which goes by the files and the bindings of the gadget each
 * was made from.
 */
export const madeTemplatesOf = (summaries: readonly Pick<BlueprintGadgetSummary, 'id' | 'title' | 'description' | 'version' | 'unpublishedChanges'>[]): MadeTemplate[] =>
  summaries.map(({ id, title, description, version, unpublishedChanges }) => ({ id, title, description, version, ...(unpublishedChanges ? { changes: unpublishedChanges } : {}) }))
