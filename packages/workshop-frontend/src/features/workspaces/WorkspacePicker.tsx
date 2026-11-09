import { DropdownMenu } from '@cloudflare/kumo'
import { Check } from '@phosphor-icons/react'
import { ChevronDownIcon, FolderIcon, PlusIcon } from '../../components/icons/designIcons'
import { FolderBadge } from '../../components/icons/brandMarks'
import { MENU_CONTENT, MENU_ITEM, MENU_POSITIONER_STYLE } from '../../components/menuStyles'
import { COMPOSER_CHIP_CLASS } from '../chat/composer/composerChip'
import { workspaceInitials } from './workspaceInitials'
import { isMemberWorkspace, useWorkspaces } from './WorkspacesContext'

/**
 * Where a new chat goes (Figma "Frame 732": a folder, "No workspace", a chevron). `null` starts the
 * chat in no workspace. The menu lists the user's named workspaces and offers to create one.
 *
 * `appearance="pill"` draws it as a round button instead of a bare chip, for the phone layout's
 * header (Figma "iPhone 18 Pro - 1"), where it sits on its own rather than inside the composer.
 */
export const WorkspacePicker = ({ value, onValueChange, onCreateWorkspace, appearance = 'chip' }: {
  value: string | null
  onValueChange: (workspaceId: string | null) => void
  onCreateWorkspace: () => void
  appearance?: 'chip' | 'pill'
}) => {
  const { workspaces } = useWorkspaces()
  const named = workspaces.filter(isMemberWorkspace)
    .toSorted((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.title.localeCompare(b.title))
  const selected = value === null ? undefined : named.find(w => w.id === value)
  const label = selected?.title ?? 'No workspace'

  const trigger = appearance === 'chip' ? (
    <button type="button" className={COMPOSER_CHIP_CLASS} aria-label={`Workspace: ${label}`}>
      <FolderIcon size={15} className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDownIcon size={16} className="shrink-0 transition-transform group-data-[popup-open]:rotate-180" />
    </button>
  ) : (
    <button type="button" aria-label={`Workspace: ${label}`}
      className="group inline-flex h-[46px] min-w-0 max-w-[220px] items-center gap-2 rounded-full bg-kumo-base px-4 text-[15px] font-medium leading-[18px] text-kumo-default ring-1 ring-kumo-line">
      <FolderIcon size={18} className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDownIcon size={18} className="shrink-0 transition-transform group-data-[popup-open]:rotate-180" />
    </button>
  )

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={trigger} />
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE} side={appearance === 'chip' ? 'top' : 'bottom'} align="end">
        <DropdownMenu.Item className={MENU_ITEM} onClick={() => onValueChange(null)}>
          <span className="flex size-5 items-center justify-center text-kumo-subtle"><FolderIcon size={15} /></span>
          <span className="flex-1">No workspace</span>
          {value === null && <Check size={12} weight="bold" className="text-kumo-subtle" />}
        </DropdownMenu.Item>
        {named.length > 0 && <DropdownMenu.Separator />}
        {named.map(workspace => (
          <DropdownMenu.Item key={workspace.id} className={MENU_ITEM} onClick={() => onValueChange(workspace.id)}>
            <span className="flex size-5 items-center justify-center text-kumo-default">
              <FolderBadge initials={workspaceInitials(workspace.title)} size={20} />
            </span>
            <span className="min-w-0 flex-1 truncate">{workspace.title}</span>
            {value === workspace.id && <Check size={12} weight="bold" className="text-kumo-subtle" />}
          </DropdownMenu.Item>
        ))}
        <DropdownMenu.Separator />
        <DropdownMenu.Item className={MENU_ITEM} onClick={onCreateWorkspace}>
          <span className="flex size-5 items-center justify-center text-kumo-subtle"><PlusIcon size={14} /></span>
          Create a workspace
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
