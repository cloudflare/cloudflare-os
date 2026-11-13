import type { ReactNode } from 'react'
import { Tabs as BaseTabs } from '@cloudflare/kumo/primitives/tabs'
import { cn } from '@cloudflare/kumo/utils'

export type TabsProps<Value extends string> = {
  value: Value
  onValueChange: (value: Value) => void
  tabs: { value: Value; label: string }[]
  /** What the tabs choose between, as the list's accessible name: "Workspace". */
  'aria-label': string
  /** The panels (`Tabs.Panel`), of which only the chosen one is rendered. */
  children: ReactNode
  className?: string
}

/** A row of tabs, centred over what they choose between: plain text, with the chosen one on a pill. */
const TabsRoot = <Value extends string>({ value, onValueChange, tabs, 'aria-label': label, children, className }: TabsProps<Value>) => (
  <BaseTabs.Root value={value} onValueChange={(next: Value) => onValueChange(next)} className={cn('flex flex-col', className)}>
    <BaseTabs.List aria-label={label} className="flex flex-wrap justify-center gap-1">
      {tabs.map((tab) => (
        <BaseTabs.Tab
          key={tab.value}
          value={tab.value}
          className={cn(
            'h-9 rounded-full px-4 text-base font-medium text-kumo-subtle',
            'hover:text-kumo-default data-active:bg-kumo-contrast/5 data-active:text-kumo-default',
          )}
        >
          {tab.label}
        </BaseTabs.Tab>
      ))}
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
