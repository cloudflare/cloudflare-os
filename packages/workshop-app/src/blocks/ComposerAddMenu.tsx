import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { Combobox } from '@cloudflare/kumo/primitives/combobox'
import { ArrowLeft02Icon, ArrowRight01Icon, AttachmentIcon, PlugSocketIcon, PlusSignIcon, ScrollIcon, Search01Icon } from '@/components/icons'
import { DropdownMenu } from '@gadgets/ui'
import { commandGlyph, type ComposerCommand } from './composerCommand'
import { composerAddEntries, composerAddGivesWay, composerAddKey, type ComposerAddEntry, type ComposerAddList, type ComposerAddOffer } from './composerAddEntries'

export type ComposerAddActions = {
  onUpload?: () => void
  /**
   * What else the draft can be given or started with, as whoever has the composer knows it: the
   * formats, what can be set up, the services to connect something of and the templates, each
   * in the order it is offered in.
   */
  offers?: readonly ComposerAddOffer[]
  /**
   * The skills and commands the draft can go with, in the order they are listed. `loading` while
   * they are still being read and none are known.
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
  /**
   * Whether it is open, which whoever has it keeps: it is opened by its button, and by them, as
   * by a slash typed in the draft.
   */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Something was chosen from it, which is about to be done. */
  onChoose?: () => void
  /**
   * It was opened by something typed in the draft, such as a slash, which may have been meant as
   * what it is: it is then only in the way of whoever is writing, and gives way to the draft
   * unless what is typed next looks for something in it. Until something is typed in its field,
   * Backspace takes back what opened it (`onUndo`) and a key that only moves about what is
   * written puts it away; a space straight away, or words that find nothing, do too. Whoever
   * opened it is told what is typed in its field (`onQuery`), which was typed for the draft
   * if nothing comes of it.
   */
  tentative?: { onQuery: (query: string) => void; onUndo: () => void }
  /**
   * The draft's field, which has the focus once the menu is put away from the keyboard, rather
   * than the + it opened from: the menu is the composer's, and the draft is where to carry on.
   */
  fieldRef?: RefObject<HTMLElement | null>
}

/**
 * The composer's action picker. Its callers supply capabilities; absent actions stay disabled.
 * Put away, the focus is the draft's rather than the +'s, as the menu is the composer's and the
 * draft is where to carry on: once something is chosen, and when it is closed from the keyboard.
 * Not when what was chosen opened something that has the focus itself, such as a dialog; nor when
 * a pointer put it away without choosing, which stays where it clicked, and on a touch screen
 * would bring the keyboard up.
 */
export const ComposerAddMenu = ({ anchorRef, inPlace, open, onOpenChange, onChoose, tentative, fieldRef, ...actions }: ComposerAddMenuProps) => {
  // What was chosen as it closed, if anything was: whether the focus is then the draft's.
  const chose = useRef<'draft' | 'elsewhere'>(undefined)
  return (
    <DropdownMenu
      icon={<PlusSignIcon weight="bold" />}
      aria-label="Add to conversation"
      triggerClassName="size-(--composer-button) text-kumo-subtle not-data-disabled:hover:text-kumo-default [&>svg]:size-[calc(var(--composer-button)*0.47)]"
      triggerVariant="ghost"
      anchorRef={anchorRef}
      side="top"
      inPlace={inPlace}
      open={open}
      onOpenChange={onOpenChange}
      finalFocus={(closedBy) => {
        if (chose.current === 'elsewhere') return false
        return chose.current === 'draft' || closedBy === 'keyboard' ? fieldRef?.current ?? true : true
      }}
      picker="wide"
      // No taller than five rows and half of the next, which says there are more, over its field;
      // and wider than a menu of items, for what the end of a row says.
      popupClassName="max-h-[min(var(--available-height),17rem)] w-96"
    >
      {(close) => (
        <ComposerAddSearch
          {...actions}
          close={close}
          tentative={tentative}
          // Each opening starts with nothing chosen, however it was opened.
          onOpened={() => (chose.current = undefined)}
          // Given way to the draft, which is where to carry on.
          onLeave={() => {
            chose.current = 'draft'
            close()
          }}
          onChosen={(opens) => {
            chose.current = opens ? 'elsewhere' : 'draft'
            onChoose?.()
          }}
        />
      )}
    </DropdownMenu>
  )
}

// As a menu's items are, which these are in: one line each, what it is and, at its end, what it does or what tells it apart.
const ROW =
  'flex cursor-pointer items-center gap-3 rounded-2xl px-(--menu-pad-x) py-(--menu-pad-y) text-(length:--menu-text) leading-(--menu-line) text-kumo-default outline-none ' +
  'data-highlighted:bg-kumo-tint data-disabled:cursor-default data-disabled:text-kumo-subtle'
