import { isRecord, stored } from './stored'

/** The file a save of a gadget's export last made in one of the user's accounts, which a later save can replace. */
export type SavedExport = { accountId: number; url: string; name: string }

const isSaved = (value: unknown): value is SavedExport =>
  isRecord(value) && typeof value.accountId === 'number' && typeof value.url === 'string' && typeof value.name === 'string'

// Any that are not what they should be are left out, rather than the rest with them.
const parse = (value: unknown): Record<string, SavedExport> | undefined =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, saved]) => isSaved(saved))) as Record<string, SavedExport> : undefined

const store = stored<Record<string, SavedExport>>('workshop-app:saved-exports', parse, {})

/**
 * The file last saved under `key` (see `savedExportKey`), on this device. The backend keeps no
 * record of what was saved where, so another browser has nothing to update, only new copies to
 * save, as the old app had.
 */
export const readSavedExport = (key: string): SavedExport | undefined => store.read()[key]

export const writeSavedExport = (key: string, saved: SavedExport) => store.write({ ...store.read(), [key]: saved })
