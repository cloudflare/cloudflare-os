import type { ActionField } from '@gadgets/workshop-shared/gatekeeper'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { formatAttachmentSize } from '../features/chat/attachmentFormatting'

/** The typed values an entry's gatekeeper attached to its description; hooks carry none. */
export function entryFields(entry: ActionLogEntry): ActionField[] {
  return ('fields' in entry.description && entry.description.fields) || []
}

/** A compact count for surfaces that show the prose but leave the fields to a fuller view. */
export function fieldCountLabel(count: number): string {
  return `${count} field${count === 1 ? '' : 's'}`
}

const SYNTAX_LABELS = { markdown: 'Markdown', html: 'HTML', sql: 'SQL' } as const

const captionClass = 'text-[11.5px] leading-4 tracking-[-0.1px] text-kumo-inactive'
// Values keep every space and tab as sent: the kit marks a list item or file name complete with
// runs of spaces, tabs or edge whitespace in it, which HTML's default white-space would collapse.
const exactClass = 'whitespace-pre-wrap break-all'
const codeClass = `rounded bg-kumo-tint px-1 py-0.5 font-mono text-[12px] leading-[18px] text-kumo-default ${exactClass}`
const blockClass = 'm-0 rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-default whitespace-pre-wrap break-words'

const Placeholder = ({ children }: { children: string }) => (
  <span className={`${captionClass} italic`}>{children}</span>
)

const Captions = ({ captions }: { captions: string[] }) =>
  captions.length > 0 && <p className={`m-0 mt-1 ${captionClass}`}>{captions.join(' · ')}</p>

// Characters that render as nothing, or reorder the text around them: controls, and default-
// ignorables such as zero-width spaces and bidi overrides, which can make `invoice\u202Efdp.exe`
// read as `invoiceexe.pdf`.
// oxlint-disable-next-line no-control-regex -- matching exactly these characters is the point
const UNDISPLAYABLE = /[\u0000-\u001F\u007F-\u009F\p{Default_Ignorable_Code_Point}]/u
// oxlint-disable-next-line no-control-regex -- as above
const UNDISPLAYABLE_GLOBAL = /[\u0000-\u001F\u007F-\u009F\p{Default_Ignorable_Code_Point}]/gu

/**
 * A file name or media type exactly as sent. The kit shows such a value as data rather than
 * rerouting it, so one with an undisplayable character is shown as an escaped JSON string instead.
 */
const ExactName = ({ text, className = '' }: { text: string, className?: string }) => {
  if (!UNDISPLAYABLE.test(text)) return <span className={`${className} ${exactClass}`}>{text}</span>
  // `JSON.stringify` escapes C0 controls but not C1 or the default-ignorables; an astral match
  // (a tag character) is escaped as its surrogate pair.
  const escaped = JSON.stringify(text).replace(UNDISPLAYABLE_GLOBAL, c =>
    Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''))
  return <span className={`${className} ${exactClass} font-mono`}>{escaped}</span>
}

const formatSize = (size: number) => {
  const bytes = `${size} byte${size === 1 ? '' : 's'}`
  return size < 1024 ? bytes : `${formatAttachmentSize(size)} (${bytes})`
}

const FieldValue = ({ field, uncapped }: { field: ActionField, uncapped?: boolean }) => {
  switch (field.kind) {
    case 'inline':
      return field.value === ''
        ? <Placeholder>(empty)</Placeholder>
        : <code className={codeClass}>{field.value}</code>
    case 'text':
    case 'json': {
      if (field.value === '') return <Placeholder>(empty)</Placeholder>
      const syntax = field.kind === 'json' ? 'JSON' : field.syntax && SYNTAX_LABELS[field.syntax]
      return (
        <>
          <pre className={`${blockClass} ${uncapped ? '' : 'max-h-56 overflow-auto'}`}>{field.value}</pre>
          <Captions
            captions={[
              ...(syntax ? [syntax] : []),
              // A CR renders as nothing, so each CRLF would otherwise read as a plain line break.
              ...(field.value.includes('\r\n') ? ['CRLF line breaks'] : []),
            ]}
          />
        </>
      )
    }
    case 'list':
      if (field.items.length === 0) return <Placeholder>(none)</Placeholder>
      return (
        <ul className="m-0 flex list-none flex-col items-start gap-1 p-0">
          {field.items.map((item, index) => (
            <li key={index} className="max-w-full"><code className={codeClass}>{item}</code></li>
          ))}
        </ul>
      )
    case 'file':
      return (
        <div className="rounded-xl border border-kumo-line/70 bg-kumo-base px-3 py-2">
          <p className="m-0">
            <ExactName text={field.name} className="text-[13px] font-medium leading-[18px] text-kumo-default" />
          </p>
          <p className={`m-0 mt-0.5 break-all ${captionClass}`}>
            <ExactName text={field.mediaType} /> · {formatSize(field.size)}
          </p>
          {(UNDISPLAYABLE.test(field.name) || UNDISPLAYABLE.test(field.mediaType)) && (
            <p className={`m-0 mt-0.5 ${captionClass}`}>Shown escaped: contains invisible characters</p>
          )}
          {field.sha256 && (
            <p className={`m-0 mt-0.5 break-all font-mono ${captionClass}`}>SHA-256 {field.sha256}</p>
          )}
          {field.origin === 'agent' && (
            <p className="m-0 mt-1 text-[12px] leading-4 text-kumo-warning">Contents not shown</p>
          )}
        </div>
      )
  }
}

/**
 * The values an approver reviews, shown after the description's prose. Every value renders as
 * literal text, never as Markdown: the gatekeeper sends exactly what the action will write, and a
 * value's safety must not depend on how it would parse. `uncapped` drops the height cap on long
 * values, for approvals that must be read in full without scrolling an inner box.
 */
export const ActionFields = ({ fields, uncapped, className = '' }: {
  fields: ActionField[], uncapped?: boolean, className?: string,
}) => {
  if (fields.length === 0) return null
  return (
    <dl className={`m-0 flex flex-col gap-2.5 ${className}`}>
      {fields.map((field, index) => (
        <div key={index} className="min-w-0">
          <dt className="mb-1 text-[12px] font-semibold leading-4 text-kumo-default">{field.label}</dt>
          <dd className="m-0 min-w-0">
            {field.truncated?.shownBytes === 0 ? (
              <Placeholder>Omitted: description limit reached</Placeholder>
            ) : (
              <>
                <FieldValue field={field} uncapped={uncapped} />
                {field.truncated && (
                  <p className={`m-0 mt-1 ${captionClass}`}>
                    Showing {field.truncated.shownBytes} of {field.truncated.totalBytes} bytes
                  </p>
                )}
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}
