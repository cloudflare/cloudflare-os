import { cn } from '@cloudflare/kumo/utils'
import { CodeBlock } from '@/components/CodeBlock'

/**
 * One value a gatekeeper attached to an action or a read. `truncated` says the value shown is not
 * the whole of it; `shownBytes` of 0 that it was left out altogether.
 */
export type ActionField = { label: string; truncated?: { shownBytes: number; totalBytes: number } } & (
  | { kind: 'inline'; value: string }
  | { kind: 'text'; value: string; syntax?: 'markdown' | 'html' | 'sql' }
  | { kind: 'json'; value: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'file'; name: string; mediaType: string; size: number; sha256?: string; origin: 'provider' | 'agent' }
)

export type ActionFieldsProps = {
  fields: ActionField[]
  /** Show long values in full, for an approval that must be read without scrolling inner boxes. */
  uncapped?: boolean
  className?: string
}

const SYNTAX = { markdown: 'Markdown', html: 'HTML', sql: 'SQL' } as const

const CAPTION = 'text-xs text-kumo-subtle'
// Values keep every space and tab as sent: runs of whitespace are part of what will be written.
const INLINE = 'rounded-md bg-kumo-tint px-1.5 py-0.5 font-mono text-xs/5 break-all whitespace-pre-wrap text-kumo-default'

// Characters that render as nothing or reorder the text around them: controls, and
// default-ignorables such as zero-width spaces and bidi overrides, which can make
// `invoice\u202Efdp.exe` read as `invoiceexe.pdf`.
// oxlint-disable-next-line no-control-regex -- matching exactly these characters is the point
const UNDISPLAYABLE = /[\u0000-\u001F\u007F-\u009F\p{Default_Ignorable_Code_Point}]/gu

const hasUndisplayable = (text: string) => text.search(UNDISPLAYABLE) !== -1

/** A name as sent. One with a character that would not show is written as an escaped string instead. */
const exactName = (text: string) =>
  hasUndisplayable(text)
    ? JSON.stringify(text).replace(UNDISPLAYABLE, (character) =>
        Array.from({ length: character.length }, (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`).join(''))
    : text

const formatSize = (size: number) => {
  const bytes = `${size.toLocaleString('en')} ${size === 1 ? 'byte' : 'bytes'}`
  if (size < 1024) return bytes
  const units = ['KB', 'MB', 'GB']
  let value = size / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]} (${bytes})`
}

const Empty = ({ children }: { children: string }) => <span className={cn(CAPTION, 'italic')}>{children}</span>

const FieldValue = ({ field, uncapped }: { field: ActionField; uncapped?: boolean }) => {
  switch (field.kind) {
    case 'inline':
      return field.value === '' ? <Empty>(empty)</Empty> : <code className={INLINE}>{field.value}</code>
    case 'text':
    case 'json': {
      if (field.value === '') return <Empty>(empty)</Empty>
      const notes = [
        field.kind === 'json' ? 'JSON' : field.syntax && SYNTAX[field.syntax],
        // A CR renders as nothing, so each CRLF would otherwise read as a plain line break.
        field.value.includes('\r\n') && 'CRLF line breaks',
      ].filter(Boolean)
      return (
        <>
          <CodeBlock uncapped={uncapped}>{field.value}</CodeBlock>
          {notes.length > 0 && <p className={cn(CAPTION, 'mt-1')}>{notes.join(' · ')}</p>}
        </>
      )
    }
    case 'list':
      if (field.items.length === 0) return <Empty>(none)</Empty>
      return (
        <ul className="flex flex-col items-start gap-1">
          {field.items.map((item, index) => (
            <li key={index} className="max-w-full"><code className={INLINE}>{item}</code></li>
          ))}
        </ul>
      )
    case 'file':
      return (
        <div className="flex flex-col gap-0.5 rounded-xl bg-kumo-tint px-3 py-2">
          <span className="text-sm font-medium break-all whitespace-pre-wrap text-kumo-default">{exactName(field.name)}</span>
          <span className={cn(CAPTION, 'break-all')}>{exactName(field.mediaType)} · {formatSize(field.size)}</span>
          {(hasUndisplayable(field.name) || hasUndisplayable(field.mediaType)) && (
            <span className={CAPTION}>Shown escaped: contains invisible characters</span>
          )}
          {field.sha256 && <span className={cn(CAPTION, 'font-mono break-all')}>SHA-256 {field.sha256}</span>}
          {field.origin === 'agent' && <span className="text-xs text-kumo-warning">Contents not shown</span>}
        </div>
      )
  }
}

/**
 * The values someone reviews, after the description's prose. Every value is shown as literal text
 * and never as Markdown: it is exactly what will be written, and must not depend on how it parses.
 */
export const ActionFields = ({ fields, uncapped, className }: ActionFieldsProps) =>
  fields.length > 0 && (
    <dl className={cn('flex flex-col gap-3', className)}>
      {fields.map((field, index) => (
        <div key={index} className="flex min-w-0 flex-col gap-1">
          <dt className="text-xs font-medium text-kumo-subtle">{field.label}</dt>
          <dd className="min-w-0">
            {field.truncated?.shownBytes === 0 ? (
              <Empty>Omitted: description limit reached</Empty>
            ) : (
              <>
                <FieldValue field={field} uncapped={uncapped} />
                {field.truncated && (
                  <p className={cn(CAPTION, 'mt-1')}>
                    Showing {field.truncated.shownBytes.toLocaleString('en')} of {field.truncated.totalBytes.toLocaleString('en')} bytes
                  </p>
                )}
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
