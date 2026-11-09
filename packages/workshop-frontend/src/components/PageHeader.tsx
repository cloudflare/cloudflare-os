import type { ReactNode } from 'react'
import { DropdownMenu } from '@cloudflare/kumo'
import { RoundButton, roundButtonClass } from './RoundButton'
import { ArrowLeftIcon } from './icons/designIcons'
import { MENU_CONTENT, MENU_POSITIONER_STYLE } from './menuStyles'
import { openSidebarDrawer } from './AppShell/commandPaletteBus'

/**
 * A page's header row (Figma "Frame 798", 58px): the page's name in a pill with its icon, then
 * whatever the page puts at the far end. On a phone a back button to the chat list comes first.
 */
export function PageHeader({ icon, title, menu, children }: {
  icon?: ReactNode
  title: ReactNode
  /** Items for a menu the title pill opens, such as a workspace's rename and delete. */
  menu?: ReactNode
  children?: ReactNode
}) {
  const pill = 'gap-2 !text-[14px] max-md:h-11 max-md:min-w-0'
  return (
    <div className="flex h-[68px] shrink-0 items-center gap-2 p-3 max-md:px-4 md:h-[58px]">
      <RoundButton label="Chats" onClick={openSidebarDrawer} className="!size-11 md:!hidden">
        <ArrowLeftIcon size={20} />
      </RoundButton>
      {menu ? (
        <DropdownMenu>
          <DropdownMenu.Trigger render={
            <button type="button" className={roundButtonClass('pill', `${pill} min-w-0 data-[popup-open]:bg-kumo-elevated`)}>
              {icon}
              <h1 className="truncate">{title}</h1>
            </button>
          } />
          <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE} align="start">
            {menu}
          </DropdownMenu.Content>
        </DropdownMenu>
      ) : (
        <h1 className={roundButtonClass('pill', `${pill} cursor-default hover:!bg-kumo-base`)}>
          {icon}
          {title}
        </h1>
      )}
      <span className="flex-1" />
      {children}
    </div>
  )
}

/** A page's tab pills (Figma "Frame 804"): the open tab on a grey pill, the rest in grey text. */
export function PageTabs<T extends string>({ tabs, value, onChange, label }: {
  tabs: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div role="tablist" aria-label={label} className="flex min-w-0 items-center gap-2 overflow-x-auto hide-scrollbar">
      {tabs.map(tab => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          onClick={() => onChange(tab.value)}
          className={`h-[34px] shrink-0 cursor-pointer rounded-full px-3 text-[13px] font-medium leading-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring max-md:h-[38px] max-md:px-[13px] max-md:text-[14.5px] ${
            tab.value === value ? 'bg-kumo-recessed text-kumo-default' : 'text-kumo-subtle hover:text-kumo-default'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
