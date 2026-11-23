import { createFileRoute } from '@tanstack/react-router'
import GadgetEditor from '../GadgetEditor'

type GadgetSearch = {
  // The chat the user works in: never a spawned agent's chat.
  chat?: number
  // A spawned agent's chat, shown over `chat`. The gadget pane goes on following `chat`, since
  // nothing done in a gadget belongs to the agent.
  agent?: number
  // Selected workpiece (gadget) ID. Workpiece IDs start at 0, so parsing must not treat 0 as
  // absent.
  w?: number
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
    agent: parseIntParam(search.agent),
    w: parseIntParam(search.w),
    showChat: search.showChat === true || undefined,
  }),
})
