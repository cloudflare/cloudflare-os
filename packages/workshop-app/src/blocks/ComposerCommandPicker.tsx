import { useEffect, useRef } from 'react'
import { ArrowsInLineVerticalIcon, ScrollIcon, type Icon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'

/** Something the composer can send in place of words alone: a skill, or a built-in command. */
export type ComposerCommand = {
  /** Which it is, among the composer's commands. */
  key: string
  /** As typed after the slash: `meeting-brief`. */
  name: string
  /** In plain words: "Meeting Brief". */
  title: string
  description: string
  /** A skill the agent follows, or a command of the app's own such as Compact. */
  kind: 'skill' | 'builtin'
  /** Where it is kept, such as its collection, for whoever wants to know. */
  source?: string
}

export type ComposerCommandPickerProps = {
  commands: readonly ComposerCommand[]
  /** The one Enter would choose. */
  highlighted: number
  onHighlight: (index: number) => void
  onChoose: (command: ComposerCommand) => void
  /** Ties the list to the message field that drives it (`aria-controls`). */
  id: string
}

/** A command's glyph: a skill's scroll, or what a built-in does. */
export const commandGlyph = (command: Pick<ComposerCommand, 'kind' | 'name'>): Icon =>
  command.kind === 'builtin' && command.name === 'compact' ? ArrowsInLineVerticalIcon : ScrollIcon

/** A command's glyph, drawn. */
export const CommandIcon = ({ command, className }: { command: Pick<ComposerCommand, 'kind' | 'name'>; className?: string }) => {
  const Glyph = commandGlyph(command)
  return <Glyph aria-hidden="true" className={className} />
}

/**
 * The commands that fit what was typed after a slash, over the composer, as a menu is drawn: each
 * by its name in plain words and what it is for. The message field keeps the focus and drives it
 * (the arrow keys, Enter or Tab to choose, Escape to put it away), so typing goes on into the
 * draft; a click chooses too.
 */
export const ComposerCommandPicker = ({ commands, highlighted, onHighlight, onChoose, id }: ComposerCommandPickerProps) => {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${highlighted}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])

  return (
    <div className="appears absolute inset-x-0 bottom-full z-20 mb-2">
      <div
        ref={listRef}
        id={id}
        role="listbox"
        aria-label="Skills and commands"
        className="max-h-72 overflow-y-auto overscroll-contain rounded-[21px] bg-kumo-base p-1.5 shadow-[0_12px_40px_rgb(0_0_0/0.12)] ring-1 ring-kumo-contrast/6"
      >
        {commands.map((command, index) => (
          <div
            key={command.key}
            id={`${id}-${index}`}
            data-index={index}
            role="option"
            aria-selected={index === highlighted}
            title={command.source ? `${command.title} · ${command.source}` : command.title}
            // Chosen before the field loses the focus, which it keeps.
            onPointerDown={(event) => event.preventDefault()}
            onPointerMove={() => index !== highlighted && onHighlight(index)}
            onClick={() => onChoose(command)}
            className={cn('flex cursor-pointer items-center gap-3 rounded-2xl px-3 py-2 text-base/5 text-kumo-default', index === highlighted && 'bg-kumo-tint')}
          >
            <CommandIcon command={command} className="size-4 shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{command.title}</span>
              <span className="truncate text-sm text-kumo-subtle">{command.description}</span>
            </span>
            <span className="shrink-0 text-sm text-kumo-subtle max-sm:hidden">/{command.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
