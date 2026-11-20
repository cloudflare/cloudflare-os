import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Combobox } from '@cloudflare/kumo/primitives/combobox'
import { PaperclipIcon, PlugIcon, PlusIcon } from '@phosphor-icons/react'
import { DropdownMenu } from '@gadgets/ui'
import { commandGlyph, type ComposerCommand } from './ComposerCommandPicker'
import { composerAddEntries, composerAddKey, type ComposerAddEntry } from './composerAddEntries'

export type ComposerAddActions = {
  onUpload?: () => void
  onAddConnection?: () => void
  /**
   * The skills and commands the draft can go with, in the order they are listed, under a field
   * that finds one by what is typed in it. `loading` while they are still being read and none are
   * known, which keeps their room.
   */
  commands?: {
    items: readonly ComposerCommand[]
    onChoose: (command: ComposerCommand) => void
    loading?: boolean
  }
}

type ComposerAddMenuProps = ComposerAddActions & {
  anchorRef: RefObject<HTMLElement | null>
  /** Keep the popup's anchored corner at the button's original position. */
  inPlace?: boolean
  /** The menu opened. */
  onOpen?: () => void
}

/** The composer's action picker. Its callers supply capabilities; absent actions stay disabled. */
export const ComposerAddMenu = ({ anchorRef, inPlace, onOpen, ...actions }: ComposerAddMenuProps) => (
  <DropdownMenu
    icon={<PlusIcon weight="bold" />}
    aria-label="Add to conversation"
    triggerClassName="size-(--composer-button) text-kumo-subtle not-data-disabled:hover:text-kumo-default [&>svg]:size-[calc(var(--composer-button)*0.47)]"
    triggerVariant="ghost"
    anchorRef={anchorRef}
    side="top"
    inPlace={inPlace}
    onOpenChange={(open) => {
      if (open) onOpen?.()
    }}
    picker="wide"
  >
    {(close) => <ComposerAddSearch {...actions} close={close} />}
  </DropdownMenu>
)

// As a menu's items are, which these are in.
const ROW =
  'flex cursor-pointer items-center gap-3 rounded-2xl px-(--menu-pad-x) py-(--menu-pad-y) text-(length:--menu-text) leading-(--menu-line) text-kumo-default outline-none ' +
  'data-highlighted:bg-kumo-tint data-disabled:cursor-default data-disabled:text-kumo-subtle [&>svg]:size-(--menu-icon) [&>svg]:shrink-0'
// In line with the rows' text, which the list's own padding moves in.
const NOTE = 'px-[calc(var(--menu-pad-x)+0.375rem)] py-4 text-(length:--menu-text) leading-(--menu-line) text-kumo-subtle'

const ACTIONS = {
  upload: { icon: PaperclipIcon, label: 'Upload files or photos' },
  connection: { icon: PlugIcon, label: 'Add a new connection' },
} as const

/**
 * What the menu holds, mounted as it opens: the rows over a field that narrows them, the field
 * at the edge nearest the composer. It opens at the height it then keeps while anything is typed,
 * so that narrowing the list does not pull the menu down from under the pointer.
 */
