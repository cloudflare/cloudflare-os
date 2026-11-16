import { cn } from '@cloudflare/kumo/utils'
import { DropdownMenu } from '@/components/DropdownMenu'
import { FormatIcon, GADGET_ICONS, type FormatIconName } from '@/components/FormatIcon'
import { WORKSPACE_COLORS, workspaceColors, type WorkspaceColor } from '@/components/workspaceLook'

export type GadgetIconPickerProps = {
  /** Its icon now; none, a gadget's window. */
  icon?: FormatIconName
  /** Its colour now; none, ink. */
  color?: WorkspaceColor
  /** Gives it another icon. Left out, only its colour can be chosen, as whoever only uses it may. */
  onIconChange?: (icon: FormatIconName) => void
  onColorChange: (color: WorkspaceColor) => void
}

/**
 * A gadget's mark, which opens what it can be drawn as when clicked, as a workspace's icon does
 * (`WorkspaceIconPicker`): the icons, each in its colour, and under them the colours. The mark stays
 * where it is, beside the menu, and the menu stays open, so that each choice is seen on it as it is
 * made.
 */
export const GadgetIconPicker = ({ icon = 'appWindow', color = 'contrast', onIconChange, onColorChange }: GadgetIconPickerProps) => (
  <DropdownMenu
    // In a span, so that it keeps its own size rather than taking the Button's size for an icon.
    icon={<span className="grid"><FormatIcon name={icon} color={color} className="size-8" /></span>}
    aria-label="Gadget icon"
    triggerVariant="ghost"
    // As the workspace's icon is: a rounded surface when pointed at, its room taken back out.
    triggerClassName="-m-1.5 h-auto w-auto rounded-xl p-1.5 not-data-disabled:hover:bg-kumo-contrast/5 data-popup-open:bg-kumo-contrast/5"
    keepTrigger
    align="center"
  >
    {onIconChange && (
      <>
        <DropdownMenu.Label>Icon</DropdownMenu.Label>
        <DropdownMenu.SwatchGroup value={icon} onValueChange={onIconChange} aria-label="Icon">
          {GADGET_ICONS.map(({ name, label }) => (
            <DropdownMenu.Swatch key={name} value={name} label={label}>
              <FormatIcon name={name} color={color} className="size-7" />
            </DropdownMenu.Swatch>
          ))}
        </DropdownMenu.SwatchGroup>
        <DropdownMenu.Separator />
      </>
    )}
    <DropdownMenu.Label>Color</DropdownMenu.Label>
    <DropdownMenu.SwatchGroup value={color} onValueChange={onColorChange} aria-label="Color">
      {workspaceColors.map((id) => (
        <DropdownMenu.Swatch key={id} value={id} label={WORKSPACE_COLORS[id].name}>
          <svg viewBox="0 0 24 24" aria-hidden="true" className={cn('size-6', WORKSPACE_COLORS[id].fill)}>
            <circle cx="12" cy="12" r="12" />
          </svg>
        </DropdownMenu.Swatch>
      ))}
    </DropdownMenu.SwatchGroup>
  </DropdownMenu>
)
