import { useRef, useState } from 'react'
import { MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'

export type SearchFieldProps = {
  value: string
  onValueChange: (value: string) => void
  /** What it searches, as its name and its placeholder: "Search workspaces". */
  label: string
  className?: string
}

/**
 * A search field that keeps to a round button, the size of `Button` with an icon alone, until it is
 * clicked or tabbed to. It then opens out into the room its row has to spare, and stays open for as
 * long as there is text in it. Escape clears it, and from empty puts it away.
 */
export const SearchField = ({ value, onValueChange, label, className }: SearchFieldProps) => {
  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const open = focused || value !== ''

  return (
    // A label, so that all of it, the icon included, takes a click to the field.
    <label
      data-open={open || undefined}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
      className={cn(
        // It grows into the room rather than to a width, so that its row decides how wide it gets.
        'flex h-(--control-size) min-w-(--control-size) flex-[0_1_var(--control-size)] items-center overflow-hidden rounded-full bg-kumo-base text-(length:--control-text) text-kumo-default ring-1 ring-kumo-line',
        'transition-[flex-grow,background-color,box-shadow] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none',
        'cursor-pointer not-data-open:hover:bg-kumo-tint data-open:grow data-open:cursor-text has-focus-visible:ring-kumo-focus/8',
        className,
      )}
    >
      <span className="grid size-(--control-size) shrink-0 place-items-center">
        <MagnifyingGlassIcon aria-hidden="true" className="size-[1.125em]" />
      </span>
      <input
        ref={inputRef}
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          if (value === '') event.currentTarget.blur()
          else onValueChange('')
        }}
        // Its text is the field's, which is 16px on a narrow screen: less, and iOS zooms the page in on it.
        className="min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 pe-3 outline-none placeholder:text-kumo-subtle [&::-webkit-search-cancel-button]:hidden"
      />
      {value !== '' && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onValueChange('')
            inputRef.current?.focus()
          }}
          className="-ms-3 grid size-(--control-size) shrink-0 cursor-pointer place-items-center rounded-full text-kumo-subtle hover:text-kumo-default"
        >
          <XIcon aria-hidden="true" weight="bold" className="size-3.5" />
        </button>
      )}
    </label>
  )
}