const ComposerAddSearch = ({ onUpload, onAddConnection, commands, close }: ComposerAddActions & { close: () => void }) => {
  const [query, setQuery] = useState('')
  const entries = useMemo(
    () => composerAddEntries(commands?.items ?? [], query, { upload: !!onUpload, connection: !!onAddConnection }),
    [commands?.items, query, onUpload, onAddConnection],
  )
  const typed = query.trim() !== ''
  const loading = !!commands?.loading && !commands.items.length
  const highlighted = useRef<ComposerAddEntry>(undefined)
  const fieldRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number>()

  useEffect(() => fieldRef.current?.focus({ preventScroll: true }), [])
  // Its height with nothing typed, which it keeps once something is.
  useLayoutEffect(() => {
    if (!typed && rootRef.current) setHeight(rootRef.current.offsetHeight)
  }, [typed, entries.length, loading])

  const choose = (entry: ComposerAddEntry) => {
    close()
    if (entry.kind === 'command') commands?.onChoose(entry.command)
    else if (entry.key === 'upload') onUpload?.()
    else onAddConnection?.()
  }

  return (
    <div
      ref={rootRef}
      // Opened under the button rather than over it, the field is at its top instead.
      className="flex min-h-0 flex-col in-data-[side=bottom]:flex-col-reverse"
      style={typed ? { height } : undefined}
      onKeyDown={(event) => {
        const does = composerAddKey(event.key, highlighted.current)
        if (does === 'keep') return event.stopPropagation()
        if (does === 'choose' && highlighted.current) {
          event.preventDefault()
          event.stopPropagation()
          choose(highlighted.current)
        }
      }}
    >
      <Combobox.Root
        inline
        open
        autoHighlight
        items={entries}
        filter={null}
        inputValue={query}
        onInputValueChange={setQuery}
        value={null}
        onValueChange={(entry: ComposerAddEntry | null) => entry && choose(entry)}
        onItemHighlighted={(entry: ComposerAddEntry | undefined) => (highlighted.current = entry)}
        itemToStringLabel={(entry: ComposerAddEntry) => (entry.kind === 'command' ? entry.command.title : ACTIONS[entry.key].label)}
        isItemEqualToValue={(a: ComposerAddEntry, b: ComposerAddEntry) => a.key === b.key}
      >
        <Combobox.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 outline-none">
          {(entry: ComposerAddEntry, index: number) => (
            <Fragment key={entry.key}>
              {!typed && entry.kind === 'command' && entries[index - 1]?.kind === 'action' && (
                <Combobox.Separator className="mx-(--menu-pad-x) my-1 h-px bg-kumo-line" />
              )}
              <AddRow entry={entry} />
            </Fragment>
          )}
        </Combobox.List>
        {loading ? (
          // Room for the skills to come, about as much as they take, so the menu does not grow when
          // they do. After the rows either way up, as the skills will be.
          <p role="status" className={`${NOTE} h-64 shrink-0 in-data-[side=bottom]:-order-1`}>Loading skills…</p>
        ) : (
          typed && <Combobox.Empty className={`${NOTE} empty:hidden in-data-[side=bottom]:-order-1`}>No skills match.</Combobox.Empty>
        )}
        {commands && <Combobox.Input
          ref={fieldRef}
          aria-label="Search skills"
          placeholder="Search skills…"
          autoComplete="off"
          spellCheck={false}
          // A menu's line, which is 16px on a narrow screen, where iOS would zoom the page in on a
          // field with smaller text.
          className="mx-1.5 mb-1.5 shrink-0 appearance-none border-0 border-t border-kumo-line bg-transparent px-(--menu-pad-x) py-(--menu-pad-y) text-(length:--menu-text) leading-(--menu-line) text-kumo-default outline-none placeholder:text-kumo-subtle in-data-[side=bottom]:mt-1.5 in-data-[side=bottom]:mb-0 in-data-[side=bottom]:border-t-0 in-data-[side=bottom]:border-b"
        />}
      </Combobox.Root>
    </div>
  )
}

const AddRow = ({ entry }: { entry: ComposerAddEntry }) => {
  if (entry.kind === 'action') {
    const { icon: Icon, label } = ACTIONS[entry.key]
    return (
      <Combobox.Item value={entry} disabled={entry.disabled} className={ROW}>
        <Icon aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </Combobox.Item>
    )
  }
  const { command } = entry
  const Glyph = commandGlyph(command)
  return (
    <Combobox.Item value={entry} className={ROW}>
      <Glyph aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{command.title}</span>
        <span className="block truncate text-(length:--menu-detail-text) leading-(--menu-detail-line) text-kumo-subtle">{command.description}</span>
      </span>
      {command.source && <span className="max-w-[30%] shrink-0 truncate text-(length:--menu-detail-text) text-kumo-subtle">{command.source}</span>}
    </Combobox.Item>
  )
}
