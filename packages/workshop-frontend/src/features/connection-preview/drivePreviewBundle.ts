// A Google Drive connection's preview as the kernel's buildUiBundle() hands it to the Workshop,
// for the tests that run it: its entry, and beside it the previews of the three kinds of file,
// each client under its kind's name.

import type { UiBundle } from '@gadgets/workshop-shared/api'
import ENTRY from '../../../../gatekeeper-google/src/previews/drive/client.txt?raw'
import { DOCS_PREVIEW_BUNDLE } from './docsPreviewBundle'
import { keyed } from './previewBundle'
import { SHEETS_PREVIEW_BUNDLE } from './sheetsPreviewBundle'
import { SLIDES_PREVIEW_BUNDLE } from './slidesPreviewBundle'

const KINDS = { docs: DOCS_PREVIEW_BUNDLE, sheets: SHEETS_PREVIEW_BUNDLE, slides: SLIDES_PREVIEW_BUNDLE }
// By path, as the three share ui/chrome.js.
const modules = new Map(Object.entries(KINDS).flatMap(([kind, bundle]) =>
  ('modules' in bundle ? bundle.modules : []).map(({ path, code }) =>
    [path === 'client.js' ? `${kind}.js` : path, code] as const)))

export const DRIVE_PREVIEW_BUNDLE: UiBundle = { modules: [
  { path: 'client.js', code: keyed('Google Drive', ENTRY, ['docs.js', 'sheets.js', 'slides.js', 'ui/chrome.js']) },
  ...Array.from(modules, ([path, code]) => ({ path, code })),
] }
