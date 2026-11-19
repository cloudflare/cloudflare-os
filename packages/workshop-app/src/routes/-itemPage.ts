import { notFound } from '@tanstack/react-router'
import { parseItemPageId } from '@/aside/asideItems'

const chatParam = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined)

/**
 * What an item's own page is, at `/app/<id>` or `/library/<id>` (`itemPage`): its id, and `?chat=`,
 * the chat it was opened from: the way back to it, and for a file what its bytes are fetched
 * through. An output is shown as it is kept, without the chat's changes. The frame lays it out
 * (`_app`), in the card it is shown in beside a chat, so that going from one to the other moves
 * nothing; the page itself has nothing else.
 *
 * Give each route a copy: a route keeps its id on the options it is made with.
 */
export const ITEM_PAGE = {
  params: {
    parse: ({ itemId }: { itemId: string }) => {
      if (!parseItemPageId(itemId)) throw notFound()
      return { itemId }
    },
    stringify: ({ itemId }: { itemId: string }) => ({ itemId }),
  },
  validateSearch: (search: Record<string, unknown>): { chat?: number } => ({ chat: chatParam(search.chat) }),
  component: () => null,
}
