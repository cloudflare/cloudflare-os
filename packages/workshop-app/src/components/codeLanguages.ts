import type { LanguageSupport } from '@codemirror/language'
import type { CodeLanguage } from '@/files/codeLanguage'

// Each loaded when a file in it is first shown: the parsers are most of what the editor weighs.
const LOADERS: Record<CodeLanguage, () => Promise<LanguageSupport>> = {
  javascript: () => import('@codemirror/lang-javascript').then(({ javascript }) => javascript()),
  jsx: () => import('@codemirror/lang-javascript').then(({ javascript }) => javascript({ jsx: true })),
  typescript: () => import('@codemirror/lang-javascript').then(({ javascript }) => javascript({ typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then(({ javascript }) => javascript({ jsx: true, typescript: true })),
  css: () => import('@codemirror/lang-css').then(({ css }) => css()),
  html: () => import('@codemirror/lang-html').then(({ html }) => html()),
  json: () => import('@codemirror/lang-json').then(({ json }) => json()),
  markdown: () => import('@codemirror/lang-markdown').then(({ markdown }) => markdown()),
}

const loaded = new Map<CodeLanguage, Promise<LanguageSupport>>()
const ready = new Map<CodeLanguage, LanguageSupport>()

/** The editor's support for a language: its parser, folding and indentation. Loaded once. */
export const loadCodeLanguage = (language: CodeLanguage): Promise<LanguageSupport> => {
  let support = loaded.get(language)
  if (!support) {
    support = LOADERS[language]()
    loaded.set(language, support)
    support.then((found) => ready.set(language, found), () => loaded.delete(language))
  }
  return support
}

/** The support for a language once it has loaded, to start an editor coloured; none before. */
export const loadedCodeLanguage = (language: CodeLanguage): LanguageSupport | undefined => ready.get(language)

/** What a language is called, as the editor's status line names it. */
export const CODE_LANGUAGE_NAMES: Record<CodeLanguage, string> = {
  javascript: 'JavaScript',
  jsx: 'JavaScript JSX',
  typescript: 'TypeScript',
  tsx: 'TypeScript JSX',
  css: 'CSS',
  html: 'HTML',
  json: 'JSON',
  markdown: 'Markdown',
}
