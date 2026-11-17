import { Fragment, useEffect, useState } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import type { CodeLanguage } from '@/files/codeLanguage'
import type { CodeToken, CodeTokenKind } from './highlightCode'

export type CodeViewProps = {
  text: string
  /** What it is written in; none is shown as plain text. */
  language?: CodeLanguage
  /** What the code is, as its region's name: "client.js". */
  label: string
  className?: string
}

const COLOURS: Record<CodeTokenKind, string> = {
  keyword: 'text-(--color-code-keyword)',
  string: 'text-(--color-code-string)',
  number: 'text-(--color-code-number)',
  name: 'text-(--color-code-name)',
  property: 'text-(--color-code-property)',
  comment: 'text-(--color-code-comment) italic',
  heading: 'font-semibold',
}

// Past this, a file is shown as plain text: parsing it would hold up the page for little.
const MOST_HIGHLIGHTED = 300_000

/**
 * Code to read, not to edit: line numbers in a gutter that stays put as the code scrolls across
 * under it, and the text as written, never wrapped, so that its indentation still says its shape.
 * It is shown plain at once and coloured once its language's parser has loaded (`highlightCode`,
 * fetched only then). Selecting and copying takes the code alone, never the numbers.
 */
export const CodeView = ({ text, language, label, className }: CodeViewProps) => {
  const [highlighted, setHighlighted] = useState<{ text: string; lines: CodeToken[][] }>()
  useEffect(() => {
    if (!language || text.length > MOST_HIGHLIGHTED) return
    let current = true
    void import('./highlightCode').then(({ highlightLines }) => {
      if (current) setHighlighted({ text, lines: highlightLines(text, language) })
    }, () => {})
    return () => { current = false }
  }, [text, language])

  // A trailing newline ends the last line rather than starting another.
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  const coloured = highlighted?.text === text ? highlighted.lines : undefined

  return (
    <div role="region" aria-label={label} tabIndex={0} className={cn('flex overflow-auto font-mono text-[13px]/5 outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-inset', className)}>
      <div aria-hidden="true" className="sticky start-0 shrink-0 bg-inherit py-4 ps-4 pe-4 text-end text-kumo-subtle/70 tabular-nums select-none">
        {lines.map((_, index) => <div key={index}>{index + 1}</div>)}
      </div>
      <pre className="min-w-fit flex-1 py-4 pe-6 text-kumo-default">
        <code>
          {/* One run of text, a newline between lines, so that a copy is the file as written. */}
          {lines.map((line, index) => (
            <Fragment key={index}>
              {coloured?.[index]
                ? coloured[index].map((token, at) => token.kind ? <span key={at} className={COLOURS[token.kind]}>{token.text}</span> : token.text)
                : line}
              {index < lines.length - 1 && '\n'}
            </Fragment>
          ))}
        </code>
      </pre>
    </div>
  )
}
