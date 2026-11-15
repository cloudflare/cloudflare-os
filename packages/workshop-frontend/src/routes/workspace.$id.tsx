import { createFileRoute } from '@tanstack/react-router'
import { MAX_FOCUS_ANCHOR_LENGTH } from '@gadgets/workshop-shared/api'
import GadgetEditor from '../GadgetEditor'

type GadgetSearch = {
  chat?: number
  // Selected workpiece (gadget) ID. Workpiece IDs start at 0, so parsing must not treat 0 as
  // absent.
  w?: number
  // The spot in that gadget the user is focused on, as its UI reported it (GadgetFocus.anchor).
  // Only the gadget interprets it, and it means nothing without `w`.
  at?: string
  // Show the chat even where the workspace pane hides it (a notification's "Open task" asks for
  // this). The editor drops it once honoured.
  showChat?: true
}

function parseIntParam(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) return parsed
  }
  return undefined
}

export const Route = createFileRoute('/workspace/$id')({
  component: GadgetEditor,
  validateSearch: (search: Record<string, unknown>): GadgetSearch => ({
    chat: typeof search.chat === 'number' ? search.chat
      : typeof search.chat === 'string' ? Number(search.chat) || undefined
      : undefined,
    w: parseIntParam(search.w),
    at: typeof search.at === 'string' && search.at.length <= MAX_FOCUS_ANCHOR_LENGTH ? search.at : undefined,
    showChat: search.showChat === true || undefined,
  }),
})
