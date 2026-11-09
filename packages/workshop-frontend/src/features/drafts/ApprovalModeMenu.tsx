import { DropdownMenu } from '@cloudflare/kumo'
import { CheckIcon, ChevronDownIcon } from '../../components/icons/designIcons'
import { MENU_CONTENT, MENU_ITEM, MENU_POSITIONER_STYLE } from '../../components/menuStyles'
import { changeCount } from './drafts'

/** Whether changes wait as drafts for someone to apply, or apply as they are made. */
export type ApprovalMode = 'review' | 'auto'

type Copy = { heading: string; review: [string, string]; auto: [string, string] }

const COPY: Record<'chat' | 'gadget', Copy> = {
  chat: {
    heading: 'Changes this chat makes',
    review: ['Review first', 'Drafts each change for you to apply or discard.'],
    auto: ['Apply automatically', 'Makes changes as it goes. Still asks before sending, sharing or deleting.'],
  },
  gadget: {
    heading: 'Changes this gadget makes',
    review: ['Review first', 'Waits for someone in the workspace to apply each change.'],
    auto: ['Apply automatically', 'Makes changes on its own, even when no one is watching. Still asks before sending, sharing or deleting.'],
  },
}

const TRIGGER =
  'group inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[12.5px] leading-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-50'

/**
 * Where a chat's or a gadget's approval mode is seen and changed: Review first drafts changes for
 * someone to apply, and Apply automatically makes them as they come, still asking before anything
 * the connection marks as needing a person (sending, sharing, deleting). Choosing it with drafts
 * waiting applies those too, and says so. A workspace that has read restricted data stays on
 * Review first.
 */
export const ApprovalModeMenu = ({ scope, mode, waiting, restricted, busy, onChange, side = 'top' }: {
  scope: 'chat' | 'gadget'
  mode: ApprovalMode
  /** How many drafts are waiting, which choosing Apply automatically applies. */
  waiting: number
  restricted: boolean
  busy: boolean
  onChange: (mode: ApprovalMode) => void
  /** Where the menu opens: above a composer, below a header. */
  side?: 'top' | 'bottom'
}) => {
  const copy = COPY[scope]
  const effective = restricted ? 'review' : mode
  const auto = effective === 'auto'
  const options = [
    { value: 'review' as const, label: copy.review[0], hint: copy.review[1] },
    {
      value: 'auto' as const,
      label: copy.auto[0],
      hint: restricted
        ? 'Off in this workspace: it has read sensitive data, so every change is reviewed.'
        : waiting > 0 && !auto ? `${copy.auto[1]} Applies the ${changeCount(waiting)} waiting now.` : copy.auto[1],
    },
  ]
  const label = auto ? 'Auto' : 'Review first'

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger disabled={busy} render={
        <button
          type="button"
          aria-label={`${copy.heading}: ${auto ? copy.auto[0] : copy.review[0]}`}
          className={`${TRIGGER} ${auto
            ? 'bg-kumo-tint font-medium text-kumo-default hover:bg-kumo-fill'
            : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default'}`}
        >
          {label}
          <ChevronDownIcon size={11} className="opacity-60 transition-transform group-data-[popup-open]:rotate-180" />
        </button>
      } />
      <DropdownMenu.Content side={side} align="end" sideOffset={8} className={`${MENU_CONTENT} !w-[288px]`} style={MENU_POSITIONER_STYLE}>
        <p className="m-0 px-2.5 pt-1.5 pb-1 text-[11.5px] font-medium leading-4 text-kumo-subtle">{copy.heading}</p>
        <DropdownMenu.RadioGroup value={effective} onValueChange={next => {
          if (next !== effective) onChange(next as ApprovalMode)
        }}>
          {options.map(option => (
            <DropdownMenu.RadioItem
              key={option.value}
              value={option.value}
              closeOnClick
              disabled={restricted && option.value === 'auto'}
              className={`${MENU_ITEM} items-start gap-3 data-disabled:opacity-60`}
            >
              <span className="flex flex-1 flex-col gap-0.5">
                <span className="font-medium">{option.label}</span>
                <span className="text-[12px] leading-4 text-kumo-subtle">{option.hint}</span>
              </span>
              <span className="mt-[3px] flex size-3 shrink-0 items-center justify-center">
                <DropdownMenu.RadioItemIndicator className="text-kumo-default">
                  <CheckIcon size={10} />
                </DropdownMenu.RadioItemIndicator>
              </span>
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
