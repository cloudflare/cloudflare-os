import type { RefObject } from 'react'
import { PaperclipIcon, PlugIcon, PlusIcon, ScrollIcon } from '@phosphor-icons/react'
import { DropdownMenu } from '@/components/DropdownMenu'

export type ComposerSkill = {
  id: string
  name: string
  description: string
  source?: string
}

export type ComposerAddActions = {
  onUpload?: () => void
  onAddConnection?: () => void
  skills?: {
    items: readonly ComposerSkill[]
    onSelect: (skill: ComposerSkill) => void
  }
}

type ComposerAddMenuProps = ComposerAddActions & {
  anchorRef: RefObject<HTMLElement | null>
  /** Keep the popup's anchored corner at the button's original position. */
  inPlace?: boolean
}

/** The composer's action picker. Its callers supply capabilities; absent actions stay disabled. */
export const ComposerAddMenu = ({ anchorRef, inPlace, onUpload, onAddConnection, skills }: ComposerAddMenuProps) => (
  <DropdownMenu
    icon={<PlusIcon weight="bold" />}
    aria-label="Add to conversation"
    triggerClassName="size-[30px] text-kumo-subtle not-data-disabled:hover:text-kumo-default [&>svg]:size-3.5"
    triggerVariant="ghost"
    anchorRef={anchorRef}
    side="top"
    inPlace={inPlace}
  >
    <DropdownMenu.Item icon={PaperclipIcon} onSelect={onUpload} disabled={!onUpload}>
      <span>Upload files or photos</span>
    </DropdownMenu.Item>
    <DropdownMenu.Item icon={PlugIcon} onSelect={onAddConnection} disabled={!onAddConnection}>
      <span>Add a new connection</span>
    </DropdownMenu.Item>
    {skills && skills.items.length > 0 && (
      <>
        <DropdownMenu.Separator />
        {skills.items.map((skill) => (
          <DropdownMenu.Item key={skill.id} icon={ScrollIcon} label={skill.name} onSelect={() => skills.onSelect(skill)}>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{skill.name}</span>
              <span className="block truncate text-sm text-kumo-subtle">{skill.description}</span>
            </span>
            {skill.source && (
              <span className="max-w-[30%] truncate text-xs text-kumo-subtle">{skill.source}</span>
            )}
          </DropdownMenu.Item>
        ))}
      </>
    )}
  </DropdownMenu>
)
