import type { BlueprintGadgetSummary } from '@gadgets/workshop-shared/api'

/** Where a gadget stands as a template: never published, published with changes since, or as it is. */
export type PublishState = 'unpublished' | 'changes' | 'published'

/**
 * Where a gadget stands, from the templates its workspace has published. The backend does not say
 * which gadget each is of, so a workspace that has published anything counts as published, and one
 * of its templates having changes to publish counts as changes.
 */
export const publishStateOf = (templates: readonly Pick<BlueprintGadgetSummary, 'unpublishedChanges'>[]): PublishState =>
  templates.length === 0 ? 'unpublished' : templates.some(({ unpublishedChanges }) => unpublishedChanges) ? 'changes' : 'published'
