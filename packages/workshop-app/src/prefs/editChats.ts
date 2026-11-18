import { isRecord, stored } from './stored'

// Any that are not chat ids are left out, rather than the rest with them.
const parse = (value: unknown): Record<string, number> | undefined =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, id]) => Number.isSafeInteger(id))) as Record<string, number> : undefined

const store = stored<Record<string, number>>('workshop-app:code-edit-chats', parse, {})

/**
 * The chat this device last made to save edits to a gadget's code from its own page, by the
 * gadget's key, for the next save there to go into, so that one session of edits is one chat.
 */
export const readEditChat = (key: string): number | undefined => store.read()[key]

export const writeEditChat = (key: string, chatId: number) => store.write({ ...store.read(), [key]: chatId })
