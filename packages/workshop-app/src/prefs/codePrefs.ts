import { isRecord, stored } from './stored'

/**
 * How code was last looked at on this device: lines wrapped or not, and the list of files beside
 * it open or put away. Kept for every gadget alike, as it is how the reader likes code, not
 * anything of one gadget's. A diff starts in one column each time, so is not kept.
 */
export type CodePrefs = { wrap: boolean; files: boolean }

const DEFAULTS: CodePrefs = { wrap: false, files: true }

const parse = (value: unknown): CodePrefs | undefined =>
  isRecord(value)
    ? {
        wrap: value.wrap === true,
        files: value.files !== false,
      }
    : undefined

/** What is kept of how code is looked at. */
export const codePrefs = stored<CodePrefs>('workshop-app:code', parse, DEFAULTS)
