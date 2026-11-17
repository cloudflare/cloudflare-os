import { isRecord, stored } from './stored'

/**
 * How code was last looked at on this device: lines wrapped or not, a diff in one column or two,
 * and the list of files beside it open or put away. Kept for every gadget alike, as it is how the
 * reader likes code, not anything of one gadget's.
 */
export type CodePrefs = { wrap: boolean; diff: 'unified' | 'split'; files: boolean }

const DEFAULTS: CodePrefs = { wrap: false, diff: 'unified', files: true }

const parse = (value: unknown): CodePrefs | undefined =>
  isRecord(value)
    ? {
        wrap: value.wrap === true,
        diff: value.diff === 'split' ? 'split' : 'unified',
        files: value.files !== false,
      }
    : undefined

/** What is kept of how code is looked at. */
export const codePrefs = stored<CodePrefs>('workshop-app:code', parse, DEFAULTS)