// In line with the rows' text, which the list's own padding moves in.
const NOTE = 'px-[calc(var(--menu-pad-x)+0.375rem)] py-4 text-(length:--menu-text) leading-(--menu-line) text-kumo-subtle'

// What a kind gone on to is called, in its field.
const LISTS: Record<ComposerAddList, string> = { skill: 'Search skills…', connection: 'Search connections…' }

/**
 * What the menu holds, mounted as it opens: the rows over a field that finds anything there is
 * to add, the field at the edge nearest the composer. It opens on a short list, whose last rows,
 * each ending in a caret, go on to all of a kind in the list's place, with the way back at the
 * start of the field. It
 * is as tall as what it lists, up to the menu's most, so a few results are a short menu: the
 * field stays where it is, at the edge the menu opens from, and the far edge comes to it. Only
 * where it had no room over the composer and opened under it does it keep the height it opened
 * at: shorter, it would fit over the composer after all, and jump there as something is typed.
 */
const ComposerAddSearch = ({ onUpload, offers, commands, close, tentative, onOpened, onLeave, onChosen }: ComposerAddActions & {
  close: () => void
  tentative?: ComposerAddMenuProps['tentative']
  /** It is shown, which it is anew each time the menu opens. */
  onOpened: () => void
  /** It gives way to the draft, with nothing chosen. */
  onLeave: () => void
  /** Something was chosen, which closes the menu: whether what it opens has the focus itself. */
  onChosen: (opens: boolean) => void
}) => {
  const [query, setQuery] = useState('')
  // The kind it has gone on to all of.
  const [list, setList] = useState<ComposerAddList>()
  const loading = !!commands?.loading && !commands.items.length
  const entries = useMemo(
    () => composerAddEntries({ commands: commands?.items ?? [], offers, upload: !!onUpload, loading }, query, list),
    [commands?.items, offers, query, onUpload, loading, list],
  )
  const highlighted = useRef<ComposerAddEntry>(undefined)
  const fieldRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // How tall it is on the list it opens with.
  const [opened, setOpened] = useState<number>()
  const narrowed = query.trim() !== '' || list !== undefined
  useLayoutEffect(() => {
    if (!narrowed && rootRef.current) setOpened(rootRef.current.offsetHeight)
  }, [narrowed, entries.length])
  // A row that goes on was chosen: the field is not to be filled with its name, as one chosen is.
  const wentOn = useRef(false)

  useEffect(() => {
    onOpened()
    fieldRef.current?.focus({ preventScroll: true })
    // Only as it opens.
  }, [])
  // Another list starts at its first row, wherever the one before was scrolled to.
  useLayoutEffect(() => {
    // Set rather than scrolled to, which in some browsers answers with a promise an effect cannot return.
    if (listRef.current) listRef.current.scrollTop = 0
  }, [list, query])

  const goTo = (next: ComposerAddList | undefined) => {
    setList(next)
    setQuery('')
    // What was typed found the list gone on to: it is not the draft's to have back.
    tentative?.onQuery('')
    fieldRef.current?.focus({ preventScroll: true })
  }

  const choose = (entry: ComposerAddEntry) => {
    if (entry.kind === 'all') {
      wentOn.current = true
      setTimeout(() => (wentOn.current = false))
      return goTo(entry.list)
    }
    onChosen(entry.kind === 'offer' && !!entry.offer.opens)
    close()
    if (entry.kind === 'command') commands?.onChoose(entry.command)
    else if (entry.kind === 'offer') entry.offer.onChoose()
    else onUpload?.()
  }

  return (
    <div
      ref={rootRef}
      // Opened under the button rather than over it, the field is at its top instead.
      className="flex min-h-0 flex-col in-data-[side=bottom]:min-h-[var(--opened-height,0px)] in-data-[side=bottom]:flex-col-reverse"
      style={narrowed && opened !== undefined ? { '--opened-height': `${opened}px` } as CSSProperties : undefined}
      onKeyDown={(event) => {
        const does = composerAddKey(event.key, { highlighted: highlighted.current, onList: list !== undefined, typed: query !== '', tentative: !!tentative })
        if (does === 'keep') return event.stopPropagation()
        if (does === 'close') return
        event.preventDefault()
        event.stopPropagation()
        if (does === 'back') goTo(undefined)
        else if (does === 'leave') onLeave()
        else if (does === 'undo') {
          tentative?.onUndo()
          onLeave()
        } else if (highlighted.current) choose(highlighted.current)
      }}
    >
      <Combobox.Root
        inline
        open
        autoHighlight
        items={entries}
        filter={null}
        inputValue={query}
        onInputValueChange={(value: string) => {
          if (wentOn.current) return
          setQuery(value)
          if (!tentative || list !== undefined) return
          tentative.onQuery(value)
          if (composerAddGivesWay({ commands: commands?.items ?? [], offers, upload: !!onUpload, loading }, value)) onLeave()
        }}
        value={null}
        onValueChange={(entry: ComposerAddEntry | null) => entry && choose(entry)}
        onItemHighlighted={(entry: ComposerAddEntry | undefined) => (highlighted.current = entry)}
        itemToStringLabel={(entry: ComposerAddEntry) => entry.title}
        isItemEqualToValue={(a: ComposerAddEntry, b: ComposerAddEntry) => a.key === b.key}
      >
        {/* A row the arrow keys bring into sight keeps the list's padding from its edge, as search's rows do. */}
        <Combobox.List ref={listRef} className="min-h-0 flex-1 scroll-p-1.5 overflow-y-auto overscroll-contain p-1.5 outline-none empty:hidden">
          {(entry: ComposerAddEntry) => <AddRow key={entry.key} entry={entry} />}
        </Combobox.List>
        {/* In the list's place, after the field either way up, as the rows are. */}
        {entries.length === 0 && (
          <p role="status" className={`${NOTE} in-data-[side=bottom]:-order-1 in-data-[side=bottom]:flex-1`}>
            {list === 'skill' && loading ? 'Loading skills…' : 'Nothing matches.'}
          </p>
        )}
        {/* Across the menu from edge to edge, its glyph under the rows' and its words under theirs. */}
        <div className="flex shrink-0 items-center gap-3 border-t border-kumo-line px-[calc(var(--menu-pad-x)+0.375rem)] text-kumo-subtle in-data-[side=bottom]:border-t-0 in-data-[side=bottom]:border-b">
          {list
            ? (
                <button type="button" aria-label="Back" title="Back" onClick={() => goTo(undefined)} className="-m-2 grid cursor-pointer place-items-center rounded-full p-2 outline-none hover:text-kumo-default focus-visible:text-kumo-default">
                  <ArrowLeft02Icon aria-hidden="true" weight="bold" className="size-(--menu-icon)" />
                </button>
              )
            : <Search01Icon aria-hidden="true" className="size-(--menu-icon) shrink-0" />}
          <Combobox.Input
            ref={fieldRef}
            aria-label={list ? LISTS[list].replace('…', '') : 'Search what to add'}
            placeholder={list ? LISTS[list] : 'Search…'}
            autoComplete="off"
            spellCheck={false}
            // A menu's line, which is 16px on a narrow screen, where iOS would zoom the page in on a
            // field with smaller text.
            className="min-w-0 flex-1 appearance-none border-0 bg-transparent py-3 text-(length:--menu-text) leading-(--menu-line) text-kumo-default outline-none placeholder:text-kumo-subtle"
          />
        </div>
      </Combobox.Root>
    </div>
  )
}

