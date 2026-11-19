import { applyCodeChange, diffFiles, requireTextFiles, type CodeChange } from '@gadgets/workshop-shared/code-change'

/** Files of one gadget, by path. */
export type Files = Record<string, string>

const contentOf = (gadgetId: number, files: Files) => new Map([[gadgetId, new Map(Object.entries(files))]])

/** The change that takes gadget `gadgetId`'s files from `before` to `after`. */
export const changeOf = (gadgetId: number, before: Files, after: Files): CodeChange =>
  diffFiles(contentOf(gadgetId, before), contentOf(gadgetId, after))

/** Gadget `gadgetId`'s files once `change` is applied to `files`. */
export const applied = (gadgetId: number, files: Files, change: CodeChange): Files =>
  Object.fromEntries(requireTextFiles(applyCodeChange(contentOf(gadgetId, files), change).get(gadgetId) ?? new Map()))
