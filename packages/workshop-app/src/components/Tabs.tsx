import type { ReactNode } from 'react'
import { Tabs as BaseTabs } from '@cloudflare/kumo/primitives/tabs'
import { XIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'

export type TabsTab<Value extends string> = {
  value: Value
  label: string
  /** More of what it is than its label has room for, shown when it is pointed at. */
  title?: string
  /**
   * It is one that was opened, and can be put away again: it has a button for that at its end.
   * Putting it away, and what is shown once it has gone, are the caller's.
   */
  onClose?: () => void
  /** Something in it has not been kept, which a dot says in place of the way to put it away. */
  unsaved?: boolean
  /**
   * How many things in it are waiting on the reader, shown after its label, with what they are
   * for whoever cannot see it: "waiting on you". Nothing is shown for none.
   */
  count?: { value: number; label: string }
}

export type TabsProps<Value extends string> = {
  value: Value
  onValueChange: (value: Value) => void
  tabs: TabsTab<Value>[]
  /** What the tabs choose between, as the list's accessible name: "Workspace". */
  'aria-label': string
  /** The panels (`Tabs.Panel`), of which only the chosen one is rendered. */
  children: ReactNode
  /**
   * Those there is no room for on the line are scrolled to along it, rather than put on another:
   * for tabs that are as many as there are kinds of something.
   */
  scrolls?: boolean
  /**
   * Where on the line they are: in the middle, over a page they switch between, or at its start,
   * in line with a list they narrow, whose titles and controls start there.
   */
  align?: 'center' | 'start'
  /**
   * What shares their line, after them: a list's controls, which open out into the room the tabs
   * leave, and over which the tabs are scrolled along where it is too short for both.
   */
  end?: ReactNode
  className?: string
}

const TAB = 'h-(--control-size) cursor-pointer rounded-full px-(--control-pad) text-(length:--control-text) font-medium text-kumo-subtle hover:text-kumo-default data-active:text-kumo-default'

/**
 * A row of tabs, centred over what they choose between: plain text, with the chosen one on a pill.
 * One that was opened (`onClose`) has the way to put it away inside its pill, after its label.
 */
const TabsRoot = <Value extends string>({ value, onValueChange, tabs, 'aria-label': label, children, scrolls = false, align = 'center', end, className }: TabsProps<Value>) => {
  const list = (
    // Scrolled, it is placed by its own width, so that one too wide for the line starts at the line's
    // start, where its first tab can be reached. Beside what shares its line, it gives way to it. It
    // is what its tabs are placed in, which Base UI measures the chosen one's place in to scroll it
    // into view: measured in something further out, it is out of view at the start and is scrolled
    // to the end.
    <BaseTabs.List
      aria-label={label}
      className={cn(
        'flex gap-1',
        scrolls ? 'relative max-w-full overflow-x-auto [scrollbar-width:none] *:shrink-0' : 'flex-wrap',
        end !== undefined
          ? 'min-w-0'
          : scrolls ? (align === 'start' ? 'self-start' : 'self-center') : align === 'start' ? 'justify-start' : 'justify-center',
      )}
    >
      {tabs.map((tab) =>
        tab.onClose === undefined && !tab.unsaved
          ? (
              <BaseTabs.Tab key={tab.value} value={tab.value} title={tab.title} className={cn(TAB, 'data-active:bg-kumo-contrast/5', tab.count?.value && 'inline-flex items-center gap-1.5')}>
                {tab.label}
                {Boolean(tab.count?.value) && (
                  <>
                    <span aria-hidden="true" className="min-w-5 rounded-full bg-kumo-warning-tint px-1.5 text-xs/5 text-kumo-default tabular-nums">{tab.count!.value}</span>
                    <span className="sr-only">{`, ${tab.count!.value} ${tab.count!.label}`}</span>
                  </>
                )}
              </BaseTabs.Tab>
            )
          : (
              // The pill is around both, as a button cannot be inside the tab, which is one.
              <span key={tab.value} className="flex max-w-full min-w-0 items-center rounded-full has-data-active:bg-kumo-contrast/5">
                <BaseTabs.Tab value={tab.value} title={tab.title} className={cn(TAB, 'max-w-56 min-w-0 truncate pe-1.5')}>{tab.label}</BaseTabs.Tab>
                {tab.unsaved
                  ? <span role="img" aria-label="Unsaved changes" title="Unsaved changes" className="me-1.5 grid size-6 shrink-0 place-items-center"><span className="size-2 rounded-full bg-kumo-contrast/50" /></span>
                  : (
                      <button
                        type="button"
                        aria-label={`Close ${tab.label}`}
                        title="Close"
                        onClick={tab.onClose}
                        className="me-1.5 grid size-6 shrink-0 cursor-pointer place-items-center rounded-full text-kumo-subtle hover:bg-kumo-contrast/5 hover:text-kumo-default"
                      >
                        <XIcon aria-hidden="true" weight="bold" className="size-3" />
                      </button>
                    )}
              </span>
            ),
      )}
    </BaseTabs.List>
  )
  return (
    <BaseTabs.Root value={value} onValueChange={(next: Value) => onValueChange(next)} className={cn('flex flex-col', className)}>
      {end === undefined ? list : <div className="flex items-center gap-3">{list}{end}</div>}
      {children}
    </BaseTabs.Root>
  )
}

type TabsPanelProps = {
  value: string
  children: ReactNode
  className?: string
}

const TabsPanel = ({ value, children, className }: TabsPanelProps) => (
  <BaseTabs.Panel value={value} className={cn('outline-none', className)}>{children}</BaseTabs.Panel>
)

export const Tabs = Object.assign(TabsRoot, { Panel: TabsPanel })
