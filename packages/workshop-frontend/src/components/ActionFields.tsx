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
const codeClass = 'rounded bg-kumo-tint px-1 py-0.5 font-mono text-[12px] leading-[18px] text-kumo-default break-all'
const blockClass = 'm-0 max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-default whitespace-pre-wrap break-words'

const Placeholder = ({ children }: { children: string }) => (
  <span className={`${captionClass} italic`}>{children}</span>
)

const Captions = ({ captions }: { captions: string[] }) =>
  captions.length > 0 && <p className={`m-0 mt-1 ${captionClass}`}>{captions.join(' · ')}</p>

const formatSize = (size: number) => {
  const bytes = `${size} byte${size === 1 ? '' : 's'}`
  return size < 1024 ? bytes : `${formatAttachmentSize(size)} (${bytes})`
}

const FieldValue = ({ field }: { field: ActionField }) => {
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
          <pre className={blockClass}>{field.value}</pre>
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
          <p className="m-0 break-all text-[13px] font-medium leading-[18px] text-kumo-default">{field.name}</p>
          <p className={`m-0 mt-0.5 break-all ${captionClass}`}>
            {field.mediaType} · {formatSize(field.size)}
          </p>
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
 * value's safety must not depend on how it would parse.
 */
export const ActionFields = ({ fields, className = '' }: { fields: ActionField[], className?: string }) => {
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
                <FieldValue field={field} />
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
