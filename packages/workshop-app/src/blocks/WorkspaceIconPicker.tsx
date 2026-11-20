import { cn } from '@cloudflare/kumo/utils'
import { WORKSPACE_ICON_COLORS, WORKSPACE_ICON_SHAPES, type WorkspaceLook } from '@/prefs/preferenceFields'
import { DropdownMenu } from '@gadgets/ui'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { WORKSPACE_COLORS, WORKSPACE_SHAPES } from '@/components/workspaceLook'

export type WorkspaceIconPickerProps = {
  /** Two letters shown on the icon. */
  label: string
  /** How the icon is drawn now. */
  look?: WorkspaceLook
  onLookChange: (look: WorkspaceLook) => void
}

/**
 * A workspace's icon, which opens what it can be drawn as when clicked: the shapes, each as this
 * workspace's would be, and under them the colours. The icon stays where it is, beside the menu,
 * and the menu stays open, so that each choice is seen on it as it is made.
 */
export const WorkspaceIconPicker = ({ label, look, onLookChange }: WorkspaceIconPickerProps) => {
  const shape = look?.shape ?? WORKSPACE_ICON_SHAPES[0]
  const color = look?.color ?? WORKSPACE_ICON_COLORS[0]

  return (
    <DropdownMenu
      // In a span, so that it keeps its own size rather than taking the Button's size for an icon.
      icon={<span className="grid"><WorkspaceIcon label={label} shape={shape} color={color} /></span>}
      aria-label="Workspace icon"
      triggerVariant="ghost"
      // As a title that can be renamed is: a rounded surface when pointed at. Its room is taken
      // back out, so that the icon is where one that cannot be changed would be.
      triggerClassName="-m-1.5 h-auto w-auto rounded-xl p-1.5 not-data-disabled:hover:bg-kumo-contrast/5 data-popup-open:bg-kumo-contrast/5"
      keepTrigger
      align="center"
    >
      <DropdownMenu.Label>Icon</DropdownMenu.Label>
      <DropdownMenu.SwatchGroup value={shape} onValueChange={(next) => onLookChange({ shape: next, color })} aria-label="Icon">
        {WORKSPACE_ICON_SHAPES.map((id) => (
          <DropdownMenu.Swatch key={id} value={id} label={WORKSPACE_SHAPES[id]}>
            <WorkspaceIcon label={label} shape={id} color={color} />
          </DropdownMenu.Swatch>
        ))}
      </DropdownMenu.SwatchGroup>
      <DropdownMenu.Separator />
      <DropdownMenu.Label>Color</DropdownMenu.Label>
      <DropdownMenu.SwatchGroup value={color} onValueChange={(next) => onLookChange({ shape, color: next })} aria-label="Color">
        {WORKSPACE_ICON_COLORS.map((id) => (
          <DropdownMenu.Swatch key={id} value={id} label={WORKSPACE_COLORS[id].name}>
            <svg viewBox="0 0 24 24" aria-hidden="true" className={cn('size-6', WORKSPACE_COLORS[id].fill)}>
              <circle cx="12" cy="12" r="12" />
            </svg>
          </DropdownMenu.Swatch>
        ))}
      </DropdownMenu.SwatchGroup>
    </DropdownMenu>
  )
}
