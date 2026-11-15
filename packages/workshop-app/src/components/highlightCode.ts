import type { Parser } from '@lezer/common'
import { highlightCode, tagHighlighter, tags as t } from '@lezer/highlight'
import { parser as css } from '@lezer/css'
import { parser as html } from '@lezer/html'
import { parser as javascript } from '@lezer/javascript'
import { parser as json } from '@lezer/json'
import { parser as markdown } from '@lezer/markdown'
import type { CodeLanguage } from '@/files/codeLanguage'

/** What a run of code is, as far as its colour goes; none is the text colour. */
export type CodeTokenKind = 'keyword' | 'string' | 'number' | 'name' | 'property' | 'comment' | 'heading'

/** A run of one line's text, with what it is. */
export type CodeToken = { text: string; kind?: CodeTokenKind }

// Loaded with this module, only once a file is shown: the parsers are most of what it weighs.
const PARSERS: Record<CodeLanguage, Parser> = {
  javascript,
  jsx: javascript.configure({ dialect: 'jsx' }),
  typescript: javascript.configure({ dialect: 'ts' }),
  tsx: javascript.configure({ dialect: 'jsx ts' }),
  css,
  html,
  json,
  markdown,
}

// Each tag a parser marks a range with, as one of the few kinds there are colours for. A more
// specific tag is listed before the tag it refines, as the highlighter takes the first that fits.
const HIGHLIGHTER = tagHighlighter([
  { tag: [t.lineComment, t.blockComment, t.comment, t.docComment], class: 'comment' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.attributeValue], class: 'string' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color], class: 'number' },
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier, t.self, t.tagName], class: 'keyword' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName), t.className, t.typeName, t.labelName, t.namespace], class: 'name' },
  { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName)], class: 'property' },
  { tag: [t.heading, t.strong, t.emphasis, t.link, t.url, t.monospace], class: 'heading' },
])

/**
 * A file's text, line by line, as runs of what each part is (`CodeTokenKind`), parsed as
 * `language`. Every character is kept, so joining the runs, and the lines with newlines, gives the
 * text back.
 */
export const highlightLines = (text: string, language: CodeLanguage): CodeToken[][] => {
  const lines: CodeToken[][] = [[]]
  highlightCode(
    text,
    PARSERS[language].parse(text),
    HIGHLIGHTER,
    (run, classes) => {
      const kind = classes.split(' ')[0] as CodeTokenKind | ''
      lines[lines.length - 1].push(kind ? { text: run, kind } : { text: run })
    },
    () => lines.push([]),
  )
  return lines
}
