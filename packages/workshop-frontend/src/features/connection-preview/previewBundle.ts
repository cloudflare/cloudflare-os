// What the preview bundles beside this file share: a gatekeeper preview's module as the kernel's
// buildUiBundle() hands it to the Workshop, for the tests that run it.

import { uiModuleKey } from '@gadgets/workshop-shared/ui-page'

/** `code` of the `preview` named, each relative import in `imports` rewritten to the key the page's import map resolves. */
export function keyed(preview: string, code: string, imports: string[]) {
  return imports.reduce((keyedCode, path) => {
    const relative = `'./${path}'`
    if (!keyedCode.includes(relative)) throw new Error(`the ${preview} preview no longer imports ./${path}`)
    return keyedCode.replace(relative, `'${uiModuleKey(path)}'`)
  }, code)
}
