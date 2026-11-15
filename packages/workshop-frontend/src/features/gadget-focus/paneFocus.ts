import type { MessageFocus } from '@gadgets/workshop-shared/api'

/** A message's focus with the title of its gadget, as a focus chip draws it. */
export type TitledFocus = MessageFocus & { gadgetTitle: string }

/** What the workspace pane is showing, which the composer offers as a message's focus. */
export type PaneFocus = {
  focus: TitledFocus
  /** The chat the gadget is still pending in, if it hasn't been accepted. */
  pendingChatId: number | undefined
}

/** "Budget", or "Budget › Q3 › cell B7" when the gadget's UI reported a spot. */
export const focusLabel = ({ gadgetTitle, spot }: TitledFocus) =>
  spot ? `${gadgetTitle} › ${spot.label}` : gadgetTitle

/**
 * The focus a message to `chatId` (null: a new chat) may carry. The server refuses a whole message
 * whose focus names a gadget still pending in another chat, so that focus is not offered at all.
 */
export const focusForChat = (pane: PaneFocus | undefined, chatId: number | null) =>
  pane && (pane.pendingChatId === undefined || pane.pendingChatId === chatId) ? pane.focus : undefined

/** The focus as the server takes it, without the title it stamps itself. */
export const messageFocusOf = ({ gadgetId, spot }: TitledFocus): MessageFocus =>
  spot ? { gadgetId, spot } : { gadgetId }
