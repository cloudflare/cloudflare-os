import type { MessageFocus } from '@gadgets/workshop-shared/api'

/** A message's focus with the title of its gadget, as a focus chip draws it. */
export type TitledFocus = MessageFocus & { gadgetTitle: string }

/** A focus the composer offers a message. */
export type FocusOffer = {
  focus: TitledFocus
  /**
   * Changes with each new focus signal (the gadget selected, a spot other than the last reported,
   * a sent message's chip opened), so that dismissing the chip turns down only this focus. A repeat
   * report of the same spot, or a new frame restored to it, is the same offer.
   */
  offerId: number
}

/** What the workspace pane is showing, which the composer offers as a message's focus. */
export type PaneFocus = FocusOffer & {
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
export const focusForChat = (pane: PaneFocus | undefined, chatId: number | null): FocusOffer | undefined =>
  pane && (pane.pendingChatId === undefined || pane.pendingChatId === chatId) ? pane : undefined

/** The focus as the server takes it, without the title it stamps itself. */
export const messageFocusOf = ({ gadgetId, spot }: TitledFocus): MessageFocus =>
  spot ? { gadgetId, spot } : { gadgetId }
