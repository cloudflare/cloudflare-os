// The Google Doc preview as the kernel's buildUiBundle() hands it to the Workshop, for the tests
// that run it: each relative import rewritten to the key the page's import map resolves.

import type { UiBundle } from '@gadgets/workshop-shared/api'
import CLIENT from '../../../../gatekeeper-google/src/previews/docs/client.txt?raw'
import DRAW from '../../../../gatekeeper-google/src/previews/docs/draw.txt?raw'
import PAGES from '../../../../gatekeeper-google/src/previews/docs/pages.txt?raw'
import TEXT from '../../../../gatekeeper-google/src/previews/docs/text.txt?raw'
import CHROME from '../../../../gatekeeper-google/src/previews/shared/chrome.txt?raw'
import { keyed as keyedFor } from './previewBundle'

const keyed = (code: string, imports: string[]) => keyedFor('Google Doc', code, imports)

export const DOCS_PREVIEW_BUNDLE: UiBundle = { modules: [
  { path: 'client.js', code: keyed(CLIENT, ['ui/chrome.js', 'draw.js', 'pages.js', 'text.js']) },
  { path: 'draw.js', code: keyed(DRAW, ['ui/chrome.js']) },
  { path: 'pages.js', code: keyed(PAGES, ['ui/chrome.js']) },
  { path: 'text.js', code: TEXT },
  { path: 'ui/chrome.js', code: CHROME },
] }
