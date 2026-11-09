import { DropdownMenu, type PortalContainer } from '@cloudflare/kumo'
import { BuildingsIcon } from '@phosphor-icons/react'
import { CheckIcon, ChevronDownIcon } from '../../components/icons/designIcons'
import { MENU_CONTENT, MENU_ITEM, MENU_POSITIONER_STYLE } from '../../components/menuStyles'
import { ACCESS_TRIGGER } from './AccessMenu'
import { ACCESS_LABEL, ShareRow } from './CollaboratorList'
import type { GeneralAccess } from './useGeneralAccess'

type Props = {
  siteName: string
  state: GeneralAccess
  /** The viewer may turn it on or off. */
  canChange: boolean
  busy: boolean
  onChange: (enabled: boolean) => void
  container: PortalContainer
}

const OPTIONS = [
  { value: 'on', label: 'Can use', hint: 'Anyone with the link can open it' },
  { value: 'off', label: 'No access', hint: 'Only people you add can open it' },
] as const

/**
 * "Anyone in <deployment>": the people list's row for the gadget's link, which decides whether
 * the copied link opens for someone not listed.
 */
export const GeneralAccessRow = ({ siteName, state, canChange, busy, onChange, container }: Props) => {
  const value = state.kind === 'on' ? 'on' : 'off'
  const label = OPTIONS.find(option => option.value === value)!.label
  const who = `Anyone in ${siteName}`

  let access
  if (state.kind === 'loading') {
    access = <span aria-hidden className="mr-2 h-4 w-16 animate-pulse rounded bg-kumo-tint" />
  } else if (state.kind === 'failed') {
    access = <span className={`${ACCESS_LABEL} !text-kumo-subtle`}>Unavailable</span>
  } else if (!canChange) {
    access = <span className={ACCESS_LABEL}>{label}</span>
  } else {
    access = (
      <DropdownMenu>
        <DropdownMenu.Trigger disabled={busy} render={
          <button type="button" className={ACCESS_TRIGGER} aria-label={`Access for ${who}: ${label}`}>
            {label}<ChevronDownIcon size={12} className="text-kumo-subtle transition-transform group-data-[popup-open]:rotate-180" />
          </button>
        } />
        <DropdownMenu.Content container={container} align="end" sideOffset={6} className={`${MENU_CONTENT} !min-w-[240px]`} style={MENU_POSITIONER_STYLE}>
          <DropdownMenu.RadioGroup value={value} onValueChange={next => onChange(next === 'on')}>
            {OPTIONS.map(option => (
              <DropdownMenu.RadioItem key={option.value} value={option.value} className={`${MENU_ITEM} gap-3`}>
                <span className="flex flex-1 flex-col">
                  <span className="font-medium">{option.label}</span>
                  <span className="text-[12px] leading-4 text-kumo-subtle">{option.hint}</span>
                </span>
                <DropdownMenu.RadioItemIndicator className="text-kumo-default">
                  <CheckIcon size={10} />
                </DropdownMenu.RadioItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu>
    )
  }

  return <ShareRow icon={<BuildingsIcon size={14} />} label={who}>{access}</ShareRow>
}
