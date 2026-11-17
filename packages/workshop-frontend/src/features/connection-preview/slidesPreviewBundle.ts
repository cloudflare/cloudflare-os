// The Google Slides preview as the kernel's buildUiBundle() hands it to the Workshop, for the
// tests that run it: each relative import rewritten to the key the page's import map resolves.

import type { UiBundle } from '@gadgets/workshop-shared/api'
import CLIENT from '../../../../gatekeeper-google/src/previews/slides/client.txt?raw'
import SLIDE from '../../../../gatekeeper-google/src/previews/slides/slide.txt?raw'
import SHAPES from '../../../../gatekeeper-google/src/previews/slides/shapes.txt?raw'
import CHROME from '../../../../gatekeeper-google/src/previews/shared/chrome.txt?raw'
import { keyed as keyedFor } from './previewBundle'

const keyed = (code: string, imports: string[]) => keyedFor('Google Slides', code, imports)

export const SLIDES_PREVIEW_BUNDLE: UiBundle = { modules: [
  { path: 'client.js', code: keyed(CLIENT, ['ui/chrome.js', 'slide.js']) },
  { path: 'slide.js', code: keyed(SLIDE, ['ui/chrome.js', 'shapes.js']) },
  { path: 'shapes.js', code: SHAPES },
  { path: 'ui/chrome.js', code: CHROME },
] }
