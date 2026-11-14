import { cn } from '@cloudflare/kumo/utils'

export type CodeBlockProps = {
  children: string
  /** Names the block for assistive technology, and is shown above it. */
  label?: string
  tone?: 'default' | 'danger'
  /** Show all of it instead of scrolling inside a capped box. */
  uncapped?: boolean
}

/** Literal text (code, output, a value) exactly as it is, scrolling inside its box when long. */
export const CodeBlock = ({ children, label, tone = 'default', uncapped }: CodeBlockProps) => (
  <figure className="flex min-w-0 flex-col gap-1">
    {label && <figcaption className="text-xs font-medium text-kumo-subtle">{label}</figcaption>}
    <pre
      // Focusable, so a keyboard user can scroll it.
      tabIndex={uncapped ? undefined : 0}
      aria-label={label}
      className={cn(
        'rounded-xl p-3 font-mono text-xs/5 break-words whitespace-pre-wrap',
        tone === 'danger' ? 'bg-kumo-danger-tint text-kumo-danger' : 'bg-kumo-tint text-kumo-default',
        !uncapped && 'max-h-56 overflow-auto',
      )}
    >
      {children}
    </pre>
  </figure>
)
