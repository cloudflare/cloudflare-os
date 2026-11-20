// The Google Sheets preview as the kernel's buildUiBundle() hands it to the Workshop, for the
// tests that run it: its relative import rewritten to the key the page's import map resolves.

import type { UiBundle } from '@gadgets/workshop-shared/api'
import { uiModuleKey } from '@gadgets/workshop-shared/ui-page'
import CLIENT from '../../../../gatekeeper-google/src/previews/sheets/client.txt?raw'
import CHROME from '../../../../gatekeeper-google/src/previews/shared/chrome.txt?raw'

const IMPORT = "'./ui/chrome.js'"
if (!CLIENT.includes(IMPORT)) throw new Error('the Google Sheets preview no longer imports ./ui/chrome.js')

export const SHEETS_PREVIEW_BUNDLE: UiBundle = { modules: [
  { path: 'client.js', code: CLIENT.replace(IMPORT, `'${uiModuleKey('ui/chrome.js')}'`) },
  { path: 'ui/chrome.js', code: CHROME },
] }
