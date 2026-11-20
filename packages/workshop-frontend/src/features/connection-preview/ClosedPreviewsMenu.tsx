import { DropdownMenu } from '@cloudflare/kumo'
import { FileMagnifyingGlass, FileText } from '@phosphor-icons/react'
import { MENU_CONTENT, MENU_ITEM, MENU_POSITIONER_STYLE } from '../../components/menuStyles'
import { WorkshopIconButton } from '../../components/WorkshopControls'
import { previewKey, type ConnectionPreview } from './connectionPreview'

type ClosedPreviewsMenuProps = {
  previews: ConnectionPreview[]
  onOpen: (preview: ConnectionPreview) => void
}

/**
 * Opens a preview that was closed while its connection has changes waiting: one button in the
 * header, however many there are, whose menu lists each under its connection's own icon.
 */
export const ClosedPreviewsMenu = ({ previews, onOpen }: ClosedPreviewsMenuProps) => previews.length > 0 && (
  <DropdownMenu>
    <DropdownMenu.Trigger
      render={(
        <WorkshopIconButton title="Previews" aria-label="Previews">
          <FileMagnifyingGlass size={16} />
        </WorkshopIconButton>
      )}
    />
    <DropdownMenu.Content className={`${MENU_CONTENT} max-h-[min(320px,var(--available-height))] max-w-[320px] overflow-y-auto`} style={MENU_POSITIONER_STYLE}>
      {previews.map(preview => (
        <DropdownMenu.Item
          key={previewKey(preview)}
          icon={preview.iconUrl
            ? <img src={preview.iconUrl} alt="" className="size-[15px]" />
            : <FileText size={15} />}
          onClick={() => onOpen(preview)}
          className={MENU_ITEM}
        >
          <span className="truncate">{preview.title}</span>
        </DropdownMenu.Item>
      ))}
    </DropdownMenu.Content>
  </DropdownMenu>
)
