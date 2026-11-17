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
}

export type TabsProps<Value extends string> = {
  value: Value
  onValueChange: (value: Value) => void
  tabs: TabsTab<Value>[]
  /** What the tabs choose between, as the list's accessible name: "Workspace". */
  'aria-label': string
  /** The panels (`Tabs.Panel`), of which only the chosen one is rendered. */
  children: ReactNode
  className?: string
}

const TAB = 'h-(--control-size) rounded-full px-(--control-pad) text-(length:--control-text) font-medium text-kumo-subtle hover:text-kumo-default data-active:text-kumo-default'

/**
 * A row of tabs, centred over what they choose between: plain text, with the chosen one on a pill.
 * One that was opened (`onClose`) has the way to put it away inside its pill, after its label.
 */
const TabsRoot = <Value extends string>({ value, onValueChange, tabs, 'aria-label': label, children, className }: TabsProps<Value>) => (
  <BaseTabs.Root value={value} onValueChange={(next: Value) => onValueChange(next)} className={cn('flex flex-col', className)}>
    <BaseTabs.List aria-label={label} className="flex flex-wrap justify-center gap-1">
      {tabs.map((tab) =>
        tab.onClose === undefined && !tab.unsaved
          ? <BaseTabs.Tab key={tab.value} value={tab.value} title={tab.title} className={cn(TAB, 'data-active:bg-kumo-contrast/5')}>{tab.label}</BaseTabs.Tab>
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
    {children}
  </BaseTabs.Root>
)

type TabsPanelProps = {
  value: string
  children: ReactNode
  className?: string
}

const TabsPanel = ({ value, children, className }: TabsPanelProps) => (
  <BaseTabs.Panel value={value} className={cn('outline-none', className)}>{children}</BaseTabs.Panel>
)

export const Tabs = Object.assign(TabsRoot, { Panel: TabsPanel })
