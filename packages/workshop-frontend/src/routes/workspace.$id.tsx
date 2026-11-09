import { createFileRoute } from '@tanstack/react-router'
import GadgetEditor from '../GadgetEditor'
import type { WorkspaceTab } from '../pages/workspace/WorkspacePage'
import type { ChatDetailsTab } from '../pages/chat-details/ChatDetailsPage'

type GadgetSearch = {
  chat?: number
  // Selected workpiece (gadget) ID. Workpiece IDs start at 0, so parsing must not treat 0 as
  // absent.
  w?: number
  // Show the chat even where the workspace pane hides it (a notification's "Open task" asks for
  // this). The editor drops it once honoured.
  showChat?: true
  // The workspace overview's tab, shown when no chat is selected.
  tab?: WorkspaceTab
  // The selected chat's details page (Figma "MacBook Pro 14\" - 6"), open at this tab.
  details?: ChatDetailsTab
}

const WORKSPACE_TABS: readonly WorkspaceTab[] = ['chats', 'library', 'automations', 'members', 'activity']
const DETAILS_TABS: readonly ChatDetailsTab[] = ['library', 'automations', 'connections', 'activity', 'settings']

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
    showChat: search.showChat === true || undefined,
    tab: WORKSPACE_TABS.find(tab => tab === search.tab),
    details: DETAILS_TABS.find(tab => tab === search.details),
  }),
})
