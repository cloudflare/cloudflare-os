// What the preview bundles beside this file share, for the tests that run them: a gatekeeper
// preview's module as the kernel's buildUiBundle() hands it to the Workshop, and a host to start
// one with.

import type { GadgetFocus } from '@gadgets/workshop-shared/api'
import { uiModuleKey } from '@gadgets/workshop-shared/ui-page'

type Navigate = (anchor: string) => boolean | Promise<boolean>

/**
 * A preview's host, as `main(gadget, host)` is handed one: it keeps each focus it is told, and
 * sends the preview to `at` as it registers, as the Workshop's host sends a frame to the spot it
 * was left at.
 */
export function previewHost(at?: string) {
  const said: (GadgetFocus | null)[] = []
  let registered: Navigate | undefined
  return {
    said,
    /** Sends the running preview to `anchor`, and resolves to whether it found the spot. */
    go: async (anchor: string) => registered!(anchor),
    host: {
      reportFocus: (focus: GadgetFocus | null) => void said.push(focus),
      onNavigate: async (navigate: Navigate) => {
        registered = navigate
        if (at !== undefined) await navigate(at)
      },
    },
  }
}

/** `code` of the `preview` named, each relative import in `imports` rewritten to the key the page's import map resolves. */
export function keyed(preview: string, code: string, imports: string[]) {
  return imports.reduce((keyedCode, path) => {
    const relative = `'./${path}'`
    if (!keyedCode.includes(relative)) throw new Error(`the ${preview} preview no longer imports ./${path}`)
    return keyedCode.replace(relative, `'${uiModuleKey(path)}'`)
  }, code)
}
