import { useState } from 'react'
import { Copy01Icon, Delete02Icon, MoreHorizontalIcon, PenIcon, UndoIcon } from '@/components/icons'
import { cn } from '@cloudflare/kumo/utils'
import { DropdownMenu } from '@gadgets/ui'
import { CodeFileCautionDialog } from './CodeFileCautionDialog'
import type { CodeFileOffers } from './CodeFileTree'

export type CodeFileMenuProps = {
  name: string
  offers: CodeFileOffers
  /** Why files can't be changed now, which puts its actions out of use. */
  blocked?: string
  onRename: () => void
  onDuplicate: () => void
  onDelete: () => void
  onRestore: () => void
  /**
   * For inside a tab: no fill when pointed at, a bolder icon, and the darker colour for the hover
   * instead, as a tab's own is the one fill there is.
   */
  quiet?: boolean
}

// An item's name over what is said of it, in a menu.
const Labelled = ({ label, detail }: { label: string; detail?: string }) => (
  <span className="min-w-0 flex-1">
    <span className="block truncate">{label}</span>
    {detail && <span className="block text-sm text-kumo-subtle">{detail}</span>}
  </span>
)

/**
 * What can be done to one file, out of use with why where it can't be now. Renaming or deleting a
 * file with a caution (`offers.caution`: the gadget is built from it) asks first, in a dialog, once
 * the item is chosen, so that the menu itself says nothing of it.
 */
export const CodeFileMenu = ({ name, offers, blocked, onRename, onDuplicate, onDelete, onRestore, quiet = false }: CodeFileMenuProps) => {
  // The action being asked about, kept as the dialog closes so that it does not change as it goes.
  const [asked, setAsked] = useState<{ action: 'rename' | 'delete'; open: boolean }>()
  const act = { rename: onRename, delete: onDelete }
  const choose = (action: 'rename' | 'delete') => {
    if (offers.caution) setAsked({ action, open: true })
    else act[action]()
  }

  return (
    <>
      <DropdownMenu
        icon={quiet ? <MoreHorizontalIcon weight="bold" /> : MoreHorizontalIcon}
        aria-label={`More for ${name}`}
        triggerVariant="ghost"
        triggerClassName={cn('size-8 text-kumo-subtle', quiet && 'not-data-disabled:hover:bg-transparent hover:text-kumo-default')}
        align="end"
      >
        {blocked && <DropdownMenu.Label>{blocked}</DropdownMenu.Label>}
        {offers.rename && (
          <DropdownMenu.Item icon={PenIcon} label="Rename" disabled={!!blocked} onSelect={() => choose('rename')}>Rename</DropdownMenu.Item>
        )}
        {offers.duplicate && (
          <DropdownMenu.Item icon={Copy01Icon} label="Duplicate" disabled={!!blocked} onSelect={onDuplicate}>Duplicate</DropdownMenu.Item>
        )}
        {offers.restore && (
          <DropdownMenu.Item icon={UndoIcon} label="Restore" disabled={!!blocked} onSelect={onRestore}>
            <Labelled label="Restore" detail="As it was before your changes" />
          </DropdownMenu.Item>
        )}
        {(offers.rename || offers.duplicate || offers.restore) && <DropdownMenu.Separator />}
        <DropdownMenu.Item icon={Delete02Icon} label="Delete" danger disabled={!!blocked || offers.delete !== true} onSelect={() => choose('delete')}>
          <Labelled label="Delete" detail={offers.delete === true ? undefined : offers.delete} />
        </DropdownMenu.Item>
      </DropdownMenu>
      {asked && offers.caution && (
        <CodeFileCautionDialog
          open={asked.open}
          onOpenChange={(open) => setAsked((was) => was && { ...was, open })}
          action={asked.action}
          name={name}
          caution={offers.caution}
          onConfirm={act[asked.action]}
        />
      )}
    </>
  )
}
