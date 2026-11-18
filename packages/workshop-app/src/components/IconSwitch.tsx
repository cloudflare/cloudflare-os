import type { ElementType } from 'react'
import { cn } from '@cloudflare/kumo/utils'

export type IconSwitchProps = {
  /** What switching it on does, as the name of the switch as a whole: "Show the code". */
  'aria-label': string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** The icon at the start, which the thumb is under while it is off, and the one at the end, while it is on. */
  icons: { off: ElementType; on: ElementType }
  /** What it says when pointed at. */
  title?: string
}

const CELL = 'relative grid size-[calc(var(--control-size)-8px)] place-items-center transition-colors duration-200 motion-reduce:transition-none [&>svg]:size-[1.125em]'

/**
 * A switch between two things, each an icon at one end of a pill the height of the app's buttons,
 * with a thumb that slides under the one that is on, as the chosen tab is on a pill. Clicking it
 * anywhere switches it. For two views of one thing, such as what an app looks like and its code.
 */
export const IconSwitch = ({ 'aria-label': label, checked, onCheckedChange, icons, title }: IconSwitchProps) => {
  const { off: Off, on: On } = icons
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-(--control-size) shrink-0 cursor-pointer items-center rounded-full bg-kumo-base p-1 text-(length:--control-text) ring-1 ring-kumo-line',
        'outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute start-1 top-1 size-[calc(var(--control-size)-8px)] rounded-full bg-kumo-contrast/5 transition-transform duration-200 ease-out motion-reduce:transition-none',
          checked && 'translate-x-full rtl:-translate-x-full',
        )}
      />
      <span className={cn(CELL, checked ? 'text-kumo-subtle' : 'text-kumo-default')}><Off aria-hidden="true" /></span>
      <span className={cn(CELL, checked ? 'text-kumo-default' : 'text-kumo-subtle')}><On aria-hidden="true" /></span>
    </button>
  )
}
