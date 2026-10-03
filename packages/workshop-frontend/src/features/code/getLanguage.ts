import type { Extension } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { java } from '@codemirror/lang-java'
import { yaml } from '@codemirror/lang-yaml'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { cpp } from '@codemirror/lang-cpp'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'

/**
 * Resolve a CodeMirror language extension from a filename's extension. Official language
 * packages where they exist, legacy stream modes for the tail, plain text (no extension) for
 * anything unrecognized.
 */
export function getLanguage(filename: string): Extension {
  const extension = filename.split('.').pop()?.toLowerCase()
  switch (extension) {
    case 'ts':
    case 'tsx':
      return javascript({ typescript: true, jsx: extension === 'tsx' })
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: extension === 'jsx' })
    case 'json':
      return json()
    case 'html':
      return html()
    case 'css':
      return css()
    case 'md':
      return markdown()
    case 'py':
      return python()
    case 'rs':
      return rust()
    case 'go':
      return go()
    case 'java':
      return java()
    case 'sh':
    case 'bash':
      return StreamLanguage.define(shell)
    case 'yaml':
    case 'yml':
      return yaml()
    case 'toml':
      return StreamLanguage.define(toml)
    case 'xml':
    case 'svg':
      return xml()
    case 'sql':
      return sql()
    case 'c':
    case 'h':
    case 'cpp':
    case 'cxx':
    case 'cc':
    case 'hpp':
      return cpp()
    default:
      // Includes the old Monaco set's graphql, which has no official CodeMirror package.
      return []
  }
}