// What a row is drawn with: its glyph, what its end says of it, a caret there instead where it
// goes on to more, and what is said to whoever points at it.
const shownOf = (entry: ComposerAddEntry): { icon: ReactNode; detail?: string; about?: string; goesOn?: boolean } => {
  if (entry.kind === 'upload') return { icon: <AttachmentIcon aria-hidden="true" /> }
  if (entry.kind === 'offer') return { icon: entry.offer.icon, detail: entry.offer.detail }
  if (entry.kind === 'all') {
    const Glyph = entry.list === 'skill' ? ScrollIcon : PlugSocketIcon
    return { icon: <Glyph aria-hidden="true" />, goesOn: true }
  }
  const { command } = entry
  const Glyph = commandGlyph(command)
  return { icon: <Glyph aria-hidden="true" />, detail: command.kind === 'skill' ? command.source : undefined, about: command.description }
}

const AddRow = ({ entry }: { entry: ComposerAddEntry }) => {
  const { icon, detail, about, goesOn } = shownOf(entry)
  return (
    <Combobox.Item value={entry} disabled={entry.kind === 'upload' && entry.disabled} title={about} className={ROW}>
      {/* A box of the menu's icon size, whatever is drawn in it: a glyph, a service's logo, or an
          agent's cloud, which is a little larger and is about the box's middle all the same. */}
      <span className="flex size-(--menu-icon) shrink-0 items-center justify-center [&>*]:shrink-0 [&>svg]:size-full">{icon}</span>
      {/* Its name has the room first: what its end says gives way to it, down to a few letters. */}
      <span className="min-w-0 truncate">{entry.title}</span>
      {detail && <span className="ms-auto min-w-12 shrink-[999] truncate text-end text-(length:--menu-detail-text) text-kumo-subtle">{detail}</span>}
      {goesOn && <ArrowRight01Icon aria-hidden="true" weight="bold" className="ms-auto size-3 shrink-0 text-kumo-subtle" />}
    </Combobox.Item>
  )
}
