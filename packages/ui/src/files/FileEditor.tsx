import { cn } from '@cloudflare/kumo/utils'

export type FileEditorProps = {
  /** What is edited, as its name: "SKILL.md". */
  'aria-label': string
  /** What is written, as it stands. */
  value: string
  onValueChange: (value: string) => void
  /** It is only read. */
  readOnly?: boolean
  /** Asked for from the keyboard (Cmd or Ctrl with S), which is the editor's to hear. */
  onSave?: () => void
}

/**
 * A file's text, edited as it is written: one field in a fixed-width face, as tall as what is in
 * it, on a surface of its own. It knows nothing of what is written, and keeps nothing itself:
 * whoever shows it has the way to save, which Cmd or Ctrl with S also asks for.
 */
export const FileEditor = ({ 'aria-label': label, value, onValueChange, readOnly = false, onSave }: FileEditorProps) => (
  <textarea
    aria-label={label}
    value={value}
    readOnly={readOnly}
    spellCheck={false}
    autoCapitalize="off"
    autoCorrect="off"
    // Where `field-sizing` is not supported, as many lines as it has.
    rows={Math.max(value.split('\n').length + 1, 12)}
    onChange={(event) => onValueChange(event.target.value)}
    onKeyDown={(event) => {
      if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey)) return
      // The browser's own would save the page.
      event.preventDefault()
      onSave?.()
    }}
    className={cn(
      // 16px on a narrow screen: less, and iOS zooms the page in on it.
      'field-sizing-content min-h-64 w-full resize-none appearance-none rounded-3xl border-0 bg-kumo-tint px-5 py-4 font-mono text-sm leading-relaxed text-kumo-default outline-none max-md:text-[16px]',
      'focus-visible:ring-2 focus-visible:ring-kumo-focus',
      readOnly && 'text-kumo-subtle',
    )}
  />
)
