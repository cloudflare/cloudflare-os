/** The languages a gadget's code is highlighted in, by what their files are called. */
export type CodeLanguage = 'javascript' | 'typescript' | 'jsx' | 'tsx' | 'css' | 'html' | 'json' | 'markdown'

const BY_EXTENSION: Record<string, CodeLanguage> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx',
  css: 'css',
  html: 'html', htm: 'html', svg: 'html',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown',
}

/** The language a file is written in, by its name's extension; undefined for one shown as plain text. */
export const codeLanguage = (path: string): CodeLanguage | undefined => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1).toLowerCase()] : undefined
}
