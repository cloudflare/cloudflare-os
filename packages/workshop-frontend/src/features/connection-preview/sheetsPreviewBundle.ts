// The Google Sheets preview as the kernel's buildUiBundle() hands it to the Workshop, for the
// tests that run it: each relative import rewritten to the key the page's import map resolves.

import type { UiBundle } from '@gadgets/workshop-shared/api'
import CLIENT from '../../../../gatekeeper-google/src/previews/sheets/client.txt?raw'
import WINDOW from '../../../../gatekeeper-google/src/previews/sheets/window.txt?raw'
import CHROME from '../../../../gatekeeper-google/src/previews/shared/chrome.txt?raw'
import { keyed } from './previewBundle'

export const SHEETS_PREVIEW_BUNDLE: UiBundle = { modules: [
  { path: 'client.js', code: keyed('Google Sheets', CLIENT, ['ui/chrome.js', 'window.js']) },
  { path: 'window.js', code: WINDOW },
  { path: 'ui/chrome.js', code: CHROME },
] }
